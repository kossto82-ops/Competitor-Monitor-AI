import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import {
  countActiveCompetitorsForOrg,
  finalizeReport,
  getOrCreateReportPeriod,
  getReportRecipientEmailForOrg,
  getReportWithItemsForOrg,
  listChangeEventsForReportWindow,
  listOrganizationsForDailyReportScheduling,
  markReportEmailFailed,
  markReportEmailSent,
  markReportFailed,
  reserveReportEmailNotification,
} from "./dailyReports.js";

/** Same real-Postgres convention as every other repository test in this workspace: skipped, not failed, when unreachable. */
async function databaseIsReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();
const createdOrgIds: string[] = [];

describe.skipIf(!reachable)("dailyReports repository (Phase 4)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrgWithCompetitor(label: string, opts: { dailyReportEnabled?: boolean; timezone?: string } = {}) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `DailyReport ${label} ${runId}-${counter}`,
      email: `daily-report-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    if (opts.dailyReportEnabled !== undefined || opts.timezone !== undefined) {
      await prisma.organization.update({
        where: { id: organization.id },
        data: {
          ...(opts.dailyReportEnabled !== undefined ? { dailyReportEnabled: opts.dailyReportEnabled } : {}),
          ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
        },
      });
    }
    const competitor = await createCompetitor(organization.id, { name: `Competitor ${label}` });
    const monitoredUrl = await createMonitoredUrl(organization.id, competitor.id, {
      url: `https://competitor-${label.toLowerCase()}.example.test/pricing`,
      category: "PRICING_PAGE",
    });
    return { organization, competitor, monitoredUrl };
  }

  /** Creates a real ChangeEvent (job -> snapshot -> change event chain) detected at a given instant. */
  async function makeChangeEventAt(organizationId: string, monitoredUrlId: string, detectedAt: Date) {
    const job = await prisma.monitoringJob.create({ data: { organizationId, monitoredUrlId, status: "COMPLETED" } });
    const snapshot = await prisma.snapshot.create({
      data: {
        organizationId,
        monitoredUrlId,
        monitoringJobId: job.id,
        extractionMethod: "CHEERIO",
        verificationState: "CHANGED",
        normalizedContent: "content",
        confidence: 1,
      },
    });
    return prisma.changeEvent.create({
      data: {
        organizationId,
        monitoredUrlId,
        currentSnapshotId: snapshot.id,
        changeType: "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.9,
        fieldPath: "price",
        oldValue: "49",
        newValue: "59",
        percentageChange: 20.41,
        evidenceExcerpt: "evidence",
        detectedAt,
      },
    });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("getOrCreateReportPeriod is idempotent - a second call for the same (org, date, timezone) returns the SAME row", async () => {
    const { organization } = await makeOrgWithCompetitor("period");

    const first = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");
    const second = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");

    expect(second.id).toBe(first.id);
    expect(await prisma.report.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it("getOrCreateReportPeriod treats a different timezone as a different period", async () => {
    const { organization } = await makeOrgWithCompetitor("period-tz");

    const utc = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");
    const berlin = await getOrCreateReportPeriod(organization.id, "2026-09-16", "Europe/Berlin");

    expect(berlin.id).not.toBe(utc.id);
  });

  it("listChangeEventsForReportWindow only returns ChangeEvents inside [startUtc, endUtc)", async () => {
    const { organization, monitoredUrl } = await makeOrgWithCompetitor("window");

    const inWindow = await makeChangeEventAt(organization.id, monitoredUrl.id, new Date("2026-09-16T12:00:00.000Z"));
    await makeChangeEventAt(organization.id, monitoredUrl.id, new Date("2026-09-15T23:59:59.000Z")); // before window
    await makeChangeEventAt(organization.id, monitoredUrl.id, new Date("2026-09-17T00:00:00.000Z")); // exactly at the exclusive end

    const events = await listChangeEventsForReportWindow(
      organization.id,
      new Date("2026-09-16T00:00:00.000Z"),
      new Date("2026-09-17T00:00:00.000Z"),
    );

    expect(events.map((e) => e.id)).toEqual([inWindow.id]);
    // Section 6: every returned ChangeEvent carries its competitor/URL context in one query (no N+1 join needed downstream).
    expect(events[0]?.monitoredUrl.competitor.name).toBe("Competitor window");
  });

  it("finalizeReport is idempotent at the item level - running it twice for the same change set adds zero duplicate items", async () => {
    const { organization, monitoredUrl } = await makeOrgWithCompetitor("finalize");
    const changeEvent = await makeChangeEventAt(organization.id, monitoredUrl.id, new Date("2026-09-16T10:00:00.000Z"));
    const period = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");

    const input = { organizationId: organization.id, competitorCount: 1, competitorsWithChangesCount: 1, changeEventIds: [changeEvent.id] };
    const first = await finalizeReport(period.id, input);
    const second = await finalizeReport(period.id, input);

    expect(first.status).toBe("COMPLETED");
    expect(second.changeCount).toBe(1);
    expect(await prisma.reportItem.count({ where: { reportId: period.id } })).toBe(1);
  });

  it("markReportFailed sets status=FAILED with the error message, without touching item data", async () => {
    const { organization } = await makeOrgWithCompetitor("failed");
    const period = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");

    const failed = await markReportFailed(period.id, "boom");
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toBe("boom");
  });

  it("countActiveCompetitorsForOrg counts only active competitors for that organization", async () => {
    const { organization, competitor } = await makeOrgWithCompetitor("count");
    await createCompetitor(organization.id, { name: "Inactive one" }).then((c) =>
      prisma.competitor.update({ where: { id: c.id }, data: { isActive: false } }),
    );

    expect(await countActiveCompetitorsForOrg(organization.id)).toBe(1);
    expect(competitor.isActive).toBe(true);
  });

  it("getReportWithItemsForOrg returns each item's ChangeEvent and (when present) its AiAnalysis", async () => {
    const { organization, monitoredUrl } = await makeOrgWithCompetitor("with-items");
    const changeEvent = await makeChangeEventAt(organization.id, monitoredUrl.id, new Date("2026-09-16T09:00:00.000Z"));
    await prisma.aiAnalysis.create({
      data: { organizationId: organization.id, changeEventId: changeEvent.id, promptVersion: "v1", status: "COMPLETED", summary: "AI summary" },
    });
    const period = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");
    await finalizeReport(period.id, { organizationId: organization.id, competitorCount: 1, competitorsWithChangesCount: 1, changeEventIds: [changeEvent.id] });

    const withItems = await getReportWithItemsForOrg(organization.id, period.id);
    expect(withItems.items).toHaveLength(1);
    expect(withItems.items[0]?.changeEvent.id).toBe(changeEvent.id);
    expect(withItems.items[0]?.changeEvent.aiAnalysis?.summary).toBe("AI summary");
  });

  it("Section 7/8: an item whose ChangeEvent has NO AiAnalysis still comes back - AI is enrichment, never a filter", async () => {
    const { organization, monitoredUrl } = await makeOrgWithCompetitor("no-ai");
    const changeEvent = await makeChangeEventAt(organization.id, monitoredUrl.id, new Date("2026-09-16T09:00:00.000Z"));
    const period = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");
    await finalizeReport(period.id, { organizationId: organization.id, competitorCount: 1, competitorsWithChangesCount: 1, changeEventIds: [changeEvent.id] });

    const withItems = await getReportWithItemsForOrg(organization.id, period.id);
    expect(withItems.items).toHaveLength(1);
    expect(withItems.items[0]?.changeEvent.aiAnalysis).toBeNull();
  });

  it("getReportRecipientEmailForOrg returns the organization's OWNER user email", async () => {
    const { organization } = await makeOrgWithCompetitor("recipient");
    const recipient = await getReportRecipientEmailForOrg(organization.id);
    expect(recipient).toMatch(/^daily-report-recipient-/);
  });

  it("listOrganizationsForDailyReportScheduling only returns organizations with dailyReportEnabled=true", async () => {
    const enabled = await makeOrgWithCompetitor("sched-on", { dailyReportEnabled: true });
    const disabled = await makeOrgWithCompetitor("sched-off", { dailyReportEnabled: false });

    const list = await listOrganizationsForDailyReportScheduling();
    const ids = list.map((o) => o.id);
    expect(ids).toContain(enabled.organization.id);
    expect(ids).not.toContain(disabled.organization.id);
  });

  it("reserveReportEmailNotification + markReportEmailSent is idempotent - a second reservation after SENT reports alreadySent=true and never resets it", async () => {
    const { organization } = await makeOrgWithCompetitor("email-sent");
    const period = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");
    const recipient = "owner@example.test";

    const first = await reserveReportEmailNotification(organization.id, period.id, recipient);
    expect(first.alreadySent).toBe(false);
    await markReportEmailSent(first.log.id);

    const second = await reserveReportEmailNotification(organization.id, period.id, recipient);
    expect(second.alreadySent).toBe(true);
    expect(second.log.id).toBe(first.log.id);
    expect(await prisma.notificationLog.count({ where: { reportId: period.id, recipient } })).toBe(1);
  });

  it("a FAILED notification attempt can be retried and become SENT, without ever creating a second row", async () => {
    const { organization } = await makeOrgWithCompetitor("email-retry");
    const period = await getOrCreateReportPeriod(organization.id, "2026-09-16", "UTC");
    const recipient = "owner@example.test";

    const first = await reserveReportEmailNotification(organization.id, period.id, recipient);
    await markReportEmailFailed(first.log.id, "smtp down");

    const retry = await reserveReportEmailNotification(organization.id, period.id, recipient);
    expect(retry.alreadySent).toBe(false); // FAILED is retryable, unlike SENT
    await markReportEmailSent(retry.log.id);

    expect(await prisma.notificationLog.count({ where: { reportId: period.id, recipient } })).toBe(1);
    const finalRow = await prisma.notificationLog.findUniqueOrThrow({ where: { id: first.log.id } });
    expect(finalRow.status).toBe("SENT");
  });

  it("tenant isolation: notification reservation is scoped per report, never cross-report/cross-org", async () => {
    const a = await makeOrgWithCompetitor("email-tenant-a");
    const b = await makeOrgWithCompetitor("email-tenant-b");
    const periodA = await getOrCreateReportPeriod(a.organization.id, "2026-09-16", "UTC");
    const periodB = await getOrCreateReportPeriod(b.organization.id, "2026-09-16", "UTC");

    const resA = await reserveReportEmailNotification(a.organization.id, periodA.id, "same-recipient@example.test");
    const resB = await reserveReportEmailNotification(b.organization.id, periodB.id, "same-recipient@example.test");

    expect(resA.log.id).not.toBe(resB.log.id);
  });
});
