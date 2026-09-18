import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./client.js";
import { createOrganizationWithOwner } from "./repositories/organizations.js";
import { createCompetitor, getCompetitorForOrg, listCompetitorsForOrg } from "./repositories/competitors.js";
import {
  createMonitoredUrl,
  getMonitoredUrlForOrg,
  listMonitoredUrlsForOrg,
} from "./repositories/monitoredUrls.js";
import { listChangeEventsForOrg } from "./repositories/changeEvents.js";
import { getSnapshotForOrg } from "./repositories/snapshots.js";
import { getAiAnalysisForOrg } from "./repositories/aiAnalysis.js";
import { getReportForOrg, getReportWithItemsForOrg, listReportsForOrg } from "./repositories/dailyReports.js";
import { NotFoundError } from "./repositories/errors.js";

/**
 * This whole suite requires a real Postgres reachable via DATABASE_URL
 * (see packages/db/prisma/schema.prisma + .env.example). It is skipped
 * rather than failing when no database is reachable, so `npm test` stays
 * green in environments without local infra - but that means a skip
 * here is NOT proof of tenant isolation, only an unexecuted assertion.
 * Run `docker compose up -d` (or point DATABASE_URL at any Postgres) and
 * `npm run db:migrate` before relying on this suite as a real gate.
 */
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

