import { afterAll, describe, expect, it } from "vitest";
import { prisma, countPrismaQueries } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor, listCompetitorsWithSummaryForOrg } from "./competitors.js";
import { createMonitoredUrl, listMonitoredUrlsWithStatusForOrg } from "./monitoredUrls.js";

/**
 * Phase 2.1 hardening (Section 4). Same real-Postgres, skip-if-
 * unreachable convention as tenantIsolation.test.ts and dashboard.test.ts.
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

describe.skipIf(!reachable)("listCompetitorsWithSummaryForOrg / listMonitoredUrlsWithStatusForOrg", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Summary ${label} ${runId}-${counter}`,
      email: `summary-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  async function createJobAndChangeEvent(
    organizationId: string,
    monitoredUrlId: string,
    options: { createdAt?: Date; detectedAt?: Date; jobStatus?: "COMPLETED" | "FAILED" } = {},
  ) {
    const job = await prisma.monitoringJob.create({
      data: {
        organizationId,
        monitoredUrlId,
        status: options.jobStatus ?? "COMPLETED",
        createdAt: options.createdAt ?? new Date(),
      },
    });
    const snapshot = await prisma.snapshot.create({
      data: {
        organizationId,
        monitoredUrlId,
        monitoringJobId: job.id,
        extractionMethod: "CHEERIO",
        verificationState: options.jobStatus === "FAILED" ? "FAILED_TO_VERIFY" : "CHANGED",
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

  describe("listCompetitorsWithSummaryForOrg", () => {
    it("returns an empty array for an organization with no competitors", async () => {
      const org = await makeOrg("NoCompetitors");
      const result = await listCompetitorsWithSummaryForOrg(org.id);
      expect(result).toEqual([]);
    });

    it("reports monitoredUrlCount correctly across multiple competitors with different numbers of URLs", async () => {
      const org = await makeOrg("MultiCompetitor");
      const compA = await createCompetitor(org.id, { name: "Comp A" });
      const compB = await createCompetitor(org.id, { name: "Comp B" });
      const compC = await createCompetitor(org.id, { name: "Comp C" }); // no URLs at all

      await createMonitoredUrl(org.id, compA.id, { url: "https://a1.example.test", category: "GENERAL" });
      await createMonitoredUrl(org.id, compA.id, { url: "https://a2.example.test", category: "GENERAL" });
      await createMonitoredUrl(org.id, compA.id, { url: "https://a3.example.test", category: "GENERAL" });
      await createMonitoredUrl(org.id, compB.id, { url: "https://b1.example.test", category: "GENERAL" });

      const result = await listCompetitorsWithSummaryForOrg(org.id);
      const byId = new Map(result.map((c) => [c.id, c]));

      expect(byId.get(compA.id)?.monitoredUrlCount).toBe(3);
      expect(byId.get(compB.id)?.monitoredUrlCount).toBe(1);
      expect(byId.get(compC.id)?.monitoredUrlCount).toBe(0);
    });

    it("reports the correct latestJob and latestChangeEvent per competitor, not mixed up across competitors", async () => {
      const org = await makeOrg("LatestPerCompetitor");
      const compA = await createCompetitor(org.id, { name: "Comp A" });
      const compB = await createCompetitor(org.id, { name: "Comp B" });
      const urlA = await createMonitoredUrl(org.id, compA.id, { url: "https://a.example.test", category: "GENERAL" });
      const urlB = await createMonitoredUrl(org.id, compB.id, { url: "https://b.example.test", category: "GENERAL" });

      const now = Date.now();
      // Older job/change for A, newer for B - if the maps got crossed,
      // this would surface as A's "latest" pointing at B's rows or vice versa.
      const { job: jobA, changeEvent: changeA } = await createJobAndChangeEvent(org.id, urlA.id, {
        createdAt: new Date(now - 60_000),
        detectedAt: new Date(now - 60_000),
      });
      const { job: jobB, changeEvent: changeB } = await createJobAndChangeEvent(org.id, urlB.id, {
        createdAt: new Date(now),
        detectedAt: new Date(now),
      });

      const result = await listCompetitorsWithSummaryForOrg(org.id);
      const byId = new Map(result.map((c) => [c.id, c]));

      expect(byId.get(compA.id)?.latestJob?.id).toBe(jobA.id);
      expect(byId.get(compA.id)?.latestChangeEvent?.id).toBe(changeA.id);
      expect(byId.get(compB.id)?.latestJob?.id).toBe(jobB.id);
      expect(byId.get(compB.id)?.latestChangeEvent?.id).toBe(changeB.id);
    });

    it("picks the most recent job/change event when a competitor's URL has more than one of each", async () => {
      const org = await makeOrg("MultiJobPerCompetitor");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://multi.example.test", category: "GENERAL" });

      const now = Date.now();
      await createJobAndChangeEvent(org.id, url.id, { createdAt: new Date(now - 120_000), detectedAt: new Date(now - 120_000) });
      const { job: latestJob, changeEvent: latestChange } = await createJobAndChangeEvent(org.id, url.id, {
        createdAt: new Date(now),
        detectedAt: new Date(now),
      });

      const result = await listCompetitorsWithSummaryForOrg(org.id);
      const summary = result.find((c) => c.id === comp.id);

      expect(summary?.latestJob?.id).toBe(latestJob.id);
      expect(summary?.latestChangeEvent?.id).toBe(latestChange.id);
    });

    it("never leaks another organization's competitors, counts, or latest job/change data", async () => {
      const orgA = await makeOrg("IsoCompA");
      const orgB = await makeOrg("IsoCompB");
      const compA = await createCompetitor(orgA.id, { name: "Secret Competitor" });
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://secret.example.test", category: "GENERAL" });
      await createJobAndChangeEvent(orgA.id, urlA.id);
      await createCompetitor(orgB.id, { name: "Org B's Own Competitor" });

      const resultB = await listCompetitorsWithSummaryForOrg(orgB.id);

      expect(resultB.some((c) => c.id === compA.id)).toBe(false);
      expect(resultB.every((c) => c.name !== "Secret Competitor")).toBe(true);
    });

    it("issues a bounded (O(1), not O(n)) number of SQL queries as the number of competitors and URLs grows", async () => {
      const org = await makeOrg("QueryCountCompetitors");
      const competitors = [];
      for (let i = 0; i < 6; i += 1) {
        const comp = await createCompetitor(org.id, { name: `Comp ${i}` });
        competitors.push(comp);
        for (let j = 0; j < 3; j += 1) {
          const url = await createMonitoredUrl(org.id, comp.id, {
            url: `https://comp${i}-url${j}.example.test`,
            category: "GENERAL",
          });
          await createJobAndChangeEvent(org.id, url.id);
        }
      }
      // 6 competitors x 3 URLs x (1 job + 1 snapshot + 1 change event) = a
      // lot of rows, but listCompetitorsWithSummaryForOrg's own query count
      // must stay flat: 1 (competitors) + 1 (urls) + 2 (jobs, changeEvents,
      // batched via `in: urlIds`) = 4, regardless of how many rows exist.
      const queryCount = await countPrismaQueries(() => listCompetitorsWithSummaryForOrg(org.id));

      expect(queryCount).toBeLessThanOrEqual(4);
      expect(queryCount).toBeGreaterThan(0); // sanity: the counter itself is wired up
    });
  });

  describe("listMonitoredUrlsWithStatusForOrg", () => {
    it("returns an empty array for a competitor with no monitored URLs", async () => {
      const org = await makeOrg("NoUrls");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const result = await listMonitoredUrlsWithStatusForOrg(org.id, comp.id);
      expect(result).toEqual([]);
    });

    it("attaches the correct latestJob, latestChangeEvent, and latestSnapshot per URL, not mixed across URLs", async () => {
      const org = await makeOrg("LatestPerUrl");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const urlA = await createMonitoredUrl(org.id, comp.id, { url: "https://url-a.example.test", category: "GENERAL" });
      const urlB = await createMonitoredUrl(org.id, comp.id, { url: "https://url-b.example.test", category: "GENERAL" });

      const now = Date.now();
      const { job: jobA, changeEvent: changeA, snapshot: snapA } = await createJobAndChangeEvent(org.id, urlA.id, {
        createdAt: new Date(now - 60_000),
        detectedAt: new Date(now - 60_000),
      });
      const { job: jobB, changeEvent: changeB, snapshot: snapB } = await createJobAndChangeEvent(org.id, urlB.id, {
        createdAt: new Date(now),
        detectedAt: new Date(now),
      });

      const result = await listMonitoredUrlsWithStatusForOrg(org.id, comp.id);
      const byId = new Map(result.map((u) => [u.id, u]));

      expect(byId.get(urlA.id)?.latestJob?.id).toBe(jobA.id);
      expect(byId.get(urlA.id)?.latestChangeEvent?.id).toBe(changeA.id);
      expect(byId.get(urlA.id)?.latestSnapshot?.id).toBe(snapA.id);
      expect(byId.get(urlB.id)?.latestJob?.id).toBe(jobB.id);
      expect(byId.get(urlB.id)?.latestChangeEvent?.id).toBe(changeB.id);
      expect(byId.get(urlB.id)?.latestSnapshot?.id).toBe(snapB.id);
    });

    it("returns the most recent job/change/snapshot when a URL has been scanned more than once", async () => {
      const org = await makeOrg("MultiScanUrl");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://multi-scan.example.test", category: "GENERAL" });

      const now = Date.now();
      await createJobAndChangeEvent(org.id, url.id, { createdAt: new Date(now - 120_000), detectedAt: new Date(now - 120_000) });
      const { job: latestJob, snapshot: latestSnapshot } = await createJobAndChangeEvent(org.id, url.id, {
        createdAt: new Date(now),
        detectedAt: new Date(now),
      });

      const result = await listMonitoredUrlsWithStatusForOrg(org.id, comp.id);
      const summary = result.find((u) => u.id === url.id);

      expect(summary?.latestJob?.id).toBe(latestJob.id);
      expect(summary?.latestSnapshot?.id).toBe(latestSnapshot.id);
    });

    it("without a competitorId filter, returns every monitored URL for the organization across all competitors", async () => {
      const org = await makeOrg("AllUrlsOrgWide");
      const compA = await createCompetitor(org.id, { name: "Comp A" });
      const compB = await createCompetitor(org.id, { name: "Comp B" });
      await createMonitoredUrl(org.id, compA.id, { url: "https://all-a.example.test", category: "GENERAL" });
      await createMonitoredUrl(org.id, compB.id, { url: "https://all-b.example.test", category: "GENERAL" });

      const result = await listMonitoredUrlsWithStatusForOrg(org.id);

      expect(result).toHaveLength(2);
    });

    it("never leaks another organization's monitored URLs or their latest job/change/snapshot data", async () => {
      const orgA = await makeOrg("IsoUrlA");
      const orgB = await makeOrg("IsoUrlB");
      const compA = await createCompetitor(orgA.id, { name: "Comp A" });
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://secret-url.example.test", category: "GENERAL" });
      await createJobAndChangeEvent(orgA.id, urlA.id);
      const compB = await createCompetitor(orgB.id, { name: "Comp B" });
      await createMonitoredUrl(orgB.id, compB.id, { url: "https://org-b-own.example.test", category: "GENERAL" });

      const resultB = await listMonitoredUrlsWithStatusForOrg(orgB.id);

      expect(resultB.some((u) => u.id === urlA.id)).toBe(false);
      expect(resultB.every((u) => u.url !== "https://secret-url.example.test")).toBe(true);
    });

    it("keeps FAILED_TO_VERIFY distinct from a genuinely CHANGED snapshot in latestSnapshot - never conflated", async () => {
      const org = await makeOrg("FailedVerifyDistinct");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://failed-verify.example.test", category: "GENERAL" });

      const { snapshot } = await createJobAndChangeEvent(org.id, url.id, { jobStatus: "FAILED" });

      const result = await listMonitoredUrlsWithStatusForOrg(org.id, comp.id);
      const summary = result.find((u) => u.id === url.id);

      expect(summary?.latestSnapshot?.id).toBe(snapshot.id);
      expect(summary?.latestSnapshot?.verificationState).toBe("FAILED_TO_VERIFY");
    });

    it("issues a bounded (O(1), not O(n)) number of SQL queries as the number of monitored URLs grows", async () => {
      const org = await makeOrg("QueryCountUrls");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      for (let i = 0; i < 15; i += 1) {
        const url = await createMonitoredUrl(org.id, comp.id, { url: `https://q${i}.example.test`, category: "GENERAL" });
        await createJobAndChangeEvent(org.id, url.id);
      }

      // 1 (urls) + 3 (jobs, changeEvents, snapshots - each batched via
      // `in: urlIds`) = 4, regardless of how many URLs exist.
      const queryCount = await countPrismaQueries(() => listMonitoredUrlsWithStatusForOrg(org.id, comp.id));

      expect(queryCount).toBeLessThanOrEqual(4);
      expect(queryCount).toBeGreaterThan(0);
    });
  });
});
