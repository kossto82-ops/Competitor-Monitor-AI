import { listDueMonitoredUrls } from "@cma/db";
import { createMonitoringQueue, monitoringJobId } from "@cma/queue";

/**
 * Phase 1's "basic/manual scheduling", made frequency-aware in Phase 5
 * (Section 5): a human (or a real cron, e.g. running this every 15
 * minutes) runs this script to enqueue one MonitoringJob per
 * MonitoredUrl that is actually DUE - never scanned yet, or its last
 * successful scan is older than its own `scanFrequencyMinutes` (see
 * @cma/db's listDueMonitoredUrls). A URL scanned recently is skipped
 * this run and picked up on a later one, so `scanFrequencyMinutes` is a
 * real, enforced setting rather than a decorative field nothing reads.
 */
async function main() {
  const urls = await listDueMonitoredUrls();
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
