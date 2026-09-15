import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Queue, Worker, type Job } from "bullmq";
import { monitoringJobId } from "./monitoringQueue.js";

/**
 * Phase 2.1 hardening (Section 1: cron/enqueueAll job-id semantics).
 *
 * This suite requires a real Redis reachable via REDIS_URL (default
 * redis://127.0.0.1:6379). Like packages/db's tenantIsolation.test.ts,
 * it is skipped rather than failed when Redis is unreachable, so
 * `npm test` stays green without local infra - but a skip here is NOT
 * proof of the cron-path's job-id behavior, only an unexecuted
 * assertion. Start Redis and set REDIS_URL before relying on this
 * suite as a real gate.
 *
 * Deliberately uses its own queue name (NOT MONITORING_QUEUE_NAME) so
 * this never competes with a real `apps/worker` process that may also
 * be running against the same Redis instance during manual testing -
 * the job-id bucketing/dedup behavior under test is a property of
 * BullMQ job ids in general, not of any specific queue name.
 */
const TEST_QUEUE_NAME = "cma-hardening-enqueueall-jobid-test";

async function redisIsReachable(url: string): Promise<boolean> {
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 1500 });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const reachable = await redisIsReachable(REDIS_URL);

/** Resolves the next time `worker` completes a job matching `predicate`. */
function waitForCompletedJob(worker: Worker, predicate: (job: Job) => boolean, timeoutMs = 15_000): Promise<Job> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for 'completed'")), timeoutMs);
    worker.on("completed", (job) => {
      if (predicate(job)) {
        clearTimeout(timer);
        resolve(job);
      }
    });
  });
}

describe.skipIf(!reachable)("cron-style enqueueAll job-id bucketing (real Redis, real BullMQ)", () => {
  let queue: Queue;
  let worker: Worker;
  const processed: string[] = [];

  beforeAll(() => {
    queue = new Queue(TEST_QUEUE_NAME, { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });
    worker = new Worker(
      TEST_QUEUE_NAME,
      async (job: Job) => {
        processed.push(job.id ?? "");
        return { ok: true };
      },
      { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 5 },
    );
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it(
    "1-3: a URL with no existing job gets enqueued and the worker actually processes it",
    async () => {
      const urlId = `url-fresh-${Date.now()}`;
      const jobId = monitoringJobId(urlId, 50);
      const enqueued = await queue.add("monitor", { monitoredUrlId: urlId }, { jobId });

      expect(enqueued.id).toBe(jobId);
      const completedJob = await waitForCompletedJob(worker, (j) => j.id === jobId);
      expect(completedJob.id).toBe(jobId);
      expect(processed).toContain(jobId);
    },
    20_000,
  );

  it(
    "4-7: once that job completes, the SAME URL becomes eligible for a genuinely later scan once the bucket rolls over - the second enqueue gets a fresh id and actually executes, not the stale completed job",
    async () => {
      const urlId = `url-later-scan-${Date.now()}`;
      const bucketMs = 50;

      // First scan.
      const firstJobId = monitoringJobId(urlId, bucketMs);
      await queue.add("monitor", { monitoredUrlId: urlId }, { jobId: firstJobId });
      await waitForCompletedJob(worker, (j) => j.id === firstJobId);

      // Let enough real time pass to cross into a new bucket - this is
      // exactly what happens between two real enqueueAll cron runs a
      // few minutes apart in production; bucketMs is shrunk here only
      // so the test doesn't have to sleep for a real 60 seconds.
      await new Promise((resolve) => setTimeout(resolve, bucketMs * 2));

      const secondJobId = monitoringJobId(urlId, bucketMs);
      expect(secondJobId).not.toBe(firstJobId);

      const secondAdd = await queue.add("monitor", { monitoredUrlId: urlId }, { jobId: secondJobId });
      // This is the exact failure mode Bug #1 (manual-scan path, Phase
      // 2 report) exhibited: queue.add() silently returning the OLD,
      // already-completed job's id instead of genuinely creating a new
      // one. For the cron path this must not happen once the bucket has
      // rolled over.
      expect(secondAdd.id).toBe(secondJobId);

      const completedJob = await waitForCompletedJob(worker, (j) => j.id === secondJobId);
      expect(completedJob.id).toBe(secondJobId);
      expect(processed).toContain(secondJobId);
      expect(processed.filter((id) => id === secondJobId)).toHaveLength(1);
    },
    20_000,
  );

  it(
    "intended dedup: two near-simultaneous enqueues of the same URL within one bucket collapse into a single real job, not duplicate work",
    async () => {
      const urlId = `url-dedup-${Date.now()}`;
      const bucketMs = 60_000; // production-sized bucket - both calls below land in the same one.
      const jobId = monitoringJobId(urlId, bucketMs);

      const [first, second] = await Promise.all([
        queue.add("monitor", { monitoredUrlId: urlId }, { jobId }),
        queue.add("monitor", { monitoredUrlId: urlId }, { jobId }),
      ]);

      expect(first.id).toBe(jobId);
      expect(second.id).toBe(jobId);

      await waitForCompletedJob(worker, (j) => j.id === jobId);
      // Give BullMQ a moment in case a duplicate job were (incorrectly)
      // queued behind the first - there should never be a second
      // 'completed' event for this id.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(processed.filter((id) => id === jobId)).toHaveLength(1);
    },
    20_000,
  );
});
