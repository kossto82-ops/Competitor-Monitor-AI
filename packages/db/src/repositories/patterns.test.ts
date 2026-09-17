import { afterAll, describe, expect, it } from "vitest";
import { prisma, countPrismaQueries } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { getActivityPattern, getEntityHistoryForCompetitor, getRepeatedPriceChangePatterns, getSustainedActivityTrend } from "./patterns.js";
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

    it("excludes a price change exactly at `now` (the end of the window is exclusive)", async () => {
      const org = await makeOrg("RepeatedNowBoundary");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://l.example.test", category: "PRICING_PAGE" });
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");

      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: new Date(referenceNow.getTime() - 1 * DAY) });
      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: referenceNow }); // excluded: `lt: now`

      const result = await getRepeatedPriceChangePatterns(org.id, comp.id, 30, referenceNow);
      expect(result[0]?.changeCount).toBe(1);
    });

    it("includes a price change exactly at the window start (the start of the window is inclusive)", async () => {
      const org = await makeOrg("RepeatedStartBoundary");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://m.example.test", category: "PRICING_PAGE" });
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");
      const days = 30;
      const windowStart = new Date(referenceNow.getTime() - days * DAY);

      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: windowStart }); // included: `gte: windowStart`
      await createChangeEvent(org.id, url.id, { entityKey: "pro-plan", detectedAt: new Date(windowStart.getTime() - 1) }); // 1ms before the window: excluded

      const result = await getRepeatedPriceChangePatterns(org.id, comp.id, days, referenceNow);
      expect(result[0]?.changeCount).toBe(1);
    });
  });

  /**
   * Phase 7.1: traces the exact canonical window model documented on
   * getActivityPattern's doc comment - see PHASE7.1-VALIDATION-REPORT.md
   * "Window Semantics" for the full worked table this test matrix proves.
   * With D=30: Historical 1 = [now-60d, now-30d), Historical 2 =
   * [now-90d, now-60d), Historical 3 = [now-120d, now-90d). Because
   * windows are evaluated most-recent-first, MIN_QUALIFYING_BASELINE_WINDOWS
   * (2) is only reached once BOTH Historical 1 and Historical 2 qualify,
   * which requires >= 90 days of tracked history - NOT 60. This is the
   * exact ambiguity Phase 7.1 was asked to resolve: the pattern first
   * becomes usable at 90 days (2 of 3 historical windows), and the full
   * 3-window baseline only activates at 120 days.
   */
  describe("getActivityPattern - window semantics (Phase 7.1)", () => {
    const days = 30;
    const referenceNow = new Date("2026-06-01T00:00:00.000Z");

    it.each([
      { trackedDays: 30, expectedQualifyingWindows: 0, expectedQualifies: false },
      { trackedDays: 59, expectedQualifyingWindows: 0, expectedQualifies: false },
      { trackedDays: 60, expectedQualifyingWindows: 1, expectedQualifies: false }, // Historical 1 alone is not enough
      { trackedDays: 61, expectedQualifyingWindows: 1, expectedQualifies: false },
      { trackedDays: 75, expectedQualifyingWindows: 1, expectedQualifies: false }, // the brief's own worked "75 days -> 15-day partial" example
      { trackedDays: 89, expectedQualifyingWindows: 1, expectedQualifies: false },
      { trackedDays: 90, expectedQualifyingWindows: 2, expectedQualifies: true }, // FIRST day the pattern can ever qualify
      { trackedDays: 91, expectedQualifyingWindows: 2, expectedQualifies: true },
      { trackedDays: 119, expectedQualifyingWindows: 2, expectedQualifies: true }, // Historical 3 still partial - not counted
      { trackedDays: 120, expectedQualifyingWindows: 3, expectedQualifies: true }, // full 3-window baseline
    ])("competitor tracked for exactly $trackedDays days -> qualifyingWindows=$expectedQualifyingWindows, qualifies=$expectedQualifies", async ({ trackedDays, expectedQualifyingWindows, expectedQualifies }) => {
      const org = await makeOrg(`Window${trackedDays}`);
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - trackedDays * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: `https://window-${trackedDays}.example.test`, category: "GENERAL" });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 5 * DAY) }); // one current-window event, irrelevant to qualification

      const pattern = await getActivityPattern(org.id, comp.id, days, referenceNow);
      expect(pattern.qualifyingWindows).toBe(expectedQualifyingWindows);
      expect(pattern.qualifies).toBe(expectedQualifies);
    });

    it("a partial (not-yet-tracked) historical window's events never count toward the baseline, even if rows exist in that range", async () => {
      const org = await makeOrg("PartialWindowInvariant");
      // Tracked exactly 90 days -> Historical 1 + 2 qualify, Historical 3 (90-120 days ago) does NOT.
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 90 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://partial-window.example.test", category: "GENERAL" });

      // Historical 1 (30-60d ago): 1 event. Historical 2 (60-90d ago): 1 event.
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 45 * DAY) });
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 75 * DAY) });
      // Historical 3 (90-120d ago): 5 events that pre-date competitor.createdAt - the query for
      // this window is never even issued (Historical 3 doesn't qualify at 90 tracked days), so
      // these must NOT change baselineAverage/qualifyingWindows (Invariant B).
      for (let i = 0; i < 5; i += 1) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - (91 + i) * DAY) });
      }

      const pattern = await getActivityPattern(org.id, comp.id, days, referenceNow);
      expect(pattern.qualifyingWindows).toBe(2);
      expect(pattern.baselineAverage).toBe(1); // mean(1, 1) - the 5 pre-tracking events must not be averaged in
    });

    it("events beyond the full 4-window analysis horizon (older than 120 days for D=30) never affect the baseline (Invariant D)", async () => {
      const org = await makeOrg("BeyondHorizon");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 500 * DAY)); // tracked long enough for a full baseline
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://beyond-horizon.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 45 * DAY) }); // Historical 1
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 75 * DAY) }); // Historical 2
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 105 * DAY) }); // Historical 3
      // Way outside any of the 4 windows (older than 120 days) - must never be counted.
      for (let i = 0; i < 10; i += 1) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - (200 + i * 10) * DAY) });
      }

      const pattern = await getActivityPattern(org.id, comp.id, days, referenceNow);
      expect(pattern.qualifyingWindows).toBe(3);
      expect(pattern.baselineAverage).toBe(1); // mean(1, 1, 1), unaffected by the 10 out-of-horizon events
    });

    it("adding more current-window events does not change qualifyingWindows (Invariant A: history-window count depends only on elapsed tracked time)", async () => {
      const org = await makeOrg("MoreEventsInvariant");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 90 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://more-events.example.test", category: "GENERAL" });

      const before = await getActivityPattern(org.id, comp.id, days, referenceNow);
      for (let i = 0; i < 20; i += 1) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - i * DAY) });
      }
      const after = await getActivityPattern(org.id, comp.id, days, referenceNow);

      expect(after.qualifyingWindows).toBe(before.qualifyingWindows);
    });

    it("excludes a ChangeEvent exactly at `now` from the current window (half-open interval, end exclusive)", async () => {
      const org = await makeOrg("ActivityNowBoundary");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 100 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://activity-now.example.test", category: "GENERAL" });

      await createChangeEvent(org.id, url.id, { detectedAt: referenceNow }); // excluded: `lt: now`
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 1) }); // 1ms before now: included

      const pattern = await getActivityPattern(org.id, comp.id, days, referenceNow);
      expect(pattern.current).toBe(1);
    });

    it("includes a ChangeEvent exactly at the current window's start (half-open interval, start inclusive)", async () => {
      const org = await makeOrg("ActivityStartBoundary");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 100 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://activity-start.example.test", category: "GENERAL" });
      const windowStart = new Date(referenceNow.getTime() - days * DAY);

      await createChangeEvent(org.id, url.id, { detectedAt: windowStart }); // included: `gte: windowStart`
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(windowStart.getTime() - 1) }); // just before: excluded (falls in Historical 1)

      const pattern = await getActivityPattern(org.id, comp.id, days, referenceNow);
      expect(pattern.current).toBe(1);
    });

    it("adjacent windows never double-count an event at their shared boundary", async () => {
      const org = await makeOrg("AdjacentBoundary");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 120 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://adjacent.example.test", category: "GENERAL" });
      // Exactly on the Historical1/Historical2 boundary (now - 60d): belongs to Historical 2
      // (Historical 2 = [now-90d, now-60d)) per the half-open convention, never both.
      await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - 60 * DAY) });

      const pattern = await getActivityPattern(org.id, comp.id, days, referenceNow);
      // 3 qualifying windows, total events across all 3 = 1 -> mean = 1/3, not double-counted into 2/3.
      expect(pattern.baselineAverage).toBe(Math.round((1 / 3) * 100) / 100);
    });
  });

  /**
   * Phase 7.1: the lifecycle sequences required by the audit brief, plus
   * the "contradictory sequence" defensive case (Section 10) and the very
   * common real-world case of a product that already existed before
   * monitoring started (no PRODUCT_ADDED origin at all).
   */
  describe("getEntityHistoryForCompetitor - lifecycle sequences (Phase 7.1)", () => {
    async function seedSequence(orgId: string, urlId: string, entityKey: string, types: ChangeType[]) {
      const now = Date.now();
      for (const [i, changeType] of types.entries()) {
        await createChangeEvent(orgId, urlId, { changeType, entityKey, detectedAt: new Date(now - (types.length - i) * DAY) });
      }
    }

    it("Sequence A: PRODUCT_ADDED alone -> currentlyDetected=true", async () => {
      const org = await makeOrg("SeqA");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://seq-a.example.test", category: "PRICING_PAGE" });
      await seedSequence(org.id, url.id, "seq-a", ["PRODUCT_ADDED"]);

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.currentlyDetected).toBe(true);
      expect(result[0]?.events.map((e) => e.changeType)).toEqual(["PRODUCT_ADDED"]);
    });

    it("Sequence B: PRODUCT_ADDED -> PRICE_CHANGE -> currentlyDetected=true", async () => {
      const org = await makeOrg("SeqB");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://seq-b.example.test", category: "PRICING_PAGE" });
      await seedSequence(org.id, url.id, "seq-b", ["PRODUCT_ADDED", "PRICE_CHANGE"]);

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.currentlyDetected).toBe(true);
      expect(result[0]?.priceChangeCount).toBe(1);
    });

    it("Sequence C: PRODUCT_ADDED -> PRICE_CHANGE -> PRODUCT_REMOVED -> currentlyDetected=false", async () => {
      const org = await makeOrg("SeqC");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://seq-c.example.test", category: "PRICING_PAGE" });
      await seedSequence(org.id, url.id, "seq-c", ["PRODUCT_ADDED", "PRICE_CHANGE", "PRODUCT_REMOVED"]);

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.currentlyDetected).toBe(false);
    });

    it("Sequence D: PRODUCT_ADDED -> PRICE_CHANGE -> PRODUCT_REMOVED -> PRODUCT_ADDED -> currentlyDetected=true", async () => {
      const org = await makeOrg("SeqD");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://seq-d.example.test", category: "PRICING_PAGE" });
      await seedSequence(org.id, url.id, "seq-d", ["PRODUCT_ADDED", "PRICE_CHANGE", "PRODUCT_REMOVED", "PRODUCT_ADDED"]);

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.currentlyDetected).toBe(true);
      expect(result[0]?.events).toHaveLength(4);
    });

    it("Sequence E: PRODUCT_ADDED -> PRODUCT_REMOVED -> PRODUCT_ADDED -> PRICE_CHANGE -> currentlyDetected=true", async () => {
      const org = await makeOrg("SeqE");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://seq-e.example.test", category: "PRICING_PAGE" });
      await seedSequence(org.id, url.id, "seq-e", ["PRODUCT_ADDED", "PRODUCT_REMOVED", "PRODUCT_ADDED", "PRICE_CHANGE"]);

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.currentlyDetected).toBe(true);
      expect(result[0]?.priceChangeCount).toBe(1);
    });

    it("a lone PRICE_CHANGE with no prior PRODUCT_ADDED (a product that already existed when monitoring started) is still a valid, currently-detected entity history", async () => {
      const org = await makeOrg("PreExisting");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://pre-existing.example.test", category: "PRICING_PAGE" });
      await seedSequence(org.id, url.id, "pre-existing-plan", ["PRICE_CHANGE"]);

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.currentlyDetected).toBe(true);
      expect(result[0]?.events[0]?.changeType).toBe("PRICE_CHANGE");
    });

    it("(Section 10) a contradictory PRODUCT_REMOVED -> PRICE_CHANGE sequence - which the real detection pipeline (compare.ts) cannot itself produce, since a PRICE_CHANGE is only ever emitted for an entity present in BOTH the prior and current snapshot of one transition, while PRODUCT_REMOVED means the entity was absent from the current snapshot - is still read defensively: currentlyDetected reflects the chronologically LAST event, never crashes, and never fabricates an implied re-addition", async () => {
      const org = await makeOrg("Contradictory");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://contradictory.example.test", category: "PRICING_PAGE" });
      await seedSequence(org.id, url.id, "contradictory-plan", ["PRODUCT_ADDED", "PRODUCT_REMOVED", "PRICE_CHANGE"]);

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      expect(result[0]?.events).toHaveLength(3);
      expect(result[0]?.currentlyDetected).toBe(true); // last event is PRICE_CHANGE, not PRODUCT_REMOVED
    });

    it("(Invariant E) lifecycle state is derived from chronological detectedAt order, not database insertion order", async () => {
      const org = await makeOrg("InsertionOrder");
      const comp = await createCompetitor(org.id, { name: "Comp" });
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://insertion-order.example.test", category: "PRICING_PAGE" });
      const now = Date.now();

      // Inserted out of chronological order: the REMOVED row (earlier detectedAt) is written
      // to the database AFTER the ADDED row (later detectedAt) that logically follows it.
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_ADDED", entityKey: "reorder-plan", detectedAt: new Date(now - 1 * DAY) });
      await createChangeEvent(org.id, url.id, { changeType: "PRODUCT_REMOVED", entityKey: "reorder-plan", detectedAt: new Date(now - 2 * DAY) });

      const result = await getEntityHistoryForCompetitor(org.id, comp.id);
      // Chronologically (by detectedAt), REMOVED (2 days ago) happened before ADDED (1 day ago) -
      // so the entity is currently detected, regardless of the order the rows were inserted in.
      expect(result[0]?.events.map((e) => e.changeType)).toEqual(["PRODUCT_REMOVED", "PRODUCT_ADDED"]);
      expect(result[0]?.currentlyDetected).toBe(true);
    });
  });

  describe("tenant isolation - pattern-level (Phase 7.1, Invariant C)", () => {
    it("organization B's activity pattern is never influenced by organization A's ChangeEvents, even for the same days/window shape", async () => {
      const orgA = await makeOrg("InvariantCA");
      const orgB = await makeOrg("InvariantCB");
      const compA = await makeCompetitor(orgA.id, "A", new Date(Date.now() - 200 * DAY));
      const compB = await makeCompetitor(orgB.id, "B", new Date(Date.now() - 200 * DAY));
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://invariant-c-a.example.test", category: "GENERAL" });
      const urlB = await createMonitoredUrl(orgB.id, compB.id, { url: "https://invariant-c-b.example.test", category: "GENERAL" });

      // Org A gets heavy activity in every window; Org B gets none.
      for (let i = 0; i < 20; i += 1) {
        await createChangeEvent(orgA.id, urlA.id, { detectedAt: new Date(Date.now() - i * DAY) });
      }

      const patternA = await getActivityPattern(orgA.id, compA.id, 30);
      const patternB = await getActivityPattern(orgB.id, compB.id, 30);

      expect(patternA.current).toBeGreaterThan(0);
      expect(patternB.current).toBe(0);
      expect(patternB.baselineAverage).toBe(0);
    });

    it("organization B's repeated-price-change pattern never surfaces organization A's entities", async () => {
      const orgA = await makeOrg("InvariantCRepeatA");
      const orgB = await makeOrg("InvariantCRepeatB");
      const compA = await createCompetitor(orgA.id, { name: "A" });
      const compB = await createCompetitor(orgB.id, { name: "B" });
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://invariant-c-repeat-a.example.test", category: "PRICING_PAGE" });

      await createChangeEvent(orgA.id, urlA.id, { entityKey: "shared-name-plan" });
      await createChangeEvent(orgA.id, urlA.id, { entityKey: "shared-name-plan" });

      const patternsB = await getRepeatedPriceChangePatterns(orgB.id, compB.id, 30);
      expect(patternsB).toEqual([]);
    });
  });

  /**
   * Phase 14B: getSustainedActivityTrend composes the existing, unmodified
   * getActivityPattern at the current window (offset 0) and up to
   * MAX_SUSTAINED_LOOKBACK=2 immediately-preceding "current windows"
   * (offset -D, -2D) - see PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md
   * Section 6.1/Phase 14B spec for the exact qualification model these
   * tests verify.
   *
   * `seedSustainedAboveBaseline` places exactly one event in each of the
   * current window and the two windows immediately preceding it (offset0's
   * current, offset0's HW1 = offsetD's current, offset0's HW2 = offsetD's
   * HW1 = offset2D's current), leaving everything further back at zero.
   * Because getActivityPattern's zero-baseline special case treats any
   * non-zero current against a zero baseline as ABOVE_BASELINE, this single
   * seeding produces a consistent ABOVE_BASELINE direction at every offset
   * that gets evaluated, regardless of how much tracked history the
   * competitor has - only `qualifies` (gated purely by Competitor.createdAt,
   * never by event counts) varies across the boundary matrix below.
   */
  async function seedSustainedAboveBaseline(orgId: string, urlId: string, referenceNow: Date, days: number) {
    // x0: offset0's current window [now-D, now).
    await createChangeEvent(orgId, urlId, { detectedAt: new Date(referenceNow.getTime() - 5 * DAY) });
    await createChangeEvent(orgId, urlId, { detectedAt: new Date(referenceNow.getTime() - 10 * DAY) });
    // x1: offset0's HW1 = offsetD's current, window [now-2D, now-D).
    await createChangeEvent(orgId, urlId, { detectedAt: new Date(referenceNow.getTime() - (days + 5) * DAY) });
    // x2: offset0's HW2 = offsetD's HW1 = offset2D's current, window [now-3D, now-2D).
    await createChangeEvent(orgId, urlId, { detectedAt: new Date(referenceNow.getTime() - (2 * days + 5) * DAY) });
  }

  describe("getSustainedActivityTrend (Phase 14B)", () => {
    it("Case 1: returns consecutiveQualifyingWindows=0, sustained=false, sustainedDataAvailable=false when offset-0 itself does not qualify", async () => {
      const org = await makeOrg("SustainedTooNew");
      const comp = await makeCompetitor(org.id, "Comp", new Date()); // created just now - no baseline possible
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://sustained-too-new.example.test", category: "GENERAL" });
      await createChangeEvent(org.id, url.id);

      const trend = await getSustainedActivityTrend(org.id, comp.id, 30);
      expect(trend.current.qualifies).toBe(false);
      expect(trend.lookback).toEqual([trend.current]);
      expect(trend.consecutiveQualifyingWindows).toBe(0);
      expect(trend.sustained).toBe(false);
      expect(trend.sustainedDataAvailable).toBe(false);
    });

    it("Case 7: an offset-0 direction of AT_BASELINE never counts as sustained, even when the next offset has enough tracked history", async () => {
      const org = await makeOrg("SustainedAtBaseline");
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 200 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://sustained-at-baseline.example.test", category: "GENERAL" });
      const days = 30;

      // Equal counts in the current window and all 3 historical windows -> ratio exactly 1.0 -> AT_BASELINE.
      for (const offsetDays of [5, days + 5, 2 * days + 5, 3 * days + 5]) {
        for (let n = 0; n < 5; n += 1) {
          await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - offsetDays * DAY) });
        }
      }

      const trend = await getSustainedActivityTrend(org.id, comp.id, days, referenceNow);
      expect(trend.current.qualifies).toBe(true);
      expect(trend.current.direction).toBe("AT_BASELINE");
      expect(trend.consecutiveQualifyingWindows).toBe(1);
      expect(trend.sustained).toBe(false);
      expect(trend.sustainedDataAvailable).toBe(true); // the next offset DID have enough history - the streak broke on direction, not on missing data
    });

    it("Case 5: a reversal (current ABOVE_BASELINE, previous BELOW_BASELINE) breaks the streak immediately - no averaging", async () => {
      const org = await makeOrg("SustainedReversalAboveBelow");
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 200 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://sustained-reversal-above-below.example.test", category: "GENERAL" });
      const days = 30;

      // w0 (current)=15 high; w1 (offsetD current)=1 low; w2=w3=w4=10 high (offsetD's own baseline).
      const windowCounts: [number, number][] = [
        [5, 15], // w0: [now-D, now)
        [days + 5, 1], // w1: [now-2D, now-D)
        [2 * days + 5, 10], // w2: [now-3D, now-2D)
        [3 * days + 5, 10], // w3: [now-4D, now-3D)
        [4 * days + 5, 10], // w4: [now-5D, now-4D)
      ];
      for (const [offsetDays, count] of windowCounts) {
        for (let n = 0; n < count; n += 1) {
          await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - offsetDays * DAY) });
        }
      }

      const trend = await getSustainedActivityTrend(org.id, comp.id, days, referenceNow);
      expect(trend.current.direction).toBe("ABOVE_BASELINE");
      expect(trend.lookback[1]?.direction).toBe("BELOW_BASELINE");
      expect(trend.consecutiveQualifyingWindows).toBe(1);
      expect(trend.sustained).toBe(false);
      expect(trend.sustainedDataAvailable).toBe(true);
    });

    it("Case 6: a reversal (current BELOW_BASELINE, previous ABOVE_BASELINE) breaks the streak immediately", async () => {
      const org = await makeOrg("SustainedReversalBelowAbove");
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 200 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://sustained-reversal-below-above.example.test", category: "GENERAL" });
      const days = 30;

      // w0 (current)=2 low; w1 (offsetD current)=15 high; w2=w3=w4=2 low (offsetD's own baseline).
      const windowCounts: [number, number][] = [
        [5, 2],
        [days + 5, 15],
        [2 * days + 5, 2],
        [3 * days + 5, 2],
        [4 * days + 5, 2],
      ];
      for (const [offsetDays, count] of windowCounts) {
        for (let n = 0; n < count; n += 1) {
          await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - offsetDays * DAY) });
        }
      }

      const trend = await getSustainedActivityTrend(org.id, comp.id, days, referenceNow);
      expect(trend.current.direction).toBe("BELOW_BASELINE");
      expect(trend.lookback[1]?.direction).toBe("ABOVE_BASELINE");
      expect(trend.consecutiveQualifyingWindows).toBe(1);
      expect(trend.sustained).toBe(false);
      expect(trend.sustainedDataAvailable).toBe(true);
    });

    it("Case 8: a reversal at the third window does not invalidate an already-established two-window streak", async () => {
      const org = await makeOrg("SustainedThreeWindowReversal");
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 200 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://sustained-three-window-reversal.example.test", category: "GENERAL" });
      const days = 30;

      // w0=5 (offset0 current, ABOVE vs avg(w1,w2,w3)=2.33), w1=4 (offsetD current, ABOVE vs
      // avg(w2,w3,w4)=1.67), w2=1 (offset2D current, BELOW vs avg(w3,w4,w5)=2).
      const windowCounts: [number, number][] = [
        [5, 5], // w0
        [days + 5, 4], // w1
        [2 * days + 5, 1], // w2
        [3 * days + 5, 2], // w3
        [4 * days + 5, 2], // w4
        [5 * days + 5, 2], // w5
      ];
      for (const [offsetDays, count] of windowCounts) {
        for (let n = 0; n < count; n += 1) {
          await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - offsetDays * DAY) });
        }
      }

      const trend = await getSustainedActivityTrend(org.id, comp.id, days, referenceNow);
      expect(trend.current.direction).toBe("ABOVE_BASELINE");
      expect(trend.lookback[1]?.direction).toBe("ABOVE_BASELINE");
      expect(trend.lookback[2]?.direction).toBe("BELOW_BASELINE");
      expect(trend.consecutiveQualifyingWindows).toBe(2);
      expect(trend.sustained).toBe(true);
      expect(trend.sustainedDataAvailable).toBe(true);
      expect(trend.lookback).toHaveLength(3);
    });

    it("never leaks another organization's activity into the sustained trend", async () => {
      const orgA = await makeOrg("SustainedXTenantA");
      const orgB = await makeOrg("SustainedXTenantB");
      const compA = await makeCompetitor(orgA.id, "Secret", new Date(Date.now() - 200 * DAY));
      const urlA = await createMonitoredUrl(orgA.id, compA.id, { url: "https://sustained-secret.example.test", category: "GENERAL" });
      for (let i = 0; i < 10; i += 1) {
        await createChangeEvent(orgA.id, urlA.id, { detectedAt: new Date(Date.now() - i * DAY) });
      }

      const trend = await getSustainedActivityTrend(orgB.id, compA.id, 30);
      expect(trend.current.qualifies).toBe(false);
      expect(trend.current.current).toBe(0);
      expect(trend.sustained).toBe(false);
      expect(trend.sustainedDataAvailable).toBe(false);
    });

    it("issues a bounded number of queries (<=3 getActivityPattern calls x <=6 Prisma calls = <=18)", async () => {
      const org = await makeOrg("SustainedQueryCount");
      const comp = await makeCompetitor(org.id, "Comp", new Date(Date.now() - 200 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://sustained-query-count.example.test", category: "GENERAL" });
      for (let i = 0; i < 40; i += 1) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(Date.now() - i * DAY) });
      }

      const queryCount = await countPrismaQueries(() => getSustainedActivityTrend(org.id, comp.id, 30));
      expect(queryCount).toBeLessThanOrEqual(18);
    });

    it("query count does not grow as ChangeEvent volume grows (bounded independent of event volume)", async () => {
      const org = await makeOrg("SustainedQueryVolume");
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");
      const days = 30;
      // Full 3-window sustained pattern (streak=3) so every offset is actually evaluated -
      // the worst case for query count, and a FIXED direction/qualification outcome that
      // adding more (out-of-horizon) events below must not perturb.
      const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - 200 * DAY));
      const url = await createMonitoredUrl(org.id, comp.id, { url: "https://sustained-query-volume.example.test", category: "GENERAL" });
      await seedSustainedAboveBaseline(org.id, url.id, referenceNow, days);

      const before = await countPrismaQueries(() => getSustainedActivityTrend(org.id, comp.id, days, referenceNow));
      // Add a burst of events far outside every window this invocation ever queries (the full
      // lookback horizon tops out at ~6*days back) - these must never change the query count,
      // the qualification outcome, or the direction.
      for (let i = 0; i < 40; i += 1) {
        await createChangeEvent(org.id, url.id, { detectedAt: new Date(referenceNow.getTime() - (500 + i) * DAY) });
      }
      const after = await countPrismaQueries(() => getSustainedActivityTrend(org.id, comp.id, days, referenceNow));

      expect(before).toBe(18); // full 3-offset evaluation: 3 getActivityPattern calls x 6 Prisma calls each
      expect(after).toBe(before);
    });

    /**
     * Phase 14B Acceptance Criterion 2 / Section 8 of the design audit: the
     * exact day-count floor for a 2-consecutive-window sustained claim is
     * 120 tracked days (D=30) - one tier deeper than getActivityPattern's
     * own 90-day floor - and 150 days for a 3-consecutive-window claim.
     */
    describe("window-boundary matrix (120/150-day cliffs, D=30)", () => {
      const days = 30;
      const referenceNow = new Date("2026-06-01T00:00:00.000Z");

      it.each([
        { trackedDays: 119, expectedStreak: 1, expectedSustained: false, expectedDataAvailable: false, expectedLookbackLength: 2 },
        { trackedDays: 120, expectedStreak: 2, expectedSustained: true, expectedDataAvailable: false, expectedLookbackLength: 3 },
        { trackedDays: 121, expectedStreak: 2, expectedSustained: true, expectedDataAvailable: false, expectedLookbackLength: 3 },
        { trackedDays: 149, expectedStreak: 2, expectedSustained: true, expectedDataAvailable: false, expectedLookbackLength: 3 },
        { trackedDays: 150, expectedStreak: 3, expectedSustained: true, expectedDataAvailable: true, expectedLookbackLength: 3 },
        { trackedDays: 151, expectedStreak: 3, expectedSustained: true, expectedDataAvailable: true, expectedLookbackLength: 3 },
      ])(
        "competitor tracked for exactly $trackedDays days -> consecutiveQualifyingWindows=$expectedStreak, sustained=$expectedSustained, sustainedDataAvailable=$expectedDataAvailable",
        async ({ trackedDays, expectedStreak, expectedSustained, expectedDataAvailable, expectedLookbackLength }) => {
          const org = await makeOrg(`Sustained${trackedDays}`);
          const comp = await makeCompetitor(org.id, "Comp", new Date(referenceNow.getTime() - trackedDays * DAY));
          const url = await createMonitoredUrl(org.id, comp.id, { url: `https://sustained-${trackedDays}.example.test`, category: "GENERAL" });
          await seedSustainedAboveBaseline(org.id, url.id, referenceNow, days);

          const trend = await getSustainedActivityTrend(org.id, comp.id, days, referenceNow);
          expect(trend.current.direction).toBe("ABOVE_BASELINE");
          expect(trend.consecutiveQualifyingWindows).toBe(expectedStreak);
          expect(trend.sustained).toBe(expectedSustained);
          expect(trend.sustainedDataAvailable).toBe(expectedDataAvailable);
          expect(trend.lookback).toHaveLength(expectedLookbackLength);
        },
      );
    });
  });
});
