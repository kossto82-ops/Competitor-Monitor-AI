// Phase 2.1 hardening - Section 5: a small real concurrency check.
//
// Not a load test - the goal is to catch obvious race conditions
// involving MonitoringJob creation, BullMQ enqueue, snapshot creation,
// ChangeEvent creation, and status transitions when several scans run
// at the same time against the real stack (real Postgres, real Redis,
// a real worker running the real pipeline).
//
// Scenario: 2 organizations, org A with 3 monitored URLs and org B with
// 2, all 5 scans triggered concurrently (mirroring the real
// POST /scan route: a PENDING MonitoringJob row created first, then
// enqueued under that row's own id - see apps/web's scan route and the
// Phase 2 report's Bug #1 for why that matters). Requires the fixture
// server at http://127.0.0.1:4100 (scripts/validation/fixtureServer.mjs)
// and CMA_ALLOW_PRIVATE_TARGETS=true (the fixture server is loopback).
//
// Deliberately uses its own BullMQ queue name (NOT the real
// "monitoring-jobs" queue via createMonitoringQueue/createMonitoringWorker)
// so this never races against a real apps/worker process that happens to
// be running against the same Redis during manual testing. The first
// version of this script used the shared queue and got 3/5 jobs
// "FAILED" with an SSRF-blocked error - not a product bug, but this
// script's own worker racing a separately-running real worker process
// that had CMA_ALLOW_PRIVATE_TARGETS set differently. Lesson kept here
// so it isn't rediscovered the hard way again.
import { Redis } from "ioredis";
import { Queue, Worker } from "bullmq";
import { runMonitoringJob } from "../../apps/worker/dist/pipeline.js";
import {
  createOrganizationWithOwner,
  createCompetitor,
  createMonitoredUrl,
  createPendingMonitoringJob,
  prisma,
} from "../../packages/db/dist/index.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const TEST_QUEUE_NAME = "cma-hardening-concurrency-check";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function pollUntilTerminal(jobId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await prisma.monitoringJob.findUnique({ where: { id: jobId } });
    if (job && (job.status === "COMPLETED" || job.status === "FAILED")) return job;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for job ${jobId} to reach a terminal state (last seen: ${job?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main() {
  const suffix = Date.now();

  console.log("\n=== Setup: 2 orgs, 5 monitored URLs total (3 + 2) ===");
  const { organization: orgA } = await createOrganizationWithOwner({
    organizationName: `Concurrency A ${suffix}`,
    email: `concurrency-a-${suffix}@example.test`,
    passwordHash: "not-a-real-hash",
  });
  const { organization: orgB } = await createOrganizationWithOwner({
    organizationName: `Concurrency B ${suffix}`,
    email: `concurrency-b-${suffix}@example.test`,
    passwordHash: "not-a-real-hash",
  });
  const compA = await createCompetitor(orgA.id, { name: "Competitor A" });
  const compB = await createCompetitor(orgB.id, { name: "Competitor B" });

  const urlsA = await Promise.all(
    [0, 1, 2].map((i) =>
      createMonitoredUrl(orgA.id, compA.id, {
        url: `http://127.0.0.1:4100/site/concurrency-a${i}-${suffix}/product`,
        category: "GENERAL",
      }),
    ),
  );
  const urlsB = await Promise.all(
    [0, 1].map((i) =>
      createMonitoredUrl(orgB.id, compB.id, {
        url: `http://127.0.0.1:4100/site/concurrency-b${i}-${suffix}/product`,
        category: "GENERAL",
      }),
    ),
  );
  const allTargets = [
    ...urlsA.map((u) => ({ org: orgA, url: u })),
    ...urlsB.map((u) => ({ org: orgB, url: u })),
  ];
  assert(allTargets.length === 5, `5 monitored URLs created across 2 organizations (got ${allTargets.length})`);

  console.log("\n=== Real worker (concurrency=5) processing runMonitoringJob for real, on an isolated test queue ===");
  const processedJobIds = [];
  const worker = new Worker(
    TEST_QUEUE_NAME,
    async (job) => {
      const startedAt = Date.now();
      const result = await runMonitoringJob(job.data);
      processedJobIds.push({ jobId: job.id, monitoringJobId: result.monitoringJobId, startedAt, endedAt: Date.now() });
      return result;
    },
    { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 5 },
  );
  const failedEvents = [];
  worker.on("failed", (job, err) => failedEvents.push({ jobId: job?.id, message: err.message }));

  console.log("\n=== Trigger all 5 scans concurrently, mirroring POST /scan: create PENDING row, then enqueue under its own id ===");
  const queue = new Queue(TEST_QUEUE_NAME, { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });
  const triggerScan = async ({ org, url }) => {
    const pendingJob = await createPendingMonitoringJob(org.id, url.id);
    await queue.add(
      "monitor",
      { organizationId: org.id, monitoredUrlId: url.id, monitoringJobId: pendingJob.id },
      { jobId: pendingJob.id },
    );
    return { org, url, pendingJobId: pendingJob.id };
  };

  const triggered = await Promise.all(allTargets.map(triggerScan));
  assert(new Set(triggered.map((t) => t.pendingJobId)).size === 5, "all 5 PENDING MonitoringJob rows have distinct ids (no id collision under concurrency)");

  console.log("\n=== Wait for all 5 jobs to reach a terminal state ===");
  const finalJobs = await Promise.all(triggered.map((t) => pollUntilTerminal(t.pendingJobId)));

  assert(finalJobs.every((j) => j.status === "COMPLETED"), `all 5 jobs reached COMPLETED (statuses: ${finalJobs.map((j) => j.status).join(", ")})`);
  assert(failedEvents.length === 0, `no unexpected worker 'failed' events (saw ${failedEvents.length}: ${JSON.stringify(failedEvents)})`);

  console.log("\n=== Verify no cross-URL / cross-org data mixing under concurrency ===");
  for (const t of triggered) {
    const snapshot = await prisma.snapshot.findUnique({ where: { monitoringJobId: t.pendingJobId } });
    assert(!!snapshot, `job ${t.pendingJobId} has exactly one Snapshot`);
    assert(snapshot.monitoredUrlId === t.url.id, `job ${t.pendingJobId}'s Snapshot points at the correct MonitoredUrl (${t.url.id}), not a different concurrently-scanned one`);
    assert(snapshot.organizationId === t.org.id, `job ${t.pendingJobId}'s Snapshot carries the correct organizationId (${t.org.id}), not another org's`);
  }

  // Baseline scans (no prior snapshot) should never produce a ChangeEvent.
  const changeEventCount = await prisma.changeEvent.count({
    where: { monitoredUrlId: { in: allTargets.map((t) => t.url.id) } },
  });
  assert(changeEventCount === 0, `no spurious ChangeEvents were created for these first-ever (baseline) scans (found ${changeEventCount})`);

  console.log("\n=== Verify overlap actually happened (this was concurrent, not accidentally serialized) ===");
  const windows = processedJobIds.map((p) => [p.startedAt, p.endedAt]);
  const anyOverlap = windows.some(([aStart, aEnd], i) =>
    windows.some(([bStart, bEnd], j) => i !== j && aStart < bEnd && bStart < aEnd),
  );
  assert(anyOverlap, "at least two of the 5 job executions had overlapping start/end windows (genuinely concurrent, not serialized one-at-a-time)");

  await worker.close();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await prisma.$disconnect();
  console.log("\nDONE");
}

main().catch((err) => {
  console.error("CONCURRENCY CHECK CRASHED:", err);
  process.exit(1);
});
