import { Redis } from "ioredis";
import { Queue, Worker, type Processor } from "bullmq";
import { createRedisConnection } from "./monitoringQueue.js";

export const CAPABILITY_AI_QUEUE_NAME = "capability-ai-jobs";

export interface CapabilityAiJobPayload {
  organizationId: string;
  /** The CapabilityAiRun row's id, created PENDING by the trigger route before enqueueing; also the job id. */
  capabilityAiRunId: string;
}

export function createCapabilityAiQueue(connection: Redis = createRedisConnection()): Queue<CapabilityAiJobPayload> {
  return new Queue<CapabilityAiJobPayload>(CAPABILITY_AI_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // No automatic retries: a retry is another paid batch on top of the one retry each page already gets.
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
  });
}

export function createCapabilityAiWorker(processor: Processor<CapabilityAiJobPayload>, connection: Redis = createRedisConnection()): Worker<CapabilityAiJobPayload> {
  return new Worker<CapabilityAiJobPayload>(CAPABILITY_AI_QUEUE_NAME, processor, { connection, concurrency: 1 });
}
