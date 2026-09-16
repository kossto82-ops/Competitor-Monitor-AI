import { Prisma } from "../../generated/client/index.js";
import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Stored as the UTC-midnight instant of the calendar date - a bare date marker, NOT the window's actual (timezone-dependent) UTC bounds. See packages/core's resolveOrgLocalDayWindow for the latter. */
function reportDateToStorageValue(reportDate: string): Date {
  return new Date(`${reportDate}T00:00:00.000Z`);
}

/**
 * Section 4/9's idempotency anchor: `findFirst`-then-`create` has a race
 * window under near-simultaneous triggers (two overlapping scheduler
 * ticks, a retried queue job) - same shape as
 * aiAnalysis.ts's getOrCreatePendingAiAnalysis, and for the same reason.
 * The `@@unique([organizationId, reportDate, timezone])` constraint is
 * the actual safety net; a race that gets past the findFirst check has
 * its losing `create` unique-violation caught here and turned into
 * "return the existing row", never a 500 and never a second report.
 *
 * Always returns the SAME row for a second call with the same
 * arguments, regardless of its current status - callers (the report
 * pipeline) decide what to do with an already-COMPLETED or
 * already-GENERATING row; this function's only job is "find or create
 * the one row for this period".
 */
export async function getOrCreateReportPeriod(organizationId: string, reportDate: string, timezone: string) {
  const reportDateValue = reportDateToStorageValue(reportDate);
  const existing = await prisma.report.findFirst({ where: { organizationId, reportDate: reportDateValue, timezone } });
  if (existing) return existing;

  try {
    return await prisma.report.create({
      data: { organizationId, reportDate: reportDateValue, timezone, status: "GENERATING" },
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const raced = await prisma.report.findFirst({ where: { organizationId, reportDate: reportDateValue, timezone } });
      if (raced) return raced;
    }
    throw err;
  }
}

/**
 * Section 6: every persisted ChangeEvent already represents a verified
 * change - `compareSnapshots` (Phase 1/2) never creates a ChangeEvent row
 * for a NO_CHANGE or FAILED_TO_VERIFY snapshot (see aiPipeline.ts's own
 * comment making the same point). So selecting "ChangeEvents in this
 * window" IS selecting "verified competitor changes in this window" -
 * no separate status filter is needed or possible on ChangeEvent itself.
 *
 * Includes the AI analysis (Section 7/8: enrichment, read whether or not
 * it's COMPLETED - the report pipeline decides what to show for a
 * missing/FAILED analysis, this function just returns what exists) and
 * enough of the monitored URL/competitor chain to group and label items
 * without a second round-trip per item (Section 29: no N+1).
 */
export async function listChangeEventsForReportWindow(organizationId: string, startUtc: Date, endUtc: Date) {
  return prisma.changeEvent.findMany({
    where: { organizationId, detectedAt: { gte: startUtc, lt: endUtc } },
    orderBy: [{ detectedAt: "asc" }],
    include: {
      monitoredUrl: {
        select: {
          id: true,
          url: true,
          label: true,
          competitorId: true,
          competitor: { select: { id: true, name: true } },
        },
      },
      aiAnalysis: true,
    },
  });
}

/** Section 1: "N competitors monitored" - active competitors for the organization, independent of whether any of them changed. */
export async function countActiveCompetitorsForOrg(organizationId: string): Promise<number> {
  return prisma.competitor.count({ where: { organizationId, isActive: true } });
}

export interface FinalizeReportInput {
  organizationId: string;
  competitorCount: number;
  competitorsWithChangesCount: number;
  changeEventIds: string[];
}

/**
 * Section 9: the write side of report generation, run once per
 * generation attempt. `createMany({ skipDuplicates: true })` against the
 * `@@unique([reportId, changeEventId])` constraint is what makes
 * re-running generation for the same report idempotent AT THE ITEM
 * LEVEL - a second run that recomputes the same window and change list
 * adds zero duplicate rows, it just re-confirms the same set (Section 9:
 * "running it twice must not duplicate report items").
 *
 * Wrapped in a transaction so a report is never left COMPLETED with a
 * partially-written item set.
 */
export async function finalizeReport(reportId: string, input: FinalizeReportInput) {
  return prisma.$transaction(async (tx) => {
    if (input.changeEventIds.length > 0) {
      await tx.reportItem.createMany({
        data: input.changeEventIds.map((changeEventId) => ({
          organizationId: input.organizationId,
          reportId,
          changeEventId,
        })),
        skipDuplicates: true,
      });
    }
    return tx.report.update({
      where: { id: reportId },
      data: {
        status: "COMPLETED",
        competitorCount: input.competitorCount,
        competitorsWithChangesCount: input.competitorsWithChangesCount,
        changeCount: input.changeEventIds.length,
        generatedAt: new Date(),
        errorMessage: null,
      },
    });
  });
}

/** Mirrors markAiAnalysisFailed's non-destructive shape: records the failure reason, never silently swallowed, so a failed generation attempt is visible in the dashboard/history instead of hanging forever in GENERATING. */
export async function markReportFailed(reportId: string, errorMessage: string) {
  return prisma.report.update({
    where: { id: reportId },
    data: { status: "FAILED", errorMessage },
  });
}

export async function listReportsForOrg(organizationId: string, limit = 30) {
  return prisma.report.findMany({
    where: { organizationId },
    orderBy: { reportDate: "desc" },
    take: limit,
  });
}

/** Section 12: "Today's competitor update" - the dashboard's read-only view of the most recent report. Never triggers generation itself (Section 12: "must not run report generation synchronously in the HTTP request"). */
export async function getLatestReportForOrg(organizationId: string) {
  return prisma.report.findFirst({ where: { organizationId }, orderBy: { reportDate: "desc" } });
}

export async function getReportForOrg(organizationId: string, reportId: string) {
  const report = await prisma.report.findFirst({ where: { id: reportId, organizationId } });
  if (!report) throw new NotFoundError("Report");
  return report;
}

/**
 * The report detail page's one query (Section 13): report + every item,
 * each carrying its ChangeEvent (deterministic fact, Section 18's
 * "authoritative" source) and that ChangeEvent's AiAnalysis when one
 * exists (Section 7's "enrichment"). Items are NOT pre-sorted here - see
 * groupReportItemsByCompetitor in apps/worker/src/reportPipeline.ts for
 * the deterministic Section 20 ordering (competitor name -> detectedAt
 * -> changeType), computed once, in application code, reused by both the
 * web detail page and the email builder.
 */
export async function getReportWithItemsForOrg(organizationId: string, reportId: string) {
  const report = await prisma.report.findFirst({
    where: { id: reportId, organizationId },
    include: {
      items: {
        include: {
          changeEvent: {
            include: {
              monitoredUrl: {
                select: { id: true, url: true, label: true, competitorId: true, competitor: { select: { id: true, name: true } } },
              },
              aiAnalysis: true,
            },
          },
        },
      },
    },
  });
  if (!report) throw new NotFoundError("Report");
  return report;
}

export type ReportWithItems = Awaited<ReturnType<typeof getReportWithItemsForOrg>>;
export type ReportItemWithChangeEvent = ReportWithItems["items"][number];

/** Section 11: which organizations the scheduler should enqueue a daily report job for. */
export async function listOrganizationsForDailyReportScheduling() {
  return prisma.organization.findMany({
    where: { dailyReportEnabled: true },
    select: { id: true, timezone: true },
  });
}

/**
 * Section 15/18: the email recipient. Phase 5 (Section 18) adds an
 * optional per-organization override (`Organization.reportRecipientEmail`,
 * settable from /settings/notifications); when unset, falls back to
 * Phase 4's original behavior - the organization's own OWNER user, who
 * already exists for every organization (see createOrganizationWithOwner).
 */
export async function getReportRecipientEmailForOrg(organizationId: string): Promise<string | null> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { reportRecipientEmail: true } });
  if (org?.reportRecipientEmail) return org.reportRecipientEmail;

  const owner = await prisma.user.findFirst({
    where: { organizationId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
  });
  return owner?.email ?? null;
}

