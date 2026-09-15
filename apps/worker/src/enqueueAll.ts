import { listAllActiveMonitoredUrls } from "@cma/db";
import { createMonitoringQueue, monitoringJobId } from "@cma/queue";

/**
 * Phase 1's "basic/manual scheduling" (Section: MVP scope). This is a
 * script a human (or, in Phase 9, a real cron) runs to enqueue one
 * MonitoringJob per active MonitoredUrl - it does not itself know or
 * care about `scanFrequencyMinutes`, that's future scheduler logic.
 */
async function main() {
  const urls = await listAllActiveMonitoredUrls();
  const queue = createMonitoringQueue();

  for (const url of urls) {
    await queue.add(
      "monitor",
      { organizationId: url.organizationId, monitoredUrlId: url.id },
      { jobId: monitoringJobId(url.id) },
    );
  }

  console.log(`[enqueue-all] enqueued ${urls.length} monitoring job(s).`);
  await queue.close();
}

main().catch((err) => {
  console.error("[enqueue-all] failed:", err);
  process.exit(1);
});
