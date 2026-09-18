import { listDueMonitoredUrls } from "@cma/db";
import { createMonitoringQueue, monitoringJobId, type MonitoringJobPayload } from "@cma/queue";
import type { Queue } from "bullmq";
import { pathToFileURL } from "node:url";

interface DueMonitoredUrlLike {
  id: string;
  organizationId: string;
}

export interface EnqueueAllDeps {
  listDueMonitoredUrls: () => Promise<DueMonitoredUrlLike[]>;
  createMonitoringQueue: () => Pick<Queue<MonitoringJobPayload>, "add" | "close">;
}

export function createDefaultEnqueueAllDeps(): EnqueueAllDeps {
  return { listDueMonitoredUrls, createMonitoringQueue };
}

export interface EnqueueAllResult {
  candidateCount: number;
  enqueuedCount: number;
}

/**
 * Phase 1's "basic/manual scheduling", made frequency-aware in Phase 5
 * (Section 5): a human (or a real cron, e.g. running this every 15
 * minutes) runs this script to enqueue one MonitoringJob per
 * MonitoredUrl that is actually DUE - never scanned yet, or its last
 * successful scan is older than its own `scanFrequencyMinutes` (see
 * @cma/db's listDueMonitoredUrls). A URL scanned recently is skipped
 * this run and picked up on a later one, so `scanFrequencyMinutes` is a
 * real, enforced setting rather than a decorative field nothing reads.
 *
 * Phase 26: extracted from `main()` so `scheduler.ts` (a recurring
 * in-process trigger for environments with no OS cron / K8s CronJob
 * available) can call the exact same enqueue logic on an interval,
 * without duplicating it. This function never touches AI queues - it
 * only ever adds jobs to the monitoring queue, whose processor
 * (apps/worker/src/pipeline.ts) has no AI call anywhere in it. Routine
 * recurring monitoring therefore has zero OpenAI cost by construction.
 */
export async function enqueueDueMonitoringJobs(deps: EnqueueAllDeps = createDefaultEnqueueAllDeps()): Promise<EnqueueAllResult> {
  const urls = await deps.listDueMonitoredUrls();
  const queue = deps.createMonitoringQueue();

  let enqueuedCount = 0;
  try {
    for (const url of urls) {
      await queue.add(
        "monitor",
        { organizationId: url.organizationId, monitoredUrlId: url.id },
        { jobId: monitoringJobId(url.id) },
      );
      enqueuedCount += 1;
    }
  } finally {
    await queue.close();
  }

  return { candidateCount: urls.length, enqueuedCount };
}

async function main() {
  const result = await enqueueDueMonitoringJobs();
  console.log(`[enqueue-all] enqueued ${result.enqueuedCount} monitoring job(s).`);
}

// Only run as a CLI entrypoint - scheduler.ts imports enqueueDueMonitoringJobs
// directly and must not trigger this file's own main(). Compared via
// pathToFileURL (not a raw `file://${...}` template) because a naive
// template mismatches on Windows: backslash path separators and
// percent-encoding (e.g. "~" -> "%7E") differ between import.meta.url's
// own URL form and a manually concatenated one, which made this check
// silently always-false on Windows during Phase 26 - the CLI script
// enqueued nothing and printed nothing until this fix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[enqueue-all] failed:", err);
    process.exit(1);
  });
}
