import { afterAll, describe, expect, it } from "vitest";
import { prisma, countPrismaQueries } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import {
  compareCompetitors,
  getCompetitiveContext,
  getCompetitorActivityMetrics,
  getDigestForOrganization,
  getOrgActivityMetrics,
  getPriceHistoryForCompetitor,
  getProductLifecycleSummary,
  type ChangeEventDigestItem,
  type LifecycleDigestItem,
} from "./intelligence.js";
import type { ChangeType } from "../../generated/client/index.js";

const DAY = 24 * 60 * 60 * 1000;

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

  describe("getCompetitiveContext (Phase 8)", () => {
    async function makeCompetitor(orgId: string, name: string, createdAt?: Date) {
      const competitor = await createCompetitor(orgId, { name });
      if (createdAt) {
        await prisma.competitor.update({ where: { id: competitor.id }, data: { createdAt } });
      }
      return competitor;
    }

    it("returns an empty array for an empty competitorIds list", async () => {
      const org = await makeOrg("ContextEmpty");
      const result = await getCompetitiveContext(org.id, [], 30);
      expect(result).toEqual([]);
    });

    it("returns one row per competitor (one, two, and multiple competitors), each carrying compareCompetitors' base fields plus the pattern extension", async () => {
      const org = await makeOrg("ContextMulti");
      const compA = await makeCompetitor(org.id, "Ctx A");
      const compB = await makeCompetitor(org.id, "Ctx B");
      const compC = await makeCompetitor(org.id, "Ctx C");
      const urlA = await createMonitoredUrl(org.id, compA.id, { url: "https://ctx-a.example.test", category: "GENERAL" });
      await createMonitoredUrl(org.id, compB.id, { url: "https://ctx-b.example.test", category: "GENERAL" });
      await createMonitoredUrl(org.id, compC.id, { url: "https://ctx-c.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, urlA.id, { changeType: "PRICE_CHANGE" });

      const oneResult = await getCompetitiveContext(org.id, [compA.id], 30);
      expect(oneResult).toHaveLength(1);

      const twoResult = await getCompetitiveContext(org.id, [compA.id, compB.id], 30);
      expect(twoResult).toHaveLength(2);

      const allResult = await getCompetitiveContext(org.id, [compA.id, compB.id, compC.id], 30);
      expect(allResult).toHaveLength(3);
      for (const row of allResult) {
        expect(row).toHaveProperty("activityPattern");
        expect(row).toHaveProperty("qualifyingRepeatedPriceChangeCount");
        expect(row).toHaveProperty("latestChangeEventId");
      }
      // Order matches the caller's own competitorIds order - no ranking/reordering imposed.
      expect(allResult.map((r) => r.competitorId)).toEqual([compA.id, compB.id, compC.id]);
    });

    it("reports different history ages honestly: a fresh competitor is INSUFFICIENT_HISTORY, a long-tracked one qualifies - neither is hidden", async () => {
      const org = await makeOrg("ContextHistoryAges");
      const fresh = await makeCompetitor(org.id, "Fresh Co"); // default createdAt (today)
      const established = await makeCompetitor(org.id, "Established Co", new Date(Date.now() - 150 * DAY));
      const freshUrl = await createMonitoredUrl(org.id, fresh.id, { url: "https://fresh.example.test", category: "GENERAL" });
      const establishedUrl = await createMonitoredUrl(org.id, established.id, { url: "https://established.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, freshUrl.id, { detectedAt: new Date(Date.now() - 5 * DAY) });

      // Established: 1/window baseline (3 historical windows), current = 4 -> ABOVE_BASELINE, qualifies.
      for (const daysAgo of [45, 75, 105]) {
        await createChangeEvent(org.id, establishedUrl.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `baseline-${daysAgo}` });
      }
      for (const daysAgo of [1, 5, 10, 20]) {
        await createChangeEvent(org.id, establishedUrl.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `current-${daysAgo}` });
      }

      const result = await getCompetitiveContext(org.id, [fresh.id, established.id], 30);
      const byId = new Map(result.map((r) => [r.competitorId, r]));

      const freshRow = byId.get(fresh.id);
      expect(freshRow?.activityPattern.qualifies).toBe(false);
      expect(freshRow?.activityPattern.direction).toBe("INSUFFICIENT_HISTORY");
      // Insufficient history must remain VISIBLE with its true (non-zero-in-current-window) data, never silently dropped.
      expect(freshRow).toBeDefined();

      const establishedRow = byId.get(established.id);
      expect(establishedRow?.activityPattern.qualifies).toBe(true);
      expect(establishedRow?.activityPattern.direction).toBe("ABOVE_BASELINE");
      expect(establishedRow?.activityPattern.qualifyingWindows).toBe(3);
    });

    it("exposes all four ActivityPattern direction states across different competitors, using getActivityPattern verbatim (no re-derived formula)", async () => {
      const org = await makeOrg("ContextDirections");
      const insufficient = await makeCompetitor(org.id, "Insufficient Co");
      const above = await makeCompetitor(org.id, "Above Co", new Date(Date.now() - 150 * DAY));
      const at = await makeCompetitor(org.id, "At Co", new Date(Date.now() - 150 * DAY));
      const below = await makeCompetitor(org.id, "Below Co", new Date(Date.now() - 150 * DAY));

      const insufficientUrl = await createMonitoredUrl(org.id, insufficient.id, { url: "https://insuff.example.test", category: "GENERAL" });
      const aboveUrl = await createMonitoredUrl(org.id, above.id, { url: "https://above.example.test", category: "GENERAL" });
      const atUrl = await createMonitoredUrl(org.id, at.id, { url: "https://at.example.test", category: "GENERAL" });
      const belowUrl = await createMonitoredUrl(org.id, below.id, { url: "https://below.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, insufficientUrl.id, { detectedAt: new Date(Date.now() - 2 * DAY) });

      // above: baseline 1/window, current 4 -> ratio 4.0 >= 1.5
      for (const daysAgo of [45, 75, 105]) await createChangeEvent(org.id, aboveUrl.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `a-${daysAgo}` });
      for (const daysAgo of [1, 5, 10, 20]) await createChangeEvent(org.id, aboveUrl.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `ac-${daysAgo}` });

      // at: baseline 2/window, current 2 -> ratio 1.0
      for (const daysAgo of [40, 50, 70, 80, 100, 110]) await createChangeEvent(org.id, atUrl.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `t-${daysAgo}` });
      for (const daysAgo of [3, 10]) await createChangeEvent(org.id, atUrl.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `tc-${daysAgo}` });

      // below: baseline 4/window, current 0 -> ratio 0
      for (const daysAgo of [32, 35, 38, 41, 62, 65, 68, 71, 92, 95, 98, 101]) {
        await createChangeEvent(org.id, belowUrl.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `b-${daysAgo}` });
      }

      const result = await getCompetitiveContext(org.id, [insufficient.id, above.id, at.id, below.id], 30);
      const byId = new Map(result.map((r) => [r.competitorId, r]));

      expect(byId.get(insufficient.id)?.activityPattern.direction).toBe("INSUFFICIENT_HISTORY");
      expect(byId.get(above.id)?.activityPattern.direction).toBe("ABOVE_BASELINE");
      expect(byId.get(at.id)?.activityPattern.direction).toBe("AT_BASELINE");
      expect(byId.get(below.id)?.activityPattern.direction).toBe("BELOW_BASELINE");
    });

    it("counts only QUALIFYING repeated price-change entities (>= 2 changes), never a single change treated as repeated", async () => {
      const org = await makeOrg("ContextRepeated");
      const comp = await makeCompetitor(org.id, "Repeat Co");
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://repeat.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "solo-plan" }); // only 1 - must not count
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "repeat-plan" });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "repeat-plan" });

      const [row] = await getCompetitiveContext(org.id, [comp.id], 30);
      expect(row?.qualifyingRepeatedPriceChangeCount).toBe(1);
    });

    it("exposes the latest ChangeEvent's id (evidence traceability), matching compareCompetitors' own latestChangeAt date", async () => {
      const org = await makeOrg("ContextEvidence");
      const comp = await makeCompetitor(org.id, "Evidence Co");
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://evidence.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { detectedAt: new Date(Date.now() - 10 * DAY) });
      const latest = await createChangeEvent(org.id, url.id, { detectedAt: new Date(Date.now() - 1 * DAY) });

      const [row] = await getCompetitiveContext(org.id, [comp.id], 30);
      expect(row?.latestChangeEventId).toBe(latest.id);
      expect(row?.latestChangeAt?.getTime()).toBe(latest.detectedAt.getTime());
    });

    it("returns null latestChangeEventId (not a crash, not a fabricated id) when a competitor has no ChangeEvents at all", async () => {
      const org = await makeOrg("ContextNoEvents");
      const comp = await makeCompetitor(org.id, "No Events Co");
      await createMonitoredUrl(org.id, comp.id, { url: "https://noevents.example.test", category: "GENERAL" });

      const [row] = await getCompetitiveContext(org.id, [comp.id], 30);
      expect(row?.latestChangeEventId).toBeNull();
      expect(row?.latestChangeAt).toBeNull();
      expect(row?.activityPattern.direction).toBe("INSUFFICIENT_HISTORY");
      expect(row?.qualifyingRepeatedPriceChangeCount).toBe(0);
    });

    it("silently drops a competitorId that does not belong to the organization - no cross-tenant pattern/repeated-price leak", async () => {
      const orgA = await makeOrg("ContextXTenantA");
      const orgB = await makeOrg("ContextXTenantB");
      const compA = await makeCompetitor(orgA.id, "A only", new Date(Date.now() - 150 * DAY));
      const compB = await makeCompetitor(orgB.id, "B's own");
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://xtenant-a.example.test", category: "GENERAL" });

      // Heavy above-baseline activity in Org A - must never surface for Org B, even when Org B's
      // request includes Org A's competitorId.
      for (const daysAgo of [1, 2, 3, 4, 5, 6, 7, 8]) {
        await createChangeEvent(orgA.id, urlA.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `xt-${daysAgo}` });
      }

      const result = await getCompetitiveContext(orgB.id, [compA.id, compB.id], 30);
      expect(result).toHaveLength(1);
      expect(result[0]?.competitorId).toBe(compB.id);
    });

    it("issues a query count bounded by the number of SELECTED competitors, not by event volume per competitor", async () => {
      const org = await makeOrg("ContextQueryBound");
      const comp = await makeCompetitor(org.id, "QC Co");
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://qc-ctx.example.test", category: "GENERAL" });
      for (let i = 0; i < 15; i += 1) {
        await createChangeEvent(org.id, url.id, { entityKey: `plan-${i}` });
      }

      const queryCount = await countPrismaQueries(() => getCompetitiveContext(org.id, [comp.id], 30));
      // Bounded: compareCompetitors (competitor lookup + per-competitor activity+latest) plus
      // getActivityPattern + getRepeatedPriceChangePatterns + the new latest-event-with-id lookup,
      // all for exactly 1 competitor - not proportional to the 15 ChangeEvents created above.
      expect(queryCount).toBeLessThanOrEqual(16);
    });
  });

  describe("getDigestForOrganization (Phase 10)", () => {
    async function makeCompetitor(orgId: string, name: string, createdAt?: Date) {
      const competitor = await createCompetitor(orgId, { name });
      if (createdAt) {
        await prisma.competitor.update({ where: { id: competitor.id }, data: { createdAt } });
      }
      return competitor;
    }

    it("returns an empty digest for an organization with zero competitors", async () => {
      const org = await makeOrg("DigestNoCompetitors");
      const result = await getDigestForOrganization(org.id, 30);
      expect(result.items).toEqual([]);
      expect(result.totalTrackedCompetitors).toBe(0);
      expect(result.crossCompetitorContext).toEqual({ aboveBaselineCount: 0, totalTrackedCompetitors: 0 });
    });

    it("returns an empty digest for an organization with competitors but zero ChangeEvents", async () => {
      const org = await makeOrg("DigestNoEvents");
      await makeCompetitor(org.id, "Quiet Co");
      const result = await getDigestForOrganization(org.id, 30);
      expect(result.items).toEqual([]);
      expect(result.totalTrackedCompetitors).toBe(1);
    });

    it("surfaces raw ChangeEvents as CHANGE_EVENT items for a freshly-tracked competitor (no qualifying pattern yet)", async () => {
      const org = await makeOrg("DigestRawChanges");
      const comp = await makeCompetitor(org.id, "Fresh Digest Co"); // default createdAt (today) - can never qualify a pattern
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://digest-fresh.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", detectedAt: new Date(Date.now() - 1 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "CONTENT_CHANGE", entityKey: null, detectedAt: new Date(Date.now() - 2 * DAY) });

      const result = await getDigestForOrganization(org.id, 30);

      const changeItems = result.items.filter((i): i is ChangeEventDigestItem => i.kind === "CHANGE_EVENT");
      expect(changeItems).toHaveLength(2);
      for (const item of changeItems) {
        expect(item.changeEventIds).toEqual([item.changeEventId]);
        expect(item.competitorId).toBe(comp.id);
      }
      // No pattern item yet - the competitor was created today, so getActivityPattern is INSUFFICIENT_HISTORY.
      expect(result.items.some((i) => i.kind === "ACTIVITY_PATTERN")).toBe(false);
      expect(result.crossCompetitorContext).toEqual({ aboveBaselineCount: 0, totalTrackedCompetitors: 1 });
    });

    it("includes an ACTIVITY_PATTERN item only once the pattern qualifies, with real evidence event ids", async () => {
      const org = await makeOrg("DigestPatternQualifies");
      const comp = await makeCompetitor(org.id, "Established Digest Co", new Date(Date.now() - 150 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://digest-established.example.test", category: "GENERAL" });

      // Baseline: 1/window across 3 historical windows.
      for (const daysAgo of [45, 75, 105]) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `baseline-${daysAgo}` });
      }
      // Current window: 4 events -> ratio 4.0 >= 1.5 -> ABOVE_BASELINE.
      for (const daysAgo of [1, 5, 10, 20]) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `current-${daysAgo}` });
      }

      const result = await getDigestForOrganization(org.id, 30);
      const patternItems = result.items.filter((i) => i.kind === "ACTIVITY_PATTERN");
      expect(patternItems).toHaveLength(1);
      const patternItem = patternItems[0]!;
      if (patternItem.kind !== "ACTIVITY_PATTERN") throw new Error("unreachable");
      expect(patternItem.pattern.qualifies).toBe(true);
      expect(patternItem.pattern.direction).toBe("ABOVE_BASELINE");
      expect(patternItem.changeEventIds).toHaveLength(4); // exactly the 4 current-window events, never the baseline ones
      expect(result.crossCompetitorContext).toEqual({ aboveBaselineCount: 1, totalTrackedCompetitors: 1 });
    });

    it("includes a REPEATED_PRICE_CHANGE item only for entities meeting the qualifying threshold (>= 2 price changes)", async () => {
      const org = await makeOrg("DigestRepeatedPrice");
      const comp = await makeCompetitor(org.id, "Repeat Digest Co");
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://digest-repeat.example.test", category: "GENERAL" });
      // "pro-plan" changes price twice - qualifies. "basic-plan" changes once - does not.
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "pro-plan", detectedAt: new Date(Date.now() - 10 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "pro-plan", detectedAt: new Date(Date.now() - 2 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "basic-plan", detectedAt: new Date(Date.now() - 5 * DAY) });

      const result = await getDigestForOrganization(org.id, 30);
      const repeatedItems = result.items.filter((i) => i.kind === "REPEATED_PRICE_CHANGE");
      expect(repeatedItems).toHaveLength(1);
      const repeatedItem = repeatedItems[0]!;
      if (repeatedItem.kind !== "REPEATED_PRICE_CHANGE") throw new Error("unreachable");
      expect(repeatedItem.pattern.entityKey).toBe("pro-plan");
      expect(repeatedItem.pattern.changeCount).toBe(2);
      expect(repeatedItem.changeEventIds).toHaveLength(2);
      // 3 raw CHANGE_EVENT items still appear regardless (never hidden by the pattern layer).
      expect(result.items.filter((i) => i.kind === "CHANGE_EVENT")).toHaveLength(3);
    });

    it("includes a LIFECYCLE item with correct added/removed counts and evidence, only when something was added or removed", async () => {
      const org = await makeOrg("DigestLifecycle");
      const comp = await makeCompetitor(org.id, "Lifecycle Digest Co");
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://digest-lifecycle.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "new-plan-1", detectedAt: new Date(Date.now() - 3 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "new-plan-2", detectedAt: new Date(Date.now() - 2 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_REMOVED", entityKey: "old-plan", detectedAt: new Date(Date.now() - 1 * DAY) });

      const result = await getDigestForOrganization(org.id, 30);
      const lifecycleItems = result.items.filter((i): i is LifecycleDigestItem => i.kind === "LIFECYCLE");
      expect(lifecycleItems).toHaveLength(1);
      expect(lifecycleItems[0]!.added).toBe(2);
      expect(lifecycleItems[0]!.removed).toBe(1);
      expect(lifecycleItems[0]!.changeEventIds).toHaveLength(3);
    });

    it("does NOT include a LIFECYCLE item when nothing was added or removed in the window", async () => {
      const org = await makeOrg("DigestNoLifecycle");
      const comp = await makeCompetitor(org.id, "No Lifecycle Co");
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://digest-no-lifecycle.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", detectedAt: new Date(Date.now() - 1 * DAY) });

      const result = await getDigestForOrganization(org.id, 30);
      expect(result.items.some((i) => i.kind === "LIFECYCLE")).toBe(false);
    });

    it("computes the cross-competitor 'N of M above baseline' count as a plain, purely descriptive tally", async () => {
      const org = await makeOrg("DigestCrossCompetitor");
      const above = await makeCompetitor(org.id, "Above Co", new Date(Date.now() - 150 * DAY));
      const fresh = await makeCompetitor(org.id, "Fresh Co");
      const urlAbove = await createMonitoredUrl(org.id, above.id, { url: "https://digest-cc-above.example.test", category: "GENERAL" });
      await createMonitoredUrl(org.id, fresh.id, { url: "https://digest-cc-fresh.example.test", category: "GENERAL" });

      for (const daysAgo of [45, 75, 105]) {
        await createChangeEvent(org.id, urlAbove.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `b-${daysAgo}` });
      }
      for (const daysAgo of [1, 5, 10, 20]) {
        await createChangeEvent(org.id, urlAbove.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `c-${daysAgo}` });
      }

      const result = await getDigestForOrganization(org.id, 30);
      // 1 of 2 tracked competitors (fresh cannot qualify) is currently ABOVE_BASELINE.
      expect(result.crossCompetitorContext).toEqual({ aboveBaselineCount: 1, totalTrackedCompetitors: 2 });
    });

    it("excludes a deactivated (isActive: false) competitor from the tracked set entirely", async () => {
      const org = await makeOrg("DigestInactiveExcluded");
      const active = await makeCompetitor(org.id, "Active Co");
      const inactive = await makeCompetitor(org.id, "Inactive Co");
      await prisma.competitor.update({ where: { id: inactive.id }, data: { isActive: false } });
      const urlInactive = await createMonitoredUrl(org.id, inactive.id, { url: "https://digest-inactive.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, urlInactive.id, { detectedAt: new Date(Date.now() - 1 * DAY) });

      const result = await getDigestForOrganization(org.id, 30);
      expect(result.totalTrackedCompetitors).toBe(1);
      expect(result.items.every((i) => i.competitorId !== inactive.id)).toBe(true);
      void active;
    });

    it("orders items deterministically by detectedAt DESC, with a stable documented tie-break", async () => {
      const org = await makeOrg("DigestOrdering");
      const compA = await makeCompetitor(org.id, "Order A Co");
      const compB = await makeCompetitor(org.id, "Order B Co");
      const urlA = await createMonitoredUrl(org.id, compA.id, { url: "https://digest-order-a.example.test", category: "GENERAL" });
      const urlB = await createMonitoredUrl(org.id, compB.id, { url: "https://digest-order-b.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, urlA.id, { detectedAt: new Date(Date.now() - 1 * DAY) });
      await createChangeEvent(org.id, urlB.id, { detectedAt: new Date(Date.now() - 5 * DAY) });
      await createChangeEvent(org.id, urlA.id, { detectedAt: new Date(Date.now() - 10 * DAY) });

      const result = await getDigestForOrganization(org.id, 30);
      const timestamps = result.items.map((i) => i.detectedAt.getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      expect(timestamps).toEqual(sorted);
    });

    it("never returns an item with an empty changeEventIds evidence list", async () => {
      const org = await makeOrg("DigestEvidenceAlwaysPresent");
      const comp = await makeCompetitor(org.id, "Evidence Digest Co", new Date(Date.now() - 150 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://digest-evidence.example.test", category: "GENERAL" });
      for (const daysAgo of [45, 75, 105]) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `e-${daysAgo}` });
      }
      for (const daysAgo of [1, 2, 5, 10]) {
        await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "recurring-plan", detectedAt: new Date(Date.now() - daysAgo * DAY) });
      }

      const result = await getDigestForOrganization(org.id, 30);
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(item.changeEventIds.length).toBeGreaterThan(0);
      }
    });

    it("does not duplicate items of the same kind for the same competitor/evidence (one ACTIVITY_PATTERN and one LIFECYCLE item per competitor per digest call)", async () => {
      const org = await makeOrg("DigestNoDuplicateItems");
      const comp = await makeCompetitor(org.id, "No Dup Digest Co", new Date(Date.now() - 150 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://digest-no-dup.example.test", category: "GENERAL" });
      for (const daysAgo of [45, 75, 105]) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `d-${daysAgo}` });
      }
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", detectedAt: new Date(Date.now() - 1 * DAY), entityKey: "added-1" });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", detectedAt: new Date(Date.now() - 2 * DAY), entityKey: "added-2" });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", detectedAt: new Date(Date.now() - 3 * DAY), entityKey: "added-3" });

      const result = await getDigestForOrganization(org.id, 30);
      expect(result.items.filter((i) => i.kind === "ACTIVITY_PATTERN")).toHaveLength(1);
      expect(result.items.filter((i) => i.kind === "LIFECYCLE")).toHaveLength(1);
    });

    it("enforces organization isolation: another organization's digest never contains this organization's competitors or evidence", async () => {
      const orgA = await makeOrg("DigestIsoA");
      const orgB = await makeOrg("DigestIsoB");
      const compA = await makeCompetitor(orgA.id, "Iso Digest A Co", new Date(Date.now() - 150 * DAY));
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://digest-iso-a.example.test", category: "GENERAL" });
      for (const daysAgo of [1, 5, 10, 20, 45, 75, 105]) {
        await createChangeEvent(orgA.id, urlA.id, { detectedAt: new Date(Date.now() - daysAgo * DAY), entityKey: `iso-${daysAgo}` });
      }
      await makeCompetitor(orgB.id, "B Own Digest Co");

      const resultB = await getDigestForOrganization(orgB.id, 30);
      expect(resultB.totalTrackedCompetitors).toBe(1);
      expect(resultB.items).toEqual([]);
      expect(resultB.items.every((i) => i.competitorId !== compA.id)).toBe(true);

      const resultA = await getDigestForOrganization(orgA.id, 30);
      expect(resultA.crossCompetitorContext.aboveBaselineCount).toBe(1);
    });
  });
});
