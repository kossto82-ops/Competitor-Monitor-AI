import { createMonitoringWorker, type MonitoringJobPayload } from "@cma/queue";
import { getMonitoringJobForOrg, markMonitoringJobFailed } from "@cma/db";
import type { Job } from "bullmq";
import { runMonitoringJob } from "./pipeline.js";

const worker = createMonitoringWorker(async (job: Job<MonitoringJobPayload>) => {
  const result = await runMonitoringJob(job.data);
  console.log(
    `[worker] job=${job.id} monitoredUrlId=${job.data.monitoredUrlId} ` +
      `state=${result.verificationState} changeEvents=${result.changeEventCount}`,
  );
  return result;
});

worker.on("failed", (job, err) => {
  console.error(`[worker] job=${job?.id} FAILED:`, err.message);

  /**
   * Phase 2.1 hardening (Section 6): defense-in-depth beyond
   * runMonitoringJob's own try/catch (apps/worker/src/pipeline.ts),
   * which only runs if the pipeline gets a chance to throw. A worker
   * process crash mid-job, or BullMQ's own "stalled job" detection
   * exhausting its retry budget (the worker died, its lock expired, and
   * no processor invocation ever ran to completion or threw), reaches
   * this event WITHOUT ever running that try/catch - so the
   * MonitoringJob row could otherwise stay RUNNING forever. Only
   * possible for the manual-scan path, which threads a stable
   * monitoringJobId through the payload; the cron-style enqueueAll path
   * has no pre-created row to identify here (see Phase 2.1 hardening
   * report's "Remaining risks").
   */
  const monitoringJobId = job?.data?.monitoringJobId;
  const organizationId = job?.data?.organizationId;
  if (!monitoringJobId || !organizationId) return;

  getMonitoringJobForOrg(organizationId, monitoringJobId)
    .then((current) => {
      if (current && current.status !== "COMPLETED" && current.status !== "FAILED") {
        return markMonitoringJobFailed(monitoringJobId, err.message);
      }
      return undefined;
    })
    .catch((markErr: unknown) => {
      console.error(`[worker] failed to mark MonitoringJob ${monitoringJobId} as FAILED after job failure:`, markErr);
    });
});

console.log("[worker] listening for monitoring jobs...");

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
