import { currentReportDateInTimezone } from "@cma/core";
import { listOrganizationsForDailyReportScheduling } from "@cma/db";
import { createDailyReportQueue, dailyReportJobId } from "@cma/queue";

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
 */
async function main() {
  const organizations = await listOrganizationsForDailyReportScheduling();
  const queue = createDailyReportQueue();

  let enqueued = 0;
  for (const org of organizations) {
    const reportDate = currentReportDateInTimezone(org.timezone);
    await queue.add(
      "daily-report",
      { organizationId: org.id, reportDate, timezone: org.timezone },
      { jobId: dailyReportJobId(org.id, reportDate, org.timezone) },
    );
    enqueued += 1;
  }

  console.log(`[enqueue-daily-reports] enqueued ${enqueued} daily report job(s) for ${organizations.length} organization(s).`);
  await queue.close();
}

main().catch((err) => {
  console.error("[enqueue-daily-reports] failed:", err);
  process.exit(1);
});
