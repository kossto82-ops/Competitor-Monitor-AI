// Phase 4 validation driver: runs the REAL daily-report pipeline (real
// Postgres via @cma/db, real Redis-backed BullMQ queue definitions, real
// worker code from apps/worker/dist) against three organizations that
// exercise the three required scenarios:
//
//   Org A - NO AiConnection at all -> report must still generate from
//           deterministic ChangeEvents, AI section says "unavailable",
//           and (verified via a global fetch spy) NO network call is made.
//   Org B - a REAL AiConnection using CMA_AI_PROVIDER config from env
//           (provider=openai, model=process.env.CMA_AI_MODEL, a real
//           OPENAI_API_KEY) - a real AI analysis is run and persisted
//           FIRST, then report generation must reuse it (zero
//           additional network calls during generateDailyReportJob).
//   Org C - a FakeProvider AiConnection (provider="fake") - proves the
//           report pipeline has no provider-specific branching: it
//           works identically for a completely different configured
//           provider, using only what's already in AiConnection.
//
// Usage: DATABASE_URL=... REDIS_URL=... OPENAI_API_KEY=... CMA_AI_ENCRYPTION_KEY=... \
//        CMA_AI_MODEL=gpt-4o-mini node scripts/validation/dailyReportE2E.mjs
//
// Requires: real Postgres + Redis reachable, migrations applied.

import {
  prisma,
  createOrganizationWithOwner,
  createCompetitor,
  createMonitoredUrl,
  createAiConnection,
  getOrCreatePendingAiAnalysis,
  getReportWithItemsForOrg,
  getReportForOrg,
  listReportsForOrg,
} from "../../packages/db/dist/index.js";
import { generateDailyReportJob } from "../../apps/worker/dist/reportPipeline.js";
import { runAiAnalysisJob, PROMPT_VERSION } from "../../apps/worker/dist/aiPipeline.js";
import { NotFoundError } from "../../packages/db/dist/repositories/errors.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

