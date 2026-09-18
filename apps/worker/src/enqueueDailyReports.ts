import { currentReportDateInTimezone } from "@cma/core";
import { listOrganizationsForDailyReportScheduling } from "@cma/db";
import { createDailyReportQueue, dailyReportJobId, type DailyReportJobPayload } from "@cma/queue";
import type { Queue } from "bullmq";
import { pathToFileURL } from "node:url";

interface DailyReportSchedulingOrgLike {
  id: string;
  timezone: string;
}

export interface EnqueueDailyReportsDeps {
  listOrganizationsForDailyReportScheduling: () => Promise<DailyReportSchedulingOrgLike[]>;
  createDailyReportQueue: () => Pick<Queue<DailyReportJobPayload>, "add" | "close">;
}

export function createDefaultEnqueueDailyReportsDeps(): EnqueueDailyReportsDeps {
  return { listOrganizationsForDailyReportScheduling, createDailyReportQueue };
}

export interface EnqueueDailyReportsResult {
  organizationCount: number;
  enqueuedCount: number;
}

/**
 * Phase 4 (Section 11): the minimum scheduling this phase asks for - a
 * script (a human, or a real cron/K8s CronJob calling it once a day)
 * enqueues one daily-report job per organization with
 * `dailyReportEnabled=true`, for "today" AS SEEN IN THAT ORGANIZATION'S
 * OWN TIMEZONE (Section 3) - deliberately NOT a single global "today"
 * computed once for every organization, since two organizations in
 * different timezones are not on the same calendar day at the same
 * instant.
 *
 * No cron-expression UI, no per-organization schedule customization
 * (Section 11: "do not build a complex scheduling system") - this script
 * itself is expected to be invoked once daily (e.g. via a K8s CronJob or
 * a plain OS cron entry, see DevRunbook.md), same "basic/manual
 * scheduling" spirit as enqueueAll.ts's monitoring-job equivalent.
 *
 * Phase 26: extracted from `main()` so `scheduler.ts` can call it
 * on a recurring, in-process daily tick. `dailyReportJobId` is
 * per-organization-per-calendar-day, so calling this function more than
 * once on the same day is a safe no-op re-add (BullMQ dedupes on job id)
 * rather than a duplicate report. This function never touches AI queues.
 */
export async function enqueueDailyReportJobs(
  deps: EnqueueDailyReportsDeps = createDefaultEnqueueDailyReportsDeps(),
): Promise<EnqueueDailyReportsResult> {
  const organizations = await deps.listOrganizationsForDailyReportScheduling();
  const queue = deps.createDailyReportQueue();

  let enqueuedCount = 0;
  try {
    for (const org of organizations) {
      const reportDate = currentReportDateInTimezone(org.timezone);
      await queue.add(
        "daily-report",
        { organizationId: org.id, reportDate, timezone: org.timezone },
        { jobId: dailyReportJobId(org.id, reportDate, org.timezone) },
      );
      enqueuedCount += 1;
    }
  } finally {
    await queue.close();
  }

  return { organizationCount: organizations.length, enqueuedCount };
}

async function main() {
  const result = await enqueueDailyReportJobs();
  console.log(`[enqueue-daily-reports] enqueued ${result.enqueuedCount} daily report job(s) for ${result.organizationCount} organization(s).`);
}

// See enqueueAll.ts's matching guard for why pathToFileURL is required
// here instead of a raw `file://${...}` template (Windows path mismatch).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[enqueue-daily-reports] failed:", err);
    process.exit(1);
  });
}
