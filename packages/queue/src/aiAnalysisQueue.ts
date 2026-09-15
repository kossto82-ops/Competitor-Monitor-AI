import { Redis } from "ioredis";
import { Queue, Worker, type Processor } from "bullmq";
import { createRedisConnection } from "./monitoringQueue.js";

export const AI_ANALYSIS_QUEUE_NAME = "ai-analysis-jobs";

export interface AiAnalysisJobPayload {
  organizationId: string;
  changeEventId: string;
  /**
   * The AiAnalysis row's own id, created (PENDING) by the trigger route
   * before enqueueing - same "pre-create the row, then enqueue under
   * its own id" shape as MonitoringJobPayload.monitoringJobId, and for
   * the same reason: it gives BullMQ a stable, idempotent job id (a
   * second POST to the same ChangeEvent's analysis endpoint enqueues
   * under the same id, so BullMQ's own dedup applies) and gives the
   * dashboard something stable to poll from the moment the request
   * returns, before the worker has picked the job up.
   */
  aiAnalysisId: string;
}

export function createAiAnalysisQueue(connection: Redis = createRedisConnection()): Queue<AiAnalysisJobPayload> {
  return new Queue<AiAnalysisJobPayload>(AI_ANALYSIS_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Deliberately no automatic BullMQ retries (Section 7: cost
      // control) - a retry here means a second paid AI call. The one
      // retry Section 6 asks for happens inside
      // @cma/ai's analyzeChangeWithRetry, which the worker calls once
      // per job attempt; BullMQ retrying the whole job on top of that
      // would multiply cost for no correctness benefit.
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
  });
}

export function createAiAnalysisWorker(
  processor: Processor<AiAnalysisJobPayload>,
  connection: Redis = createRedisConnection(),
): Worker<AiAnalysisJobPayload> {
  return new Worker<AiAnalysisJobPayload>(AI_ANALYSIS_QUEUE_NAME, processor, {
    connection,
    concurrency: 3,
  });
}
