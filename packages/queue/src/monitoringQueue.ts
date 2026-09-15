import { Redis } from "ioredis";
import { Queue, Worker, type Processor } from "bullmq";

export const MONITORING_QUEUE_NAME = "monitoring-jobs";

export interface MonitoringJobPayload {
  organizationId: string;
  monitoredUrlId: string;
  /**
   * Phase 2 addition: when the API enqueues a scan, it creates the
   * MonitoringJob row as PENDING first and passes its id here, so the
   * worker updates that same row instead of creating a second one -
   * this is what lets the dashboard poll a stable id through
   * Queued -> Scanning -> Completed/Failed. Absent for the older
   * "enqueue every active URL" CLI path, which still creates its job
   * row only once the worker picks it up.
   */
  monitoringJobId?: string;
}

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it
 * uses for blocking commands - without it, the client silently retries
 * forever instead of the queue's own retry/backoff logic taking over.
 */
export function createRedisConnection(): Redis {
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createMonitoringQueue(connection: Redis = createRedisConnection()): Queue<MonitoringJobPayload> {
  return new Queue<MonitoringJobPayload>(MONITORING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7 }, // keep 7 days for debugging, then drop
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
  });
}

export function createMonitoringWorker(
  processor: Processor<MonitoringJobPayload>,
  connection: Redis = createRedisConnection(),
): Worker<MonitoringJobPayload> {
  return new Worker<MonitoringJobPayload>(MONITORING_QUEUE_NAME, processor, {
    connection,
    concurrency: 5,
  });
}

/**
 * Deterministic-but-time-bucketed job ID: enqueuing the same URL twice
 * within the same bucket (e.g. two overlapping manual enqueue-all runs,
 * or a double-click on "scan now") de-dupes at the queue level instead
 * of creating a second MonitoringJob, but a genuinely new scan request
 * after the bucket has passed always gets a fresh job.
 *
 * This is NOT cosmetic: an earlier version used a permanently
 * deterministic `monitor-{monitoredUrlId}` id with no bucket. Real
 * end-to-end API testing during Phase 1 validation caught that once a
 * job with that id completed, BullMQ kept the completed job under that
 * id (per `removeOnComplete`'s retention window) - so every subsequent
 * "scan now" click for that URL silently returned the SAME stale
 * completed job instead of enqueueing a new run, and the URL could
 * never be re-scanned again within the retention window. Bucketing by
 * time keeps the intended dedup behavior for near-simultaneous
 * triggers while not permanently blocking future scans.
 *
 * BullMQ also rejects custom job IDs containing ":" (it uses that
 * character internally as a Redis key separator) - confirmed by a real
 * BullMQ `Job.validateOptions` throw during Phase 1 validation, not
 * assumed. Hyphen-separated instead.
 */
export function monitoringJobId(monitoredUrlId: string, bucketMs = 60_000): string {
  const bucket = Math.floor(Date.now() / bucketMs);
  return `monitor-${monitoredUrlId}-${bucket}`;
}