/**
 * Section 16/17's idempotency reservation: mirrors
 * getOrCreatePendingAiAnalysis exactly, on the
 * `@@unique([reportId, channel, recipient])` constraint instead. A
 * caller that gets `alreadySent: true` back must NOT call the email
 * provider at all - the row already reflects a successful prior send.
 */
export async function reserveReportEmailNotification(organizationId: string, reportId: string, recipient: string) {
  const existing = await prisma.notificationLog.findFirst({ where: { reportId, channel: "EMAIL", recipient } });
  if (existing) return { log: existing, alreadySent: existing.status === "SENT" };

  try {
    const created = await prisma.notificationLog.create({
      data: { organizationId, reportId, channel: "EMAIL", recipient, status: "PENDING" },
    });
    return { log: created, alreadySent: false };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const raced = await prisma.notificationLog.findFirst({ where: { reportId, channel: "EMAIL", recipient } });
      if (raced) return { log: raced, alreadySent: raced.status === "SENT" };
    }
    throw err;
  }
}

export async function markReportEmailSent(notificationLogId: string) {
  return prisma.notificationLog.update({
    where: { id: notificationLogId },
    data: { status: "SENT", sentAt: new Date(), errorMessage: null },
  });
}

/**
 * Section 17: an email failure marks only this notification row FAILED -
 * it never touches the Report row (which stays COMPLETED and fully
 * visible in the dashboard/history regardless of delivery outcome).
 */
export async function markReportEmailFailed(notificationLogId: string, errorMessage: string) {
  return prisma.notificationLog.update({
    where: { id: notificationLogId },
    data: { status: "FAILED", errorMessage },
  });
}
