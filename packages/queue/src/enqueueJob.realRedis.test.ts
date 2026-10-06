import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Queue, Worker, type Job } from "bullmq";
import { addJobReplacingTerminal } from "./enqueueJob.js";

/**
 * Regression test for the AI-queue "silently dropped re-enqueue" bug
 * (Phase 29 / A1): the digest "Refresh" and the retry of a FAILED
 * analysis enqueue under the row's permanent id, and BullMQ ignores an
 * `add` whose id still exists as a completed/failed job.
 *
 * Needs a real Redis (REDIS_URL, default redis://127.0.0.1:6379); skipped
 * when unreachable, like enqueueAllJobId.realRedis.test.ts. Uses its own
 * queue name so it never competes with a real worker.
 */
const TEST_QUEUE_NAME = "cma-a1-replace-terminal-test";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";

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

const reachable = await redisIsReachable(REDIS_URL);

function waitFor(worker: Worker, event: "completed" | "failed", predicate: (job: Job) => boolean, timeoutMs = 15_000): Promise<Job> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${event}'`)), timeoutMs);
    worker.on(event, (job: Job | undefined) => {
      if (job && predicate(job)) {
        clearTimeout(timer);
        resolve(job);
      }
    });
  });
}

describe.skipIf(!reachable)("addJobReplacingTerminal (real Redis, real BullMQ)", () => {
  let queue: Queue;
  let worker: Worker;
  const processed: string[] = [];
  let failNext = false;
  let blockUntil: Promise<void> | null = null;

  beforeAll(() => {
    queue = new Queue(TEST_QUEUE_NAME, {
      connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 3600 } },
    });
    worker = new Worker(
      TEST_QUEUE_NAME,
      async (job: Job) => {
        processed.push(job.id ?? "");
        if (blockUntil) await blockUntil;
        if (failNext) {
          failNext = false;
          throw new Error("provider exploded");
        }
        return { ok: true };
      },
      { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 3 },
    );
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it("baseline (the bug): plain queue.add under an id that already completed is silently NOT re-run", async () => {
    const id = `row-baseline-${Date.now()}`;
    await queue.add("x", {}, { jobId: id });
    await waitFor(worker, "completed", (j) => j.id === id);
    await queue.add("x", {}, { jobId: id });
    await new Promise((r) => setTimeout(r, 500));
    expect(processed.filter((p) => p === id)).toHaveLength(1);
  });

  it("re-enqueue after COMPLETED (digest Refresh) runs the job again", async () => {
    const id = `row-refresh-${Date.now()}`;
    await addJobReplacingTerminal(queue, "x", {}, id);
    await waitFor(worker, "completed", (j) => j.id === id);

    const again = waitFor(worker, "completed", (j) => j.id === id);
    await addJobReplacingTerminal(queue, "x", {}, id);
    await again;
    expect(processed.filter((p) => p === id)).toHaveLength(2);
  });

  it("re-enqueue after FAILED (analysis retry) runs the job again", async () => {
    const id = `row-retry-${Date.now()}`;
    failNext = true;
    await addJobReplacingTerminal(queue, "x", {}, id);
    await waitFor(worker, "failed", (j) => j.id === id);

    const again = waitFor(worker, "completed", (j) => j.id === id);
    await addJobReplacingTerminal(queue, "x", {}, id);
    await again;
    expect(processed.filter((p) => p === id)).toHaveLength(2);
  });

  it("dedup is preserved: a second enqueue while the job is active/waiting does NOT create a second job", async () => {
    const id = `row-inflight-${Date.now()}`;
    let release!: () => void;
    blockUntil = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await addJobReplacingTerminal(queue, "x", {}, id);
      await new Promise((r) => setTimeout(r, 300)); // let the worker pick it up (active)
      await addJobReplacingTerminal(queue, "x", {}, id);
      await addJobReplacingTerminal(queue, "x", {}, id);
    } finally {
      const done = waitFor(worker, "completed", (j) => j.id === id);
      release();
      blockUntil = null;
      await done;
    }
    expect(processed.filter((p) => p === id)).toHaveLength(1);
  });
});
