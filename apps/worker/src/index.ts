import { createMonitoringWorker, type MonitoringJobPayload } from "@cma/queue";
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
});

console.log("[worker] listening for monitoring jobs...");

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
