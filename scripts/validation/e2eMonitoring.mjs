// Phase 1 validation driver: runs the REAL pipeline (real @cma/db, real
// CheerioExtractor via safeGet) against the local fixture server. No fakes.
//
// Usage: node scripts/validation/e2eMonitoring.mjs
//
// Requires: DATABASE_URL set, fixture server running on 127.0.0.1:4100,
// NODE_ENV=development and CMA_ALLOW_PRIVATE_TARGETS=true so safeGet is
// permitted to reach the loopback fixture server (see packages/security's
// privateTargetsAllowedForTesting()).

import { runMonitoringJob } from "../../apps/worker/dist/pipeline.js";
import {
  createOrganizationWithOwner,
  createCompetitor,
  createMonitoredUrl,
  getLatestVerifiedSnapshot,
  listChangeEventsForOrg,
  prisma,
} from "../../packages/db/dist/index.js";

const FIXTURE_URL = "http://127.0.0.1:4100/product";

async function setFixtureState(state) {
  const res = await fetch("http://127.0.0.1:4100/admin/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`Failed to set fixture state: ${res.status}`);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function main() {
  const suffix = Date.now();

  console.log("\n=== SETUP: two organizations for isolation checks later ===");
  const { organization: orgA, user: userA } = await createOrganizationWithOwner({
    organizationName: `Validation Org A ${suffix}`,
    email: `orgA-${suffix}@example.test`,
    passwordHash: "not-a-real-hash",
  });
  console.log(`Org A: ${orgA.id} (user ${userA.id})`);

  const competitorA = await createCompetitor(orgA.id, { name: "Example Competitor" });
  const monitoredUrlA = await createMonitoredUrl(orgA.id, competitorA.id, {
    url: FIXTURE_URL,
    category: "PRICING_PAGE",
  });
  console.log(`Competitor A: ${competitorA.id}, MonitoredUrl A: ${monitoredUrlA.id}`);

  // --- 4. REAL END-TO-END MONITORING TEST (baseline) ---
  console.log("\n=== 4. Baseline monitoring run (Example Pro, EUR 49.00) ===");
  await setFixtureState({ mode: "normal", productName: "Example Pro", price: "49.00", currency: "EUR", availability: "Available" });

  const run1 = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: monitoredUrlA.id });
  console.log("run1:", run1);
  assert(run1.verificationState === "NO_CHANGE", "baseline run reports NO_CHANGE (first snapshot)");
  assert(run1.changeEventCount === 0, "baseline run has zero change events");

  const snap1 = await getLatestVerifiedSnapshot(monitoredUrlA.id);
  assert(!!snap1, "a real Snapshot row was created for the baseline run");
  assert(snap1.extractionMethod === "CHEERIO", "snapshot recorded extractionMethod=CHEERIO");
  assert(snap1.extractedEntities.some((e) => e.value === "49.00" && e.currency === "EUR"), "snapshot's extracted entity has price 49.00 EUR");

  // --- 5. REAL CHANGE DETECTION (price change) ---
  console.log("\n=== 5. Price change 49 -> 39 ===");
  await setFixtureState({ price: "39.00" });
  const run2 = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: monitoredUrlA.id });
  console.log("run2:", run2);
  assert(run2.verificationState === "CHANGED", "price-change run reports CHANGED");
  assert(run2.changeEventCount === 1, "exactly one change event for the price change");

  const snap2 = await getLatestVerifiedSnapshot(monitoredUrlA.id);
  assert(snap2.id !== snap1.id, "a NEW snapshot row was created (previous snapshot id still resolvable separately)");
  const stillThere = await prisma.snapshot.findUnique({ where: { id: snap1.id } });
  assert(!!stillThere, "the PREVIOUS snapshot row still exists in the database (not overwritten/deleted)");

  const changeEvents = await listChangeEventsForOrg(orgA.id, { monitoredUrlId: monitoredUrlA.id });
  const priceEvent = changeEvents.find((e) => e.changeType === "PRICE_CHANGE");
  assert(!!priceEvent, "a PRICE_CHANGE ChangeEvent exists");
  assert(priceEvent.oldValue === "49.00", `old value is 49.00 (got ${priceEvent?.oldValue})`);
  assert(priceEvent.newValue === "39.00", `new value is 39.00 (got ${priceEvent?.newValue})`);
  const expectedPct = ((39 - 49) / 49) * 100;
  assert(
    Math.abs(priceEvent.percentageChange - expectedPct) < 0.01,
    `percentage change is correct (${priceEvent?.percentageChange} ~= ${expectedPct.toFixed(2)})`,
  );
  assert(priceEvent.evidenceExcerpt && priceEvent.evidenceExcerpt.length > 0, "evidence excerpt is populated");
  assert(priceEvent.organizationId === orgA.id, "ChangeEvent tenant ownership is correct (organizationId = Org A)");
  assert(priceEvent.currentSnapshotId === snap2.id, "ChangeEvent.currentSnapshotId points at the new snapshot");
  assert(priceEvent.previousSnapshotId === snap1.id, "ChangeEvent.previousSnapshotId points at the baseline snapshot");

  // --- 5.9 Duplicate execution without another change ---
  console.log("\n=== 5.9 Re-run without further changes - must NOT duplicate the change event ===");
  const changeEventCountBefore = (await listChangeEventsForOrg(orgA.id, { monitoredUrlId: monitoredUrlA.id })).length;
  const run3 = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: monitoredUrlA.id });
  console.log("run3:", run3);
  assert(run3.verificationState === "NO_CHANGE", "re-run with no further site change reports NO_CHANGE");
  assert(run3.changeEventCount === 0, "re-run produces zero NEW change events");
  const changeEventCountAfter = (await listChangeEventsForOrg(orgA.id, { monitoredUrlId: monitoredUrlA.id })).length;
  assert(changeEventCountAfter === changeEventCountBefore, "total change-event count in DB is unchanged (no duplicate row)");

  // --- 6. FAILED VERIFICATION cases ---
  console.log("\n=== 6. Failed verification: 403 ===");
  await setFixtureState({ mode: "403" });
  const run403 = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: monitoredUrlA.id });
  console.log("run403:", run403);
  assert(run403.verificationState === "FAILED_TO_VERIFY", "HTTP 403 -> FAILED_TO_VERIFY");
  assert(run403.changeEventCount === 0, "HTTP 403 produces zero change events (never PRODUCT_REMOVED)");

  console.log("\n=== 6. Failed verification: 429 ===");
  await setFixtureState({ mode: "429" });
  const run429 = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: monitoredUrlA.id });
  console.log("run429:", run429);
  assert(run429.verificationState === "FAILED_TO_VERIFY", "HTTP 429 -> FAILED_TO_VERIFY");
  assert(run429.changeEventCount === 0, "HTTP 429 produces zero change events");

  console.log("\n=== 6. Failed verification: malformed/empty response ===");
  await setFixtureState({ mode: "malformed" });
  const runMalformed = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: monitoredUrlA.id });
  console.log("runMalformed:", runMalformed);
  assert(runMalformed.verificationState === "FAILED_TO_VERIFY", "malformed/empty response -> FAILED_TO_VERIFY");
  assert(runMalformed.changeEventCount === 0, "malformed response produces zero change events");

  console.log("\n=== 6. Failed verification: connection failure (server temporarily down) ===");
  // Point at a port nothing listens on to simulate ECONNREFUSED.
  const deadUrl = await createMonitoredUrl(orgA.id, competitorA.id, { url: "http://127.0.0.1:4999/product", category: "GENERAL" });
  const runConnFail = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: deadUrl.id });
  console.log("runConnFail:", runConnFail);
  assert(runConnFail.verificationState === "FAILED_TO_VERIFY", "connection failure -> FAILED_TO_VERIFY");
  assert(runConnFail.changeEventCount === 0, "connection failure produces zero change events");

  console.log("\n=== 6. Failed verification: timeout (server never responds; ~15s default timeout) ===");
  await setFixtureState({ mode: "timeout" });
  const timeoutStart = Date.now();
  const runTimeout = await runMonitoringJob({ organizationId: orgA.id, monitoredUrlId: monitoredUrlA.id });
  console.log(`runTimeout (took ${Date.now() - timeoutStart}ms):`, runTimeout);
  assert(runTimeout.verificationState === "FAILED_TO_VERIFY", "request timeout -> FAILED_TO_VERIFY");
  assert(runTimeout.changeEventCount === 0, "timeout produces zero change events");

  // Verify NONE of the failure runs ever produced a PRODUCT_REMOVED/PRICE_CHANGE etc.
  const allEvents = await listChangeEventsForOrg(orgA.id, { monitoredUrlId: monitoredUrlA.id });
  const badTypes = allEvents.filter((e) => e.changeType === "PRODUCT_REMOVED");
  assert(badTypes.length === 0, "no PRODUCT_REMOVED event was EVER created by a failed fetch across this whole run");

  // Restore fixture back to a normal, known state for anything downstream.
  await setFixtureState({ mode: "normal", price: "39.00" });

  console.log("\n=== DONE ===");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("VALIDATION SCRIPT CRASHED:", err);
  process.exit(1);
});
