import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { getDashboardSummaryForOrg } from "./dashboard.js";

/**
 * Phase 2.1 hardening (Section 3). This suite requires a real Postgres
 * reachable via DATABASE_URL, same convention as tenantIsolation.test.ts:
 * skipped (not failed) when unreachable, so `npm test` stays green
 * without local infra, but a skip here is NOT proof of correctness.
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

describe.skipIf(!reachable)("getDashboardSummaryForOrg", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Dashboard ${label} ${runId}-${counter}`,
      email: `dashboard-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  /**
   * Builds one real job -> snapshot -> change-event chain via direct
   * Prisma writes (same rationale as tenantIsolation.test.ts: no
   * repository "create" helper exists for these yet), with an
   * overridable `detectedAt`/`createdAt` so date-window tests can place
   * rows inside or outside the dashboard's 24h/7d windows.
   */
  async function createChangeEventFixture(
    organizationId: string,
    monitoredUrlId: string,
    options: { detectedAt?: Date; jobCreatedAt?: Date; jobStatus?: "COMPLETED" | "FAILED" } = {},
  ) {
    const job = await prisma.monitoringJob.create({
      data: {
        organizationId,
        monitoredUrlId,
        status: options.jobStatus ?? "COMPLETED",
        createdAt: options.jobCreatedAt ?? new Date(),
      },
    });
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
    const changeEvent = await prisma.changeEvent.create({
      data: {
        organizationId,
        monitoredUrlId,
        currentSnapshotId: snapshot.id,
        changeType: "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.9,
        fieldPath: "product.price",
        evidenceExcerpt: "evidence",
        detectedAt: options.detectedAt ?? new Date(),
      },
    });
    return { job, snapshot, changeEvent };
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("returns all-zero counts and empty lists for a brand-new organization with no data", async () => {
    const org = await makeOrg("Empty");

    const summary = await getDashboardSummaryForOrg(org.id);

    expect(summary).toEqual({
      totalCompetitors: 0,
      totalMonitoredUrls: 0,
      scansLast24h: 0,
      changesLast7d: 0,
      recentChangeEvents: [],
      recentJobs: [],
    });
  });

  it("counts a single competitor with no monitored URLs yet", async () => {
    const org = await makeOrg("OneCompetitor");
    await createCompetitor(org.id, { name: "Comp A" });

    const summary = await getDashboardSummaryForOrg(org.id);

    expect(summary.totalCompetitors).toBe(1);
    expect(summary.totalMonitoredUrls).toBe(0);
  });

  it("counts multiple monitored URLs spread across multiple competitors", async () => {
    const org = await makeOrg("MultiUrl");
    const compA = await createCompetitor(org.id, { name: "Comp A" });
    const compB = await createCompetitor(org.id, { name: "Comp B" });
    await createMonitoredUrl(org.id, compA.id, { url: "https://a1.example.test", category: "PRICING_PAGE" });
    await createMonitoredUrl(org.id, compA.id, { url: "https://a2.example.test", category: "GENERAL" });
    await createMonitoredUrl(org.id, compB.id, { url: "https://b1.example.test", category: "PRODUCT_PAGE" });

    const summary = await getDashboardSummaryForOrg(org.id);

    expect(summary.totalCompetitors).toBe(2);
    expect(summary.totalMonitoredUrls).toBe(3);
  });

  it("counts multiple monitoring jobs (both completed and failed) within the last 24h and excludes older ones - the date window is exact, not approximate", async () => {
    const org = await makeOrg("ScanWindow");
    const comp = await createCompetitor(org.id, { name: "Comp" });
    const url = await createMonitoredUrl(org.id, comp.id, { url: "https://scan.example.test", category: "GENERAL" });

    const now = Date.now();
    const within24h = new Date(now - 2 * 60 * 60 * 1000); // 2h ago
    const justInsideWindow = new Date(now - 23 * 60 * 60 * 1000); // 23h ago
    const justOutsideWindow = new Date(now - 25 * 60 * 60 * 1000); // 25h ago
    const wayOutside = new Date(now - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    await prisma.monitoringJob.create({
      data: { organizationId: org.id, monitoredUrlId: url.id, status: "COMPLETED", createdAt: within24h },
    });
    await prisma.monitoringJob.create({
      data: { organizationId: org.id, monitoredUrlId: url.id, status: "FAILED", createdAt: justInsideWindow },
    });
    await prisma.monitoringJob.create({
      data: { organizationId: org.id, monitoredUrlId: url.id, status: "COMPLETED", createdAt: justOutsideWindow },
    });
    await prisma.monitoringJob.create({
      data: { organizationId: org.id, monitoredUrlId: url.id, status: "COMPLETED", createdAt: wayOutside },
    });

    const summary = await getDashboardSummaryForOrg(org.id);

    expect(summary.scansLast24h).toBe(2);
  });

  it("recentJobs includes both completed and failed-verification jobs, most recent first, capped at 10, with monitoredUrl details attached", async () => {
    const org = await makeOrg("RecentJobs");
    const comp = await createCompetitor(org.id, { name: "Comp" });
    const url = await createMonitoredUrl(org.id, comp.id, {
      url: "https://recent-jobs.example.test",
      category: "GENERAL",
      label: "Recent Jobs Target",
    });

    const now = Date.now();
    // 12 jobs spread a minute apart - only the 10 most recent should come back.
    const jobs = [];
    for (let i = 0; i < 12; i += 1) {
      jobs.push(
        await prisma.monitoringJob.create({
          data: {
            organizationId: org.id,
            monitoredUrlId: url.id,
            status: i % 2 === 0 ? "COMPLETED" : "FAILED",
            createdAt: new Date(now - (12 - i) * 60_000),
          },
        }),
      );
    }
    const mostRecentJob = jobs[jobs.length - 1];

    const summary = await getDashboardSummaryForOrg(org.id);

    expect(summary.recentJobs).toHaveLength(10);
    expect(summary.recentJobs[0]?.id).toBe(mostRecentJob?.id);
    expect(summary.recentJobs.map((j) => j.status)).toContain("FAILED");
    expect(summary.recentJobs.map((j) => j.status)).toContain("COMPLETED");
    expect(summary.recentJobs[0]?.monitoredUrl).toEqual({
      url: "https://recent-jobs.example.test",
      label: "Recent Jobs Target",
      competitorId: comp.id,
    });
    // Jobs must be strictly newest-first.
    const timestamps = summary.recentJobs.map((j) => j.createdAt.getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("counts change events within the last 7 days and excludes older ones", async () => {
    const org = await makeOrg("ChangeWindow");
    const comp = await createCompetitor(org.id, { name: "Comp" });
    const url = await createMonitoredUrl(org.id, comp.id, { url: "https://changes.example.test", category: "GENERAL" });

    const now = Date.now();
    await createChangeEventFixture(org.id, url.id, { detectedAt: new Date(now - 1 * 24 * 60 * 60 * 1000) }); // 1d ago
    await createChangeEventFixture(org.id, url.id, { detectedAt: new Date(now - 6 * 24 * 60 * 60 * 1000) }); // 6d ago
    await createChangeEventFixture(org.id, url.id, { detectedAt: new Date(now - 8 * 24 * 60 * 60 * 1000) }); // 8d ago, outside window
    await createChangeEventFixture(org.id, url.id, { detectedAt: new Date(now - 30 * 24 * 60 * 60 * 1000) }); // 30d ago

    const summary = await getDashboardSummaryForOrg(org.id);

    expect(summary.changesLast7d).toBe(2);
  });

  it("recentChangeEvents returns at most the 5 most recent events, newest first, regardless of how many exist total", async () => {
    const org = await makeOrg("RecentChanges");
    const comp = await createCompetitor(org.id, { name: "Comp" });
    const url = await createMonitoredUrl(org.id, comp.id, { url: "https://many-changes.example.test", category: "GENERAL" });

    const now = Date.now();
    const created = [];
    for (let i = 0; i < 8; i += 1) {
      const { changeEvent } = await createChangeEventFixture(org.id, url.id, {
        detectedAt: new Date(now - (8 - i) * 60_000),
      });
      created.push(changeEvent);
    }
    const mostRecent = created[created.length - 1];

    const summary = await getDashboardSummaryForOrg(org.id);

    expect(summary.recentChangeEvents).toHaveLength(5);
    expect(summary.recentChangeEvents[0]?.id).toBe(mostRecent?.id);
  });

  it("tenant isolation: an organization with a full data set never leaks into another organization's summary", async () => {
    const orgWithData = await makeOrg("HasData");
    const emptyOrg = await makeOrg("StillEmpty");

    const comp = await createCompetitor(orgWithData.id, { name: "Comp" });
    const url = await createMonitoredUrl(orgWithData.id, comp.id, {
      url: "https://isolated.example.test",
      category: "GENERAL",
    });
    await createChangeEventFixture(orgWithData.id, url.id);
    await prisma.monitoringJob.create({
      data: { organizationId: orgWithData.id, monitoredUrlId: url.id, status: "COMPLETED" },
    });

    const summaryWithData = await getDashboardSummaryForOrg(orgWithData.id);
    const summaryEmpty = await getDashboardSummaryForOrg(emptyOrg.id);

    expect(summaryWithData.totalCompetitors).toBeGreaterThan(0);
    expect(summaryEmpty).toEqual({
      totalCompetitors: 0,
      totalMonitoredUrls: 0,
      scansLast24h: 0,
      changesLast7d: 0,
      recentChangeEvents: [],
      recentJobs: [],
    });
  });
});
