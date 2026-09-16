import { Redis } from "ioredis";
import { Queue, Worker, type Processor } from "bullmq";
import { createRedisConnection } from "./monitoringQueue.js";

export const DIGEST_INTERPRETATION_QUEUE_NAME = "digest-interpretation-jobs";

export interface DigestInterpretationJobPayload {
  organizationId: string;
  /** Which period selector (7/30/90) this job interprets - matches DigestAiInterpretation.days. */
  days: number;
  /** The DigestAiInterpretation row's own id, created/reset (PENDING) by the trigger route before enqueueing - same "pre-create the row, then enqueue under its own id" shape as AiAnalysisJobPayload.aiAnalysisId. */
  digestAiInterpretationId: string;
}

export function createDigestInterpretationQueue(connection: Redis = createRedisConnection()): Queue<DigestInterpretationJobPayload> {
  return new Queue<DigestInterpretationJobPayload>(DIGEST_INTERPRETATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Same cost-control rationale as ai-analysis-jobs (Section 18 of
      // the Phase 11 brief: "maximum provider calls = 1" per
      // interpretation attempt) - no automatic BullMQ retries, since a
      // retry here means a second paid call on top of @cma/ai's own
      // single internal retry (interpretDigestWithRetry.ts).
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
  });
}

export function createDigestInterpretationWorker(
  processor: Processor<DigestInterpretationJobPayload>,
  connection: Redis = createRedisConnection(),
): Worker<DigestInterpretationJobPayload> {
  return new Worker<DigestInterpretationJobPayload>(DIGEST_INTERPRETATION_QUEUE_NAME, processor, {
    connection,
    concurrency: 3,
  });
}