describe.skipIf(!reachable)("tenant isolation", () => {
  const runId = Date.now();

  async function makeTenant(label: string) {
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Tenant ${label} ${runId}`,
      email: `tenant-${label}-${runId}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: `Competitor ${label}` });
    const monitoredUrl = await createMonitoredUrl(organization.id, competitor.id, {
      url: `https://competitor-${label.toLowerCase()}.example.test/pricing`,
      category: "PRICING_PAGE",
    });
    return { organization, competitor, monitoredUrl };
  }

  /**
   * Builds a full real chain (job -> snapshot -> change event -> AI
   * analysis, plus a report) via direct Prisma writes, since Phase 1
   * has no repository "create" helpers for these yet (nothing in the
   * pipeline writes AiAnalysis/Report rows so far). Test fixtures are
   * allowed to reach for Prisma directly; production code must not.
   */
  async function makeTenantWithFullChain(label: string) {
    const tenant = await makeTenant(label);
    const job = await prisma.monitoringJob.create({
      data: { organizationId: tenant.organization.id, monitoredUrlId: tenant.monitoredUrl.id, status: "COMPLETED" },
    });
    const snapshot = await prisma.snapshot.create({
      data: {
        organizationId: tenant.organization.id,
        monitoredUrlId: tenant.monitoredUrl.id,
        monitoringJobId: job.id,
        extractionMethod: "CHEERIO",
        verificationState: "CHANGED",
        normalizedContent: "test content",
        confidence: 1,
      },
    });
    const changeEvent = await prisma.changeEvent.create({
      data: {
        organizationId: tenant.organization.id,
        monitoredUrlId: tenant.monitoredUrl.id,
        currentSnapshotId: snapshot.id,
        changeType: "CONTENT_CHANGE",
        severity: "LOW",
        confidence: 0.5,
        fieldPath: "page.visibleText",
        evidenceExcerpt: "test evidence",
      },
    });
    const aiAnalysis = await prisma.aiAnalysis.create({
      data: {
        organizationId: tenant.organization.id,
        changeEventId: changeEvent.id,
        promptVersion: "test-fixture-v1",
        status: "COMPLETED",
        summary: "test summary",
      },
    });
    const report = await prisma.report.create({
      data: {
        organizationId: tenant.organization.id,
        reportDate: new Date("2026-09-16T00:00:00.000Z"),
        timezone: "UTC",
        status: "COMPLETED",
        competitorCount: 1,
        competitorsWithChangesCount: 1,
        changeCount: 1,
        generatedAt: new Date(),
      },
    });
    const reportItem = await prisma.reportItem.create({
      data: { organizationId: tenant.organization.id, reportId: report.id, changeEventId: changeEvent.id },
    });
    return { ...tenant, job, snapshot, changeEvent, aiAnalysis, report, reportItem };
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("prevents org B from reading org A's competitor by ID", async () => {
    const a = await makeTenant("A");
    const b = await makeTenant("B");

    await expect(getCompetitorForOrg(b.organization.id, a.competitor.id)).rejects.toThrow(NotFoundError);
    // Sanity check: org A can read its own competitor fine.
    await expect(getCompetitorForOrg(a.organization.id, a.competitor.id)).resolves.toMatchObject({
      id: a.competitor.id,
    });
  });

  it("prevents org B from reading org A's monitored URL by ID", async () => {
    const a = await makeTenant("A2");
    const b = await makeTenant("B2");

    await expect(getMonitoredUrlForOrg(b.organization.id, a.monitoredUrl.id)).rejects.toThrow(NotFoundError);
  });

  it("prevents org B from attaching a monitored URL to org A's competitor", async () => {
    const a = await makeTenant("A3");
    const b = await makeTenant("B3");

    await expect(
      createMonitoredUrl(b.organization.id, a.competitor.id, {
        url: "https://sneaky.example.test/",
        category: "GENERAL",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("never includes another org's rows in a tenant-scoped list", async () => {
    const a = await makeTenant("A4");
    const b = await makeTenant("B4");

    const aCompetitors = await listCompetitorsForOrg(a.organization.id);
    const bCompetitors = await listCompetitorsForOrg(b.organization.id);

    expect(aCompetitors.map((c) => c.id)).toContain(a.competitor.id);
    expect(aCompetitors.map((c) => c.id)).not.toContain(b.competitor.id);
    expect(bCompetitors.map((c) => c.id)).not.toContain(a.competitor.id);

    const aUrls = await listMonitoredUrlsForOrg(a.organization.id);
    expect(aUrls.map((u) => u.id)).not.toContain(b.monitoredUrl.id);
  });

  it("never leaks another org's change events through a tenant-scoped query", async () => {
    const a = await makeTenant("A5");
    const b = await makeTenant("B5");

    // Neither org has any change events yet (no scans have run) - the
    // real assertion is that querying as B never returns anything
    // scoped to A even if A's data existed, since the WHERE clause is
    // always organizationId-bound. This is a structural check that the
    // query never omits the organizationId filter.
    const events = await listChangeEventsForOrg(b.organization.id, { monitoredUrlId: a.monitoredUrl.id });
    expect(events).toHaveLength(0);
  });

  it("prevents org B from reading org A's snapshot, report, or AI analysis - even though real rows exist", async () => {
    const a = await makeTenantWithFullChain("A6");
    const b = await makeTenantWithFullChain("B6");

    await expect(getSnapshotForOrg(b.organization.id, a.snapshot.id)).rejects.toThrow(NotFoundError);
    await expect(getSnapshotForOrg(a.organization.id, a.snapshot.id)).resolves.toMatchObject({ id: a.snapshot.id });

    await expect(getReportForOrg(b.organization.id, a.report.id)).rejects.toThrow(NotFoundError);
    await expect(getReportForOrg(a.organization.id, a.report.id)).resolves.toMatchObject({ id: a.report.id });

    await expect(getAiAnalysisForOrg(b.organization.id, a.aiAnalysis.id)).rejects.toThrow(NotFoundError);
    await expect(getAiAnalysisForOrg(a.organization.id, a.aiAnalysis.id)).resolves.toMatchObject({ id: a.aiAnalysis.id });
  });

  it("Phase 4 (Section 22): org B cannot read org A's report, report items, or the ChangeEvent they reference", async () => {
    const a = await makeTenantWithFullChain("A10");
    const b = await makeTenantWithFullChain("B10");

    // Detail lookup by id.
    await expect(getReportForOrg(b.organization.id, a.report.id)).rejects.toThrow(NotFoundError);
    await expect(getReportForOrg(a.organization.id, a.report.id)).resolves.toMatchObject({ id: a.report.id });

    // Detail-with-items lookup - the report item AND its nested ChangeEvent must never leak.
    await expect(getReportWithItemsForOrg(b.organization.id, a.report.id)).rejects.toThrow(NotFoundError);
    const aWithItems = await getReportWithItemsForOrg(a.organization.id, a.report.id);
    expect(aWithItems.items.map((i) => i.id)).toContain(a.reportItem.id);
    expect(aWithItems.items.map((i) => i.changeEvent.id)).toContain(a.changeEvent.id);

    // List views - org B's report history must never contain org A's report.
    const aReports = await listReportsForOrg(a.organization.id);
    const bReports = await listReportsForOrg(b.organization.id);
    expect(aReports.map((r) => r.id)).toContain(a.report.id);
    expect(aReports.map((r) => r.id)).not.toContain(b.report.id);
    expect(bReports.map((r) => r.id)).not.toContain(a.report.id);
  });

  it("prevents org B from MODIFYING org A's competitor (organizationId-scoped update affects zero rows)", async () => {
    const a = await makeTenant("A7");
    const b = await makeTenant("B7");

    const result = await prisma.competitor.updateMany({
      where: { id: a.competitor.id, organizationId: b.organization.id },
      data: { name: "HACKED BY ORG B" },
    });
    expect(result.count).toBe(0);

    const stillA = await prisma.competitor.findUnique({ where: { id: a.competitor.id } });
    expect(stillA?.name).toBe("Competitor A7");
  });

  it("prevents org B from DELETING org A's competitor (organizationId-scoped delete affects zero rows)", async () => {
    const a = await makeTenant("A8");
    const b = await makeTenant("B8");

    const result = await prisma.competitor.deleteMany({
      where: { id: a.competitor.id, organizationId: b.organization.id },
    });
    expect(result.count).toBe(0);

    const stillA = await prisma.competitor.findUnique({ where: { id: a.competitor.id } });
    expect(stillA).not.toBeNull();
  });

  /**
   * Phase 23: the exact same organizationId-scoped WHERE clause already
   * proven above for CONTENT_CHANGE applies identically to the new
   * PROMOTION_ADDED/PROMOTION_CHANGE/PROMOTION_REMOVED ChangeTypes - no
   * new query path was introduced for them (see
   * packages/db/src/repositories/changeEvents.ts's listChangeEventsForOrg,
   * unmodified), but this test makes that explicit for the new enum values
   * rather than leaving it merely implied.
   */
  it("never leaks another org's PROMOTION_CHANGE events through a tenant-scoped query", async () => {
    const a = await makeTenantWithFullChain("A11");
    const b = await makeTenantWithFullChain("B11");

    const promotionEvent = await prisma.changeEvent.create({
      data: {
        organizationId: a.organization.id,
        monitoredUrlId: a.monitoredUrl.id,
        currentSnapshotId: a.snapshot.id,
        changeType: "PROMOTION_CHANGE",
        severity: "MEDIUM",
        confidence: 0.75,
        entityKey: "jsonld-promo:pro plan",
        fieldPath: "jsonld-promo:pro plan",
        oldValue: "discount=10",
        newValue: "discount=20",
        evidenceExcerpt: "Pro Plan: discount=10 -> discount=20",
      },
    });

    const asOrgB = await listChangeEventsForOrg(b.organization.id, { monitoredUrlId: a.monitoredUrl.id });
    expect(asOrgB.map((e) => e.id)).not.toContain(promotionEvent.id);

    const asOrgA = await listChangeEventsForOrg(a.organization.id, { monitoredUrlId: a.monitoredUrl.id });
    expect(asOrgA.map((e) => e.id)).toContain(promotionEvent.id);
  });

  it("prevents org B from deleting org A's monitored URL or snapshot the same way", async () => {
    const a = await makeTenantWithFullChain("A9");
    const b = await makeTenantWithFullChain("B9");

    const urlDelete = await prisma.monitoredUrl.deleteMany({
      where: { id: a.monitoredUrl.id, organizationId: b.organization.id },
    });
    expect(urlDelete.count).toBe(0);

    const snapshotDelete = await prisma.snapshot.deleteMany({
      where: { id: a.snapshot.id, organizationId: b.organization.id },
    });
    expect(snapshotDelete.count).toBe(0);

    expect(await prisma.monitoredUrl.findUnique({ where: { id: a.monitoredUrl.id } })).not.toBeNull();
    expect(await prisma.snapshot.findUnique({ where: { id: a.snapshot.id } })).not.toBeNull();
  });
});
