import { afterAll, describe, expect, it } from "vitest";
import { prisma, countPrismaQueries } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import {
  compareCompetitors,
  getCompetitorActivityMetrics,
  getOrgActivityMetrics,
  getPriceHistoryForCompetitor,
  getProductLifecycleSummary,
} from "./intelligence.js";
import type { ChangeType } from "../../generated/client/index.js";

/**
 * Phase 6: same real-Postgres, skip-if-unreachable convention as
 * summaryQueries.test.ts / tenantIsolation.test.ts.
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

describe.skipIf(!reachable)("intelligence repository (Phase 6)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string, timezone = "UTC") {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Intel ${label} ${runId}-${counter}`,
      email: `intel-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    if (timezone !== "UTC") {
      await prisma.organization.update({ where: { id: organization.id }, data: { timezone } });
    }
    createdOrgIds.push(organization.id);
    return organization;
  }

  interface ChangeEventOptions {
    changeType?: ChangeType;
    entityKey?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    currency?: string | null;
    percentageChange?: number | null;
    detectedAt?: Date;
  }

  async function createChangeEvent(organizationId: string, monitoredUrlId: string, options: ChangeEventOptions = {}) {
    const job = await prisma.monitoringJob.create({
      data: { organizationId, monitoredUrlId, status: "COMPLETED" },
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
    return prisma.changeEvent.create({
      data: {
        organizationId,
        monitoredUrlId,
        currentSnapshotId: snapshot.id,
        changeType: options.changeType ?? "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.9,
        entityKey: options.entityKey === undefined ? "pro-plan" : options.entityKey,
        fieldPath: "product.price",
        oldValue: options.oldValue ?? "10.00",
        newValue: options.newValue ?? "12.00",
        currency: options.currency ?? "USD",
        percentageChange: options.percentageChange ?? 20,
        evidenceExcerpt: "evidence",
        detectedAt: options.detectedAt ?? new Date(),
      },
    });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  describe("getOrgActivityMetrics / getCompetitorActivityMetrics", () => {
    it("returns all-zero metrics for an organization with no ChangeEvents", async () => {
      const org = await makeOrg("NoEvents");
      const metrics = await getOrgActivityMetrics(org.id, 30);
      expect(metrics.total).toEqual({ current: 0, previous: 0, absoluteChange: 0, percentageChange: null });
      expect(metrics.byType).toEqual([]);
    });

    it("counts a single ChangeEvent within the current window and none in the previous", async () => {
      const org = await makeOrg("OneEvent");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://a.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date() });

      const metrics = await getCompetitorActivityMetrics(org.id, comp.id, 30);
      expect(metrics.total.current).toBe(1);
      expect(metrics.total.previous).toBe(0);
      expect(metrics.total.percentageChange).toBeNull();
    });

    it("splits events correctly across current vs previous 30-day windows and computes the delta", async () => {
      const org = await makeOrg("PeriodSplit");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://b.example.test", category: "GENERAL" });
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;

      // 2 events in the previous period (35, 40 days ago), 4 in current (5, 10, 15, 20 days ago)
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 35 * day) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 40 * day) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 5 * day) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 10 * day) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 15 * day) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 20 * day) });

      const metrics = await getCompetitorActivityMetrics(org.id, comp.id, 30);
      expect(metrics.total.current).toBe(4);
      expect(metrics.total.previous).toBe(2);
      expect(metrics.total.absoluteChange).toBe(2);
      expect(metrics.total.percentageChange).toBe(100);
    });

    it("breaks down counts by changeType, current vs previous, omitting types with zero in both windows", async () => {
      const org = await makeOrg("ByType");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://c.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE" });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE" });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "new-plan" });

      const metrics = await getCompetitorActivityMetrics(org.id, comp.id, 30);
      const byType = new Map(metrics.byType.map((r) => [r.changeType, r]));
      expect(byType.get("PRICE_CHANGE")?.current).toBe(2);
      expect(byType.get("PRODUCT_ADDED")?.current).toBe(1);
      expect(byType.has("PRODUCT_REMOVED")).toBe(false); // zero in both windows -> omitted
      expect(byType.has("CONTENT_CHANGE")).toBe(false);
    });

    it("returns all-zero metrics for a competitor id that does not belong to the organization (no cross-tenant leak, no crash)", async () => {
      const orgA = await makeOrg("XTenantA");
      const orgB = await makeOrg("XTenantB");
      const compA = await createCompetitor(orgA.id, { name: "Secret" });
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://secret.example.test", category: "GENERAL" });
      await createChangeEvent(orgA.id, urlA.id);

      const metrics = await getCompetitorActivityMetrics(orgB.id, compA.id, 30);
      expect(metrics.total).toEqual({ current: 0, previous: 0, absoluteChange: 0, percentageChange: null });
    });

    it("never counts another organization's ChangeEvents in an org-wide metric", async () => {
      const orgA = await makeOrg("OrgWideA");
      const orgB = await makeOrg("OrgWideB");
      const compA = await createCompetitor(orgA.id, { name: "A's competitor" });
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://orgwide-a.example.test", category: "GENERAL" });
      await createChangeEvent(orgA.id, urlA.id);
      await createChangeEvent(orgA.id, urlA.id);

      const metricsB = await getOrgActivityMetrics(orgB.id, 30);
      expect(metricsB.total.current).toBe(0);
    });

    it("issues a bounded, small number of queries regardless of how many ChangeEvents exist", async () => {
      const org = await makeOrg("QueryCount");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://qc.example.test", category: "GENERAL" });
      for (let i = 0; i < 10; i += 1) {
        await createChangeEvent(org.id, url.id, { entityKey: `plan-${i}` });
      }

      // 1 (monitoredUrl lookup) + 2 (groupBy current, groupBy previous) = 3
      const queryCount = await countPrismaQueries(() => getCompetitorActivityMetrics(org.id, comp.id, 30));
      expect(queryCount).toBeLessThanOrEqual(3);
    });
  });

  describe("getProductLifecycleSummary", () => {
    it("reports zero added/removed when there are none", async () => {
      const org = await makeOrg("NoLifecycle");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const summary = await getProductLifecycleSummary(org.id, comp.id, 30);
      expect(summary.added.current).toBe(0);
      expect(summary.removed.current).toBe(0);
    });

    it("counts PRODUCT_ADDED and PRODUCT_REMOVED independently from PRICE_CHANGE", async () => {
      const org = await makeOrg("Lifecycle");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://d.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "new-1" });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "new-2" });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_REMOVED", entityKey: "old-1" });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE" });

      const summary = await getProductLifecycleSummary(org.id, comp.id, 30);
      expect(summary.added.current).toBe(2);
      expect(summary.removed.current).toBe(1);
    });
  });

  describe("getPriceHistoryForCompetitor", () => {
    it("returns an empty array when there are no PRICE_CHANGE events", async () => {
      const org = await makeOrg("NoPriceHistory");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const result = await getPriceHistoryForCompetitor(org.id, comp.id);
      expect(result).toEqual([]);
    });

    it("groups price changes into a series by (monitoredUrlId, entityKey)", async () => {
      const org = await makeOrg("PriceSeries");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://e.example.test", category: "PRICING_PAGE" });

      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", oldValue: "10.00", newValue: "12.00", detectedAt: new Date(Date.now() - 2000) });
      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", oldValue: "12.00", newValue: "15.00", detectedAt: new Date(Date.now() - 1000) });
      await createChangeEvent(org.id, url.id, { entityKey: "basic-plan", oldValue: "5.00", newValue: "6.00" });

      const result = await getPriceHistoryForCompetitor(org.id, comp.id);
      expect(result).toHaveLength(2);

      const proSeries = result.find((s) => s.entityKey === "pro-plan");
      expect(proSeries?.points).toHaveLength(2);
      expect(proSeries?.points[0]?.oldValue).toBe("10.00");
      expect(proSeries?.points[1]?.newValue).toBe("15.00");

      const basicSeries = result.find((s) => s.entityKey === "basic-plan");
      expect(basicSeries?.points).toHaveLength(1);
    });

    it("excludes PRICE_CHANGE events with a null entityKey - no fabricated series identity", async () => {
      const org = await makeOrg("NullEntityKey");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://f.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { entityKey: null });

      const result = await getPriceHistoryForCompetitor(org.id, comp.id);
      expect(result).toEqual([]);
    });

    it("excludes non-PRICE_CHANGE events even if they carry an entityKey", async () => {
      const org = await makeOrg("NonPriceExcluded");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://g.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "new-1" });

      const result = await getPriceHistoryForCompetitor(org.id, comp.id);
      expect(result).toEqual([]);
    });

    it("keeps series from two different monitored URLs of the same competitor separate, even with the same entityKey", async () => {
      const org = await makeOrg("SameKeyDiffUrl");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const urlA = await createMonitoredUrl(org.id, comp.id, { url: "https://h1.example.test", category: "GENERAL" });
      const urlB = await createMonitoredUrl(org.id, comp.id, { url: "https://h2.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, urlA.id, { entityKey: "pro-plan" });
      await createChangeEvent(org.id, urlB.id, { entityKey: "pro-plan" });

      const result = await getPriceHistoryForCompetitor(org.id, comp.id);
      expect(result).toHaveLength(2);
      expect(new Set(result.map((s) => s.monitoredUrlId)).size).toBe(2);
    });

    it("never leaks another organization's price history", async () => {
      const orgA = await makeOrg("PriceIsoA");
      const orgB = await makeOrg("PriceIsoB");
      const compA = await createCompetitor(orgA.id, { name: "Secret" });
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://price-secret.example.test", category: "GENERAL" });
      await createChangeEvent(orgA.id, urlA.id, { entityKey: "secret-plan" });

      const resultForB = await getPriceHistoryForCompetitor(orgB.id, compA.id);
      expect(resultForB).toEqual([]);
    });
  });

  describe("compareCompetitors", () => {
    it("returns an empty array for an empty competitorIds list", async () => {
      const org = await makeOrg("CompareEmpty");
      const result = await compareCompetitors(org.id, [], 30);
      expect(result).toEqual([]);
    });

    it("returns one descriptive row per competitor with independent counts, no ranking/ordering imposed", async () => {
      const org = await makeOrg("CompareBasic");
      const compA = await createCompetitor(org.id, { name: "Comp A" });
      const compB = await createCompetitor(org.id, { name: "Comp B" });
      const urlA = await createMonitoredUrl(org.id, compA.id, { url: "https://cmp-a.example.test", category: "GENERAL" });
      const urlB = await createMonitoredUrl(org.id, compB.id, { url: "https://cmp-b.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, urlA.id, { changeType: "PRICE_CHANGE" });
      await createChangeEvent(org.id, urlA.id, { changeType: "PRICE_CHANGE" });
      await createChangeEvent(org.id, urlB.id, { changeType: "PRODUCT_ADDED", entityKey: "b-new" });

      const result = await compareCompetitors(org.id, [compA.id, compB.id], 30);
      const byId = new Map(result.map((r) => [r.competitorId, r]));

      expect(byId.get(compA.id)?.priceChanges.current).toBe(2);
      expect(byId.get(compA.id)?.totalChanges.current).toBe(2);
      expect(byId.get(compB.id)?.productsAdded.current).toBe(1);
      expect(byId.get(compB.id)?.totalChanges.current).toBe(1);
    });

    it("silently drops a competitorId that does not belong to the organization instead of leaking or crashing", async () => {
      const orgA = await makeOrg("CompareXTenantA");
      const orgB = await makeOrg("CompareXTenantB");
      const compA = await createCompetitor(orgA.id, { name: "A only" });
      const compB = await createCompetitor(orgB.id, { name: "B's own" });

      const result = await compareCompetitors(orgB.id, [compA.id, compB.id], 30);
      expect(result).toHaveLength(1);
      expect(result[0]?.competitorId).toBe(compB.id);
    });
  });
});