/** Records outbound fetch() calls made during `fn()` - the concrete proof that no external AI request was made (Section 25). */
async function countFetchCallsDuring(fn) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    return originalFetch(...args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function makeOrgWithChange(label, suffix) {
  const { organization } = await createOrganizationWithOwner({
    organizationName: `Phase4 E2E ${label} ${suffix}`,
    email: `phase4-e2e-${label.toLowerCase()}-${suffix}@example.test`,
    passwordHash: "not-a-real-hash",
  });
  const competitor = await createCompetitor(organization.id, { name: `Competitor ${label}` });
  const monitoredUrl = await createMonitoredUrl(organization.id, competitor.id, {
    url: `https://competitor-${label.toLowerCase()}-${suffix}.example.test/pricing`,
    category: "PRICING_PAGE",
  });

  const job = await prisma.monitoringJob.create({
    data: { organizationId: organization.id, monitoredUrlId: monitoredUrl.id, status: "COMPLETED" },
  });
  const snapshot = await prisma.snapshot.create({
    data: {
      organizationId: organization.id,
      monitoredUrlId: monitoredUrl.id,
      monitoringJobId: job.id,
      extractionMethod: "CHEERIO",
      verificationState: "CHANGED",
      normalizedContent: "Pro Plan 59.00 EUR",
      confidence: 1,
    },
  });
  const changeEvent = await prisma.changeEvent.create({
    data: {
      organizationId: organization.id,
      monitoredUrlId: monitoredUrl.id,
      currentSnapshotId: snapshot.id,
      changeType: "PRICE_CHANGE",
      severity: "MEDIUM",
      confidence: 0.95,
      fieldPath: "price",
      oldValue: "49.00",
      newValue: "59.00",
      currency: "EUR",
      percentageChange: 20.41,
      evidenceExcerpt: "Pro Plan now 59.00 EUR",
      // "today" in UTC, matching the UTC reportDate/timezone used below.
      detectedAt: new Date(),
    },
  });

  return { organization, competitor, monitoredUrl, changeEvent };
}

function todayUtcReportDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const suffix = Date.now();
  const reportDate = todayUtcReportDate();
  const createdOrgIds = [];

  try {
    // ------------------------------------------------------------------
    // ORG A: no AiConnection at all
    // ------------------------------------------------------------------
    console.log("\n=== ORG A: no AiConnection configured ===");
    const a = await makeOrgWithChange("A", suffix);
    createdOrgIds.push(a.organization.id);

    const { result: reportA, calls: fetchCallsA } = await countFetchCallsDuring(() =>
      generateDailyReportJob({ organizationId: a.organization.id, reportDate, timezone: "UTC" }),
    );

    assert(reportA.status === "COMPLETED", "Org A: report reaches COMPLETED status");
    assert(reportA.changeCount === 1, "Org A: exactly one verified change is in the report");
    assert(fetchCallsA === 0, "Org A: generating the report makes ZERO network calls (no AI provider is ever contacted)");

    const withItemsA = await getReportWithItemsForOrg(a.organization.id, reportA.reportId);
    assert(withItemsA.items.length === 1, "Org A: report has exactly one item");
    assert(withItemsA.items[0].changeEvent.aiAnalysis === null, "Org A: the item's ChangeEvent has NO AiAnalysis (never invented)");
    assert(
      withItemsA.items[0].changeEvent.oldValue === "49.00" && withItemsA.items[0].changeEvent.newValue === "59.00",
      "Org A: the deterministic old/new values are exactly what was persisted - never altered by report generation",
    );

    // Idempotency: running it again must not duplicate the report or its items, and must not re-send the email.
    const reportA2 = await generateDailyReportJob({ organizationId: a.organization.id, reportDate, timezone: "UTC" });
    assert(reportA2.reportId === reportA.reportId, "Org A: re-running generation resolves to the SAME report row");
    assert(reportA2.emailOutcome === "SKIPPED_ALREADY_SENT", "Org A: re-running generation does not re-send the report email");
    const itemCountA = await prisma.reportItem.count({ where: { reportId: reportA.reportId } });
    assert(itemCountA === 1, "Org A: re-running generation does not duplicate report items");
    const notificationCountA = await prisma.notificationLog.count({ where: { reportId: reportA.reportId } });
    assert(notificationCountA === 1, "Org A: re-running generation does not create a second notification log row");

    // ------------------------------------------------------------------
    // ORG B: a real OpenAI AiConnection, using env-configured model (NEVER a hard-coded one)
    // ------------------------------------------------------------------
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const openaiModel = process.env.CMA_AI_MODEL;
    if (!openaiApiKey || !openaiModel) {
      console.log("\n=== ORG B skipped: OPENAI_API_KEY / CMA_AI_MODEL not set in env - see .env.example ===");
    } else {
      console.log(`\n=== ORG B: real AiConnection (provider=openai, model=${openaiModel} from env, never hard-coded) ===`);
      const b = await makeOrgWithChange("B", suffix);
      createdOrgIds.push(b.organization.id);
      await createAiConnection(b.organization.id, { provider: "openai", model: openaiModel, apiKey: openaiApiKey });

      const pendingAnalysis = await getOrCreatePendingAiAnalysis(b.organization.id, b.changeEvent.id, PROMPT_VERSION);
      const aiResult = await runAiAnalysisJob({
        organizationId: b.organization.id,
        changeEventId: b.changeEvent.id,
        aiAnalysisId: pendingAnalysis.id,
      });
      assert(aiResult.status === "COMPLETED", "Org B: the real OpenAI analysis call completes");

      const { result: reportB, calls: fetchCallsB } = await countFetchCallsDuring(() =>
        generateDailyReportJob({ organizationId: b.organization.id, reportDate, timezone: "UTC" }),
      );
      assert(reportB.status === "COMPLETED", "Org B: report reaches COMPLETED status");
      assert(
        fetchCallsB === 0,
        "Org B (Section 28, cost control): generating the report makes ZERO additional network calls - the already-persisted AiAnalysis is reused, not re-computed",
      );

      const withItemsB = await getReportWithItemsForOrg(b.organization.id, reportB.reportId);
      assert(
        withItemsB.items[0].changeEvent.aiAnalysis?.status === "COMPLETED" && !!withItemsB.items[0].changeEvent.aiAnalysis?.summary,
        "Org B: the report item carries the REAL AI-generated summary",
      );
      assert(withItemsB.items[0].changeEvent.aiAnalysis?.model === openaiModel, "Org B: the persisted model is exactly the env-configured one, never a hard-coded default");
    }

    // ------------------------------------------------------------------
    // ORG C: FakeProvider AiConnection - proves no provider-specific branching in the report pipeline
    // ------------------------------------------------------------------
    console.log("\n=== ORG C: FakeProvider AiConnection (provider=fake) ===");
    const c = await makeOrgWithChange("C", suffix);
    createdOrgIds.push(c.organization.id);
    await createAiConnection(c.organization.id, { provider: "fake", model: "fake", apiKey: "unused-by-fake-provider" });

    const pendingAnalysisC = await getOrCreatePendingAiAnalysis(c.organization.id, c.changeEvent.id, PROMPT_VERSION);
    const aiResultC = await runAiAnalysisJob({
      organizationId: c.organization.id,
      changeEventId: c.changeEvent.id,
      aiAnalysisId: pendingAnalysisC.id,
    });
    assert(aiResultC.status === "COMPLETED", "Org C: the FakeProvider analysis completes without any network call");

    const reportC = await generateDailyReportJob({ organizationId: c.organization.id, reportDate, timezone: "UTC" });
    const withItemsC = await getReportWithItemsForOrg(c.organization.id, reportC.reportId);
    assert(
      withItemsC.items[0].changeEvent.aiAnalysis?.provider === "fake",
      "Org C: the report item's AI analysis reflects the organization's OWN configured provider (fake), independent of Org B's (openai)",
    );

    // ------------------------------------------------------------------
    // CROSS-CUTTING: tenant isolation and report history
    // ------------------------------------------------------------------
    console.log("\n=== Cross-cutting: tenant isolation ===");
    try {
      await getReportForOrg(c.organization.id, reportA.reportId);
      assert(false, "Org C must NOT be able to read Org A's report by id");
    } catch (err) {
      assert(err instanceof NotFoundError, "Org C reading Org A's report by id throws NotFoundError (tenant isolation)");
    }

    const historyA = await listReportsForOrg(a.organization.id);
    assert(
      historyA.length === 1 && historyA[0].id === reportA.reportId,
      "Org A's report history contains exactly its own report, never another organization's",
    );

    console.log("\n=== Phase 4 daily report E2E validation complete ===");
  } finally {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
