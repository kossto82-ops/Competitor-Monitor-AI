// Phase 1 validation - Section 8: real Redis + real BullMQ, real worker.

import { runMonitoringJob } from "../../apps/worker/dist/pipeline.js";
import { createMonitoringQueue, createMonitoringWorker, monitoringJobId } from "../../packages/queue/dist/index.js";
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
    organizationName: `Queue Validation ${suffix}`,
    email: `queue-${suffix}@example.test`,
    passwordHash: "not-a-real-hash",
  });
  const competitor = await createCompetitor(org.id, { name: "Queue Test Competitor" });
  const monitoredUrl = await createMonitoredUrl(org.id, competitor.id, {
    url: "http://127.0.0.1:4100/site/queue/product",
    category: "GENERAL",
  });

  const processed = [];
  const failedEvents = [];
  const worker = createMonitoringWorker(async (job) => {
    console.log(`[worker] processing job ${job.id} (attempt ${job.attemptsMade + 1})`);
    const result = await runMonitoringJob(job.data);
    processed.push({ jobId: job.id, result });
    return result;
  });
  worker.on("failed", (job, err) => {
    failedEvents.push({ jobId: job?.id, attemptsMade: job?.attemptsMade, message: err.message });
    console.log(`[worker] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });

  const queue = createMonitoringQueue();

  console.log("\n=== 1. Enqueue a real job, real worker processes it, real DB write happens ===");
  const jobId1 = monitoringJobId(monitoredUrl.id);
  const enqueued = await queue.add("monitor", { organizationId: org.id, monitoredUrlId: monitoredUrl.id }, { jobId: jobId1 });
  assert(!!enqueued.id, `job enqueued with id ${enqueued.id}`);

  const [completedJob] = await waitForEvent(worker, "completed", (j) => j.id === jobId1);
  assert(completedJob.id === jobId1, "worker emitted 'completed' for the enqueued job");
  assert(processed.some((p) => p.jobId === jobId1), "the job processor function actually ran for this job");

  const jobRow = await prisma.monitoringJob.findFirst({ where: { monitoredUrlId: monitoredUrl.id }, orderBy: { createdAt: "desc" } });
  assert(!!jobRow, "a real MonitoringJob row exists in Postgres");
  assert(jobRow.status === "COMPLETED", `MonitoringJob status is COMPLETED (got ${jobRow?.status})`);
  const usageRow = await prisma.usageRecord.findFirst({ where: { monitoringJobId: jobRow.id } });
  assert(!!usageRow, "a UsageRecord row was written for this real job");

  console.log("\n=== 2. Duplicate job ID behavior ===");
  const beforeCount = await queue.getJobCountByTypes("completed", "active", "waiting", "delayed");
  const dup = await queue.add("monitor", { organizationId: org.id, monitoredUrlId: monitoredUrl.id }, { jobId: jobId1 });
  assert(dup.id === jobId1, "re-adding the same jobId returns the SAME job id (BullMQ de-dupes), not a new one");
  const afterCount = await queue.getJobCountByTypes("completed", "active", "waiting", "delayed");
  assert(afterCount === beforeCount, `duplicate add did not increase queue job count (${beforeCount} -> ${afterCount})`);

  console.log("\n=== 3. Failed job + retry behavior (unknown monitoredUrlId forces an error) ===");
  const badJobId = `monitor-bad-${suffix}`;
  await queue.add(
    "monitor",
    { organizationId: org.id, monitoredUrlId: "does-not-exist" },
    { jobId: badJobId, attempts: 3, backoff: { type: "fixed", delay: 500 } },
  );

  // Wait for it to fail 3 times (final failure = attemptsMade reaches 3).
  await new Promise((resolve) => {
    const check = setInterval(() => {
      const finalFailure = failedEvents.find((f) => f.jobId === badJobId && f.attemptsMade === 3);
      if (finalFailure) {
        clearInterval(check);
        resolve();
      }
    }, 300);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 15000);
  });

  const attemptsForBadJob = failedEvents.filter((f) => f.jobId === badJobId).map((f) => f.attemptsMade);
  console.log("attemptsForBadJob:", attemptsForBadJob);
  assert(attemptsForBadJob.length >= 1, "the bad job emitted at least one 'failed' event");
  assert(attemptsForBadJob.includes(3), `the bad job was retried up to its configured attempts (3) - saw attempts: ${attemptsForBadJob.join(",")}`);
  assert(
    failedEvents.some((f) => f.jobId === badJobId && f.message.includes("not found")),
    "failure reason is the real NotFoundError from getMonitoredUrlForOrg, not a generic error",
  );

  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  console.log("\nDONE");
}

main().catch((err) => {
  console.error("VALIDATION SCRIPT CRASHED:", err);
  process.exit(1);
});
