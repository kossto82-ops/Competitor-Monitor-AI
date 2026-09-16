import { afterAll, describe, expect, it } from "vitest";
import { prisma, countPrismaQueries } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { getActivityPattern, getEntityHistoryForCompetitor, getRepeatedPriceChangePatterns } from "./patterns.js";
import type { ChangeType } from "../../generated/client/index.js";

/** Same real-Postgres, skip-if-unreachable convention as intelligence.test.ts. */
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
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!reachable)("patterns repository (Phase 7)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Pattern ${label} ${runId}-${counter}`,
      email: `pattern-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  async function makeCompetitor(orgId: string, name: string, createdAt?: Date) {
    const competitor = await createCompetitor(orgId, { name });
    if (createdAt) {
      await prisma.competitor.update({ where: { id: competitor.id }, data: { createdAt } });
    }
    return competitor;
  }

  interface ChangeEventOptions {
    changeType?: ChangeType;
    entityKey?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    detectedAt?: Date;
  }

  async function createChangeEvent(organizationId: string, monitoredUrlId: string, options: ChangeEventOptions = {}) {
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
        changeType: options.changeType ?? "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.9,
        entityKey: options.entityKey === undefined ? "pro-plan" : options.entityKey,
        fieldPath: "product.price",
        oldValue: options.oldValue ?? "10.00",
        newValue: options.newValue ?? "12.00",
        currency: "USD",
        percentageChange: 20,
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

  describe("getEntityHistoryForCompetitor", () => {
    it("returns an empty array when there are no entity-linked events", async () => {
      const org = await makeOrg("NoEntities");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result).toEqual([]);
    });

    it("joins PRODUCT_ADDED, PRICE_CHANGE, and PRODUCT_REMOVED events sharing an entityKey into one lifecycle", async () => {
      const org = await makeOrg("Lifecycle");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://a.example.test", category: "PRICING_PAGE" });
      const now = Date.now();

      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "pro-plan", detectedAt: new Date(now - 30 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "pro-plan", detectedAt: new Date(now - 20 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_REMOVED", entityKey: "pro-plan", detectedAt: new Date(now - 5 * DAY) });

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result).toHaveLength(1);
      const history = result[0];
      expect(history?.events).toHaveLength(3);
      expect(history?.events.map((e) => e.changeType)).toEqual(["PRODUCT_ADDED", "PRICE_CHANGE", "PRODUCT_REMOVED"]);
      expect(history?.priceChangeCount).toBe(1);
      expect(history?.currentlyDetected).toBe(false); // most recent event is PRODUCT_REMOVED
    });

    it("marks an entity as currentlyDetected when its most recent event is not a removal", async () => {
      const org = await makeOrg("StillDetected");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://b.example.test", category: "PRICING_PAGE" });

      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "basic-plan", detectedAt: new Date(Date.now() - 2000) });
      await createChangeEvent(org.id, url.id, { changeType: "PRICE_CHANGE", entityKey: "basic-plan", detectedAt: new Date(Date.now() - 1000) });

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.currentlyDetected).toBe(true);
    });

    it("excludes events with a null entityKey - no fabricated identity", async () => {
      const org = await makeOrg("NullKeyEntity");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://c.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id, { entityKey: null });

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result).toEqual([]);
    });

    it("never leaks another organization's entity history", async () => {
      const orgA = await makeOrg("XTenantA");
      const orgB = await makeOrg("XTenantB");
      const compA = await createCompetitor(orgA.id, { name: "Secret" });
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://secret.example.test", category: "GENERAL" });
      await createChangeEvent(orgA.id, urlA.id, { entityKey: "secret-plan" });

      const result = await getEntityHistoryForCompetitor(orgB.id, compA.id);
      expect(result).toEqual([]);
    });
  });

  describe("getActivityPattern", () => {
    it("returns INSUFFICIENT_HISTORY when the competitor has not been tracked long enough for a baseline", async () => {
      const org = await makeOrg("TooNew");
      const comp = await makeCompetitor(org.id, "Comp", new Date()); // created just now
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://d.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id);

      const pattern = await getActivityPattern(org.id, comp.id, 7);
      expect(pattern.qualifies).toBe(false);
      expect(pattern.direction).toBe("INSUFFICIENT_HISTORY");
      expect(pattern.baselineAverage).toBeNull();
    });

    it("qualifies and reports ABOVE_BASELINE when current activity clearly exceeds the historical average", async () => {
      const org = await makeOrg("AboveBaseline");
      // Tracked long enough for the full 3-window baseline (4*days in the past).
      const comp = await makeCompetitor(org.id, "Comp", new Date(Date.now() - 100 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://e.example.test", category: "GENERAL" });
      const now = Date.now();
      const days = 7;

      // Baseline windows (days 8-14, 15-21, 22-28 ago): 1 event each.
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 10 * DAY) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 17 * DAY) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 24 * DAY) });
      // Current window (last 7 days): 5 events.
      for (let i = 1; i <= 5; i += 1) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - i * DAY / 2) });
      }

      const pattern = await getActivityPattern(org.id, comp.id, days);
      expect(pattern.qualifies).toBe(true);
      expect(pattern.qualifyingWindows).toBe(3);
      expect(pattern.current).toBe(5);
      expect(pattern.baselineAverage).toBe(1);
      expect(pattern.direction).toBe("ABOVE_BASELINE");
      expect(pattern.strongEvidence).toBe(true);
    });

    it("flags strongEvidence=false when baseline is zero but current is not - no fabricated multiplier", async () => {
      const org = await makeOrg("ZeroBaseline");
      const comp = await makeCompetitor(org.id, "Comp", new Date(Date.now() - 100 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://f.example.test", category: "GENERAL" });
      const now = Date.now();
      // No events in any baseline window; 1 event in the current window.
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(now - 1 * DAY) });

      const pattern = await getActivityPattern(org.id, comp.id, 7);
      expect(pattern.qualifies).toBe(true);
      expect(pattern.baselineAverage).toBe(0);
      expect(pattern.ratio).toBeNull();
      expect(pattern.direction).toBe("ABOVE_BASELINE");
      expect(pattern.strongEvidence).toBe(false);
    });

    it("reports AT_BASELINE when both current and baseline are zero", async () => {
      const org = await makeOrg("BothZero");
      const comp = await makeCompetitor(org.id, "Comp", new Date(Date.now() - 100 * DAY));
      const result = await getActivityPattern(org.id, comp.id, 7);
      expect(result.qualifies).toBe(false); // no monitored URLs at all -> INSUFFICIENT_HISTORY, not a false AT_BASELINE claim
    });

    it("never leaks another organization's activity into the pattern", async () => {
      const orgA = await makeOrg("PatternXTenantA");
      const orgB = await makeOrg("PatternXTenantB");
      const compA = await makeCompetitor(orgA.id, "Secret", new Date(Date.now() - 100 * DAY));
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://secret2.example.test", category: "GENERAL" });
      await createChangeEvent(orgA.id, urlA.id);

      const pattern = await getActivityPattern(orgB.id, compA.id, 7);
      expect(pattern.qualifies).toBe(false);
      expect(pattern.current).toBe(0);
    });

    it("issues a bounded number of queries", async () => {
      const org = await makeOrg("PatternQueryCount");
      const comp = await makeCompetitor(org.id, "Comp", new Date(Date.now() - 100 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://g.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id);

      // 1 (competitor lookup) + 1 (monitoredUrl lookup) + 1 (current count) + 3 (baseline counts) = 6
      const queryCount = await countPrismaQueries(() => getActivityPattern(org.id, comp.id, 7));
      expect(queryCount).toBeLessThanOrEqual(6);
    });
  });

  describe("getRepeatedPriceChangePatterns", () => {
    it("returns an empty array when there are no price changes", async () => {
      const org = await makeOrg("NoRepeats");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const result = await getRepeatedPriceChangePatterns(org.id, comp.id, 30);
      expect(result).toEqual([]);
    });

    it("does not qualify a single price change as a repeated pattern", async () => {
      const org = await makeOrg("SingleChange");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://h.example.test", category: "PRICING_PAGE" });
      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan" });

      const result = await getRepeatedPriceChangePatterns(org.id, comp.id, 30);
      expect(result).toHaveLength(1);
      expect(result[0]?.changeCount).toBe(1);
      expect(result[0]?.qualifies).toBe(false);
    });

    it("qualifies an entity with 2+ price changes in the window as a repeated pattern", async () => {
      const org = await makeOrg("RepeatedChanges");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://i.example.test", category: "PRICING_PAGE" });
      const now = Date.now();

      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: new Date(now - 10 * DAY) });
      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: new Date(now - 5 * DAY) });
      await createChangeEvent(org.id, url.id, { entityKey: "basic-plan", detectedAt: new Date(now - 3 * DAY) });

      const result = await getRepeatedPriceChangePatterns(org.id, comp.id, 30);
      const pro = result.find((r) => r.entityKey === "pro-plan");
      const basic = result.find((r) => r.entityKey === "basic-plan");
      expect(pro?.changeCount).toBe(2);
      expect(pro?.qualifies).toBe(true);
      expect(basic?.changeCount).toBe(1);
      expect(basic?.qualifies).toBe(false);
    });

    it("excludes price changes outside the requested window", async () => {
      const org = await makeOrg("OutsideWindow");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://j.example.test", category: "PRICING_PAGE" });
      const now = Date.now();

      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: new Date(now - 5 * DAY) });
      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: new Date(now - 200 * DAY) });

      const result = await getRepeatedPriceChangePatterns(org.id, comp.id, 30);
      expect(result[0]?.changeCount).toBe(1);
      expect(result[0]?.qualifies).toBe(false);
    });

    it("excludes events with a null entityKey", async () => {
      const org = await makeOrg("NullKeyRepeat");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://k.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id, { entityKey: null });

      const result = await getRepeatedPriceChangePatterns(org.id, comp.id, 30);
      expect(result).toEqual([]);
    });
  });
});
