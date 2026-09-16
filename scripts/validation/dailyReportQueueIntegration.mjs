// Phase 4 validation - Section 10/31: real Redis + real BullMQ + a real
// worker processing daily-report-jobs (not just calling the pipeline
// function directly, as dailyReportE2E.mjs does).

import { generateDailyReportJob } from "../../apps/worker/dist/reportPipeline.js";
import { createDailyReportQueue, createDailyReportWorker, dailyReportJobId } from "../../packages/queue/dist/index.js";
import { createOrganizationWithOwner, createCompetitor, createMonitoredUrl, prisma } from "../../packages/db/dist/index.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function waitForEvent(emitter, event, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${event}'`)), timeoutMs);
    emitter.on(event, (...args) => {
      if (!predicate || predicate(...args)) {
        clearTimeout(timer);
        resolve(args);
      }
    });
  });
}

async function main() {
  const suffix = Date.now();
  const { organization: org } = await createOrganizationWithOwner({
    organizationName: `DailyReport Queue Validation ${suffix}`,
    email: `daily-report-queue-${suffix}@example.test`,
    passwordHash: "not-a-real-hash",
  });
  const competitor = await createCompetitor(org.id, { name: "Queue Test Competitor" });
  const monitoredUrl = await createMonitoredUrl(org.id, competitor.id, { url: `https://queue-test-${suffix}.example.test/`, category: "GENERAL" });

  // A real verified ChangeEvent for "today" (UTC), so the report has something to show.
  const job = await prisma.monitoringJob.create({ data: { organizationId: org.id, monitoredUrlId: monitoredUrl.id, status: "COMPLETED" } });
  const snapshot = await prisma.snapshot.create({
    data: {
      organizationId: org.id,
      monitoredUrlId: monitoredUrl.id,
      monitoringJobId: job.id,
      extractionMethod: "CHEERIO",
      verificationState: "CHANGED",
      normalizedContent: "content",
      confidence: 1,
    },
  });
  await prisma.changeEvent.create({
    data: {
      organizationId: org.id,
      monitoredUrlId: monitoredUrl.id,
      currentSnapshotId: snapshot.id,
      changeType: "CONTENT_CHANGE",
      severity: "LOW",
      confidence: 0.8,
      fieldPath: "page.visibleText",
      evidenceExcerpt: "evidence",
      detectedAt: new Date(),
    },
  });

  const reportDate = new Date().toISOString().slice(0, 10);
  const payload = { organizationId: org.id, reportDate, timezone: "UTC" };

  const processed = [];
  const failedEvents = [];
  const worker = createDailyReportWorker(async (bullJob) => {
    console.log(`[report-worker] processing job ${bullJob.id} (attempt ${bullJob.attemptsMade + 1})`);
    const result = await generateDailyReportJob(bullJob.data);
    processed.push({ jobId: bullJob.id, result });
    return result;
  });
  worker.on("failed", (bullJob, err) => {
    failedEvents.push({ jobId: bullJob?.id, message: err.message });
  });

  try {
    const queue = createDailyReportQueue();
    const jobId = dailyReportJobId(org.id, reportDate, "UTC");

    console.log("\n=== 1. Enqueue a real daily-report job via real Redis/BullMQ ===");
    await queue.add("daily-report", payload, { jobId });
    const [, completedResult] = await waitForEvent(worker, "completed", (bullJob) => bullJob.id === jobId);
    assert(completedResult.status === "COMPLETED", "the real worker processed the job and the report reached COMPLETED");
    assert(completedResult.changeCount === 1, "the real worker's report has exactly one verified change");

    console.log("\n=== 2. Stable job id: enqueuing the SAME (org, date, timezone) again resolves to the SAME BullMQ job ===");
    const beforeCount = processed.length;
    const duplicateJob = await queue.add("daily-report", payload, { jobId });
    // BullMQ resolves to the existing (already-completed) job under the same id rather than creating a new one -
    // it will not be reprocessed by the worker, so `processed` must not grow.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert(processed.length === beforeCount, "a duplicate enqueue for the same period does not cause a second worker execution");
    assert(duplicateJob.id === jobId, "the duplicate add() resolves to the same job id");

    await queue.close();
    console.log("\n=== Daily report queue integration validation complete ===");
  } finally {
    await worker.close();
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // BullMQ/ioredis can leave the event loop alive after close() - force exit rather than hang.
    process.exit(process.exitCode ?? 0);
  });
