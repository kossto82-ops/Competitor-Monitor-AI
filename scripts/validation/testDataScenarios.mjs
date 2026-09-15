// Phase 1 validation - Section 10 required fixtures (Competitor B/C/D/E),
// run through the REAL pipeline against the multi-site fixture server.

import { runMonitoringJob } from "../../apps/worker/dist/pipeline.js";
import { createOrganizationWithOwner, createCompetitor, createMonitoredUrl, listChangeEventsForOrg } from "../../packages/db/dist/index.js";

const BASE = "http://127.0.0.1:4100/site";

async function setState(key, body) {
  const res = await fetch(`${BASE}/${key}/admin/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`setState(${key}) failed: ${res.status}`);
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
  const { organization: org } = await createOrganizationWithOwner({
    organizationName: `Test Data Scenarios ${suffix}`,
    email: `testdata-${suffix}@example.test`,
    passwordHash: "not-a-real-hash",
  });
  console.log(`Org: ${org.id}`);

  // --- Competitor B: PRODUCT_ADDED ---
  console.log("\n=== Competitor B: Product A -> Product A + Product B => PRODUCT_ADDED ===");
  const compB = await createCompetitor(org.id, { name: "Competitor B" });
  const urlB = await createMonitoredUrl(org.id, compB.id, { url: `${BASE}/b/product`, category: "PRODUCT_PAGE" });
  await setState("b", { mode: "normal", products: [{ name: "Product A", price: "10.00", currency: "EUR", availability: "Available" }] });
  const b1 = await runMonitoringJob({ organizationId: org.id, monitoredUrlId: urlB.id });
  assert(b1.verificationState === "NO_CHANGE", "Competitor B baseline (Product A only) is NO_CHANGE");

  await setState("b", {
    products: [
      { name: "Product A", price: "10.00", currency: "EUR", availability: "Available" },
      { name: "Product B", price: "20.00", currency: "EUR", availability: "Available" },
    ],
  });
  const b2 = await runMonitoringJob({ organizationId: org.id, monitoredUrlId: urlB.id });
  console.log("b2:", b2);
  assert(b2.verificationState === "CHANGED", "Competitor B second run is CHANGED");
  const bEvents = await listChangeEventsForOrg(org.id, { monitoredUrlId: urlB.id });
  const added = bEvents.find((e) => e.changeType === "PRODUCT_ADDED");
  assert(!!added, "PRODUCT_ADDED change event exists for Competitor B");
  assert(added?.newValue === "20.00", `added product's new value is 20.00 (got ${added?.newValue})`);

  // --- Competitor C: PRODUCT_REMOVED ---
  console.log("\n=== Competitor C: Product A + Product B -> Product A => PRODUCT_REMOVED ===");
  const compC = await createCompetitor(org.id, { name: "Competitor C" });
  const urlC = await createMonitoredUrl(org.id, compC.id, { url: `${BASE}/c/product`, category: "PRODUCT_PAGE" });
  await setState("c", {
    mode: "normal",
    products: [
      { name: "Product A", price: "10.00", currency: "EUR", availability: "Available" },
      { name: "Product B", price: "20.00", currency: "EUR", availability: "Available" },
    ],
  });
  const c1 = await runMonitoringJob({ organizationId: org.id, monitoredUrlId: urlC.id });
  assert(c1.verificationState === "NO_CHANGE", "Competitor C baseline (A+B) is NO_CHANGE");

  await setState("c", { products: [{ name: "Product A", price: "10.00", currency: "EUR", availability: "Available" }] });
  const c2 = await runMonitoringJob({ organizationId: org.id, monitoredUrlId: urlC.id });
  console.log("c2:", c2);
  assert(c2.verificationState === "CHANGED", "Competitor C second run is CHANGED");
  const cEvents = await listChangeEventsForOrg(org.id, { monitoredUrlId: urlC.id });
  const removed = cEvents.find((e) => e.changeType === "PRODUCT_REMOVED");
  assert(!!removed, "PRODUCT_REMOVED change event exists for Competitor C");
  assert(removed?.oldValue === "20.00", `removed product's old value is 20.00 (got ${removed?.oldValue})`);

  // --- Competitor D: NO_CHANGE (same content twice) ---
  console.log("\n=== Competitor D: identical content twice => NO_CHANGE both times ===");
  const compD = await createCompetitor(org.id, { name: "Competitor D" });
  const urlD = await createMonitoredUrl(org.id, compD.id, { url: `${BASE}/d/product`, category: "GENERAL" });
  await setState("d", { mode: "normal", products: [{ name: "Static Product", price: "15.00", currency: "EUR", availability: "Available" }] });
  const d1 = await runMonitoringJob({ organizationId: org.id, monitoredUrlId: urlD.id });
  const d2 = await runMonitoringJob({ organizationId: org.id, monitoredUrlId: urlD.id });
  console.log("d1:", d1, "d2:", d2);
  assert(d1.verificationState === "NO_CHANGE", "Competitor D first run is NO_CHANGE (baseline)");
  assert(d2.verificationState === "NO_CHANGE", "Competitor D second identical run is NO_CHANGE");
  assert(d2.changeEventCount === 0, "Competitor D produces zero change events");

  // --- Competitor E: HTTP 403 => FAILED_TO_VERIFY ---
  console.log("\n=== Competitor E: returns HTTP 403 => FAILED_TO_VERIFY ===");
  const compE = await createCompetitor(org.id, { name: "Competitor E" });
  const urlE = await createMonitoredUrl(org.id, compE.id, { url: `${BASE}/e/product`, category: "GENERAL" });
  await setState("e", { mode: "403" });
  const e1 = await runMonitoringJob({ organizationId: org.id, monitoredUrlId: urlE.id });
  console.log("e1:", e1);
  assert(e1.verificationState === "FAILED_TO_VERIFY", "Competitor E is FAILED_TO_VERIFY");
  assert(e1.changeEventCount === 0, "Competitor E produces zero change events");

  console.log("\n=== DONE ===");
}

main().catch((err) => {
  console.error("VALIDATION SCRIPT CRASHED:", err);
  process.exit(1);
});
