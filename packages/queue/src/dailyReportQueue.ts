import { Redis } from "ioredis";
import { Queue, Worker, type Processor } from "bullmq";
import { createRedisConnection } from "./monitoringQueue.js";

export const DAILY_REPORT_QUEUE_NAME = "daily-report-jobs";

export interface DailyReportJobPayload {
  organizationId: string;
  /** "YYYY-MM-DD" - the calendar day (in the organization's own timezone) this report covers. */
  reportDate: string;
  timezone: string;
}

export function createDailyReportQueue(connection: Redis = createRedisConnection()): Queue<DailyReportJobPayload> {
  return new Queue<DailyReportJobPayload>(DAILY_REPORT_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Section 9/28: report generation reads already-persisted data and
      // makes no paid AI calls itself, so a small number of automatic
      // retries (unlike ai-analysis-jobs) is safe and cheap - it just
      // re-runs the same idempotent aggregation.
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
  });
}

export function createDailyReportWorker(
  processor: Processor<DailyReportJobPayload>,
  connection: Redis = createRedisConnection(),
): Worker<DailyReportJobPayload> {
  return new Worker<DailyReportJobPayload>(DAILY_REPORT_QUEUE_NAME, processor, {
    connection,
    concurrency: 3,
  });
}

/**
 * Stable job id, one per (organization, reportDate, timezone) - the same
 * "reuse/coalesce" reasoning as monitoringJobId, but WITHOUT a time
 * bucket: unlike a manual "scan now" click, there is exactly one correct
 * report per organization per calendar day, so enqueuing twice for the
 * same day (a duplicate scheduler tick, a manual re-trigger) should
 * always resolve to the SAME BullMQ job, not a new one - the
 * organizationId+reportDate+timezone `@@unique` constraint on the Report
 * row is the deeper safety net (Section 9), this is the queue-level one
 * that avoids doing the aggregation work twice in the common case.
 *
 * No ":" in the id, same BullMQ restriction monitoringJobId's comment
 * documents.
 */
export function dailyReportJobId(organizationId: string, reportDate: string, timezone: string): string {
  const safeTimezone = timezone.replace(/\//g, "_");
  return `daily-report-${organizationId}-${reportDate}-${safeTimezone}`;
}
