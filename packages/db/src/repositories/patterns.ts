/**
 * Phase 7: the deterministic Pattern Intelligence layer, built entirely on
 * top of the existing ChangeEvent history (Phase 1-5) and the Activity
 * Metrics core (Phase 6) - see PHASE7-DATA-AUDIT.md and
 * PHASE7-INTELLIGENCE-MODEL.md for the full justification of every
 * formula and threshold below. As with intelligence.ts, there is NO new
 * event store, NO persisted metric/pattern table, and NO AI call
 * anywhere in this file - every pattern is a live, reproducible
 * calculation over rows that already carry their own evidence.
 *
 * Every exported pattern type carries a `qualifies` (or equivalent)
 * field computed from an explicit, documented minimum-sample-size rule.
 * Callers (UI or a future AI context builder) MUST treat a
 * non-qualifying pattern as "insufficient history," never silently
 * downgrade it into a softer claim - see the Intelligence Model's
 * "Minimum sample size discipline" section.
 */
import type { ChangeType } from "../../generated/client/index.js";
import { prisma } from "../client.js";

// ---------------------------------------------------------------------------
// Entity history (Section 4.3 of the data audit / Intelligence Model)
// ---------------------------------------------------------------------------

const ENTITY_HISTORY_CHANGE_TYPES: ChangeType[] = ["PRICE_CHANGE", "PRODUCT_ADDED", "PRODUCT_REMOVED"];

export interface EntityHistoryEvent {
  changeEventId: string;
  changeType: ChangeType;
  detectedAt: Date;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  evidenceExcerpt: string;
}

export interface EntityHistory {
  monitoredUrlId: string;
  url: string;
  label: string | null;
  /** The stable (monitoredUrlId, entityKey) identity - see PHASE7-DATA-AUDIT.md Section 2. */
  entityKey: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
  events: EntityHistoryEvent[];
  priceChangeCount: number;
  /**
   * False only when the most recent event for this entity is
   * PRODUCT_REMOVED - a fact about what monitoring last observed, never
   * a claim about a business decision (same weak semantics as
   * getProductLifecycleSummary's "no longer detected", Phase 6).
   */
  currentlyDetected: boolean;
}

/**
 * The full observable story of every identifiable product/plan for one
 * competitor: not just price changes (Phase 6's getPriceHistoryForCompetitor)
 * but also its PRODUCT_ADDED origin and any later PRODUCT_REMOVED end,
 * joined purely because compare.ts already writes the SAME entityKey onto
 * all three ChangeTypes for a given product (see detectProductAddedOrRemoved
 * and detectPriceChanges in packages/detection/src/compare.ts) - no schema
 * change, no new identity invented.
 */
export async function getEntityHistoryForCompetitor(organizationId: string, competitorId: string): Promise<EntityHistory[]> {
  const urls = await prisma.monitoredUrl.findMany({
    where: { organizationId, competitorId },
    select: { id: true, url: true, label: true },
  });
  if (urls.length === 0) return [];
  const urlIds = urls.map((u) => u.id);
  const urlById = new Map(urls.map((u) => [u.id, u]));

  const events = await prisma.changeEvent.findMany({
    where: {
      organizationId,
      monitoredUrlId: { in: urlIds },
      changeType: { in: ENTITY_HISTORY_CHANGE_TYPES },
      entityKey: { not: null },
    },
    orderBy: { detectedAt: "asc" },
    select: {
      id: true,
      monitoredUrlId: true,
      entityKey: true,
      changeType: true,
      detectedAt: true,
      oldValue: true,
      newValue: true,
      currency: true,
      percentageChange: true,
      evidenceExcerpt: true,
    },
  });

  const historyByKey = new Map<string, EntityHistory>();
  for (const event of events) {
    if (!event.entityKey) continue; // filtered above; narrows for TS
    const url = urlById.get(event.monitoredUrlId);
    if (!url) continue;
    const seriesKey = `${event.monitoredUrlId}::${event.entityKey}`;
    let history = historyByKey.get(seriesKey);
    if (!history) {
      history = {
        monitoredUrlId: url.id,
        url: url.url,
        label: url.label,
        entityKey: event.entityKey,
        firstObservedAt: event.detectedAt,
        lastObservedAt: event.detectedAt,
        events: [],
        priceChangeCount: 0,
        currentlyDetected: true,
      };
      historyByKey.set(seriesKey, history);
    }
    history.events.push({
      changeEventId: event.id,
      changeType: event.changeType,
      detectedAt: event.detectedAt,
      oldValue: event.oldValue,
      newValue: event.newValue,
      currency: event.currency,
      percentageChange: event.percentageChange,
      evidenceExcerpt: event.evidenceExcerpt,
    });
    if (event.changeType === "PRICE_CHANGE") history.priceChangeCount += 1;
    if (event.detectedAt < history.firstObservedAt) history.firstObservedAt = event.detectedAt;
    if (event.detectedAt >= history.lastObservedAt) {
      history.lastObservedAt = event.detectedAt;
      history.currentlyDetected = event.changeType !== "PRODUCT_REMOVED";
    }
  }

  return Array.from(historyByKey.values()).sort((a, b) => b.events.length - a.events.length);
}

// ---------------------------------------------------------------------------
// Pattern: activity vs. own historical baseline (Data Audit Section 4.1)
// ---------------------------------------------------------------------------

/** Number of prior, non-overlapping `days`-length windows the baseline averages over. */
const BASELINE_WINDOW_COUNT = 3;
/** Minimum number of those windows that must be "in range" of the competitor's monitoring history to qualify. */
const MIN_QUALIFYING_BASELINE_WINDOWS = 2;
/** ratio >= this => ABOVE_BASELINE; ratio <= 1/this => BELOW_BASELINE. */
const BASELINE_RATIO_THRESHOLD = 1.5;

export type ActivityPatternDirection = "ABOVE_BASELINE" | "BELOW_BASELINE" | "AT_BASELINE" | "INSUFFICIENT_HISTORY";

export interface ActivityPattern {
  competitorId: string;
  days: number;
  current: number;
  /** Mean count across `qualifyingWindows` prior windows; null if zero windows qualified. */
  baselineAverage: number | null;
  /** How many of the BASELINE_WINDOW_COUNT prior windows were within the competitor's actual monitoring history. */
  qualifyingWindows: number;
  qualifies: boolean;
  direction: ActivityPatternDirection;
  /** current / baselineAverage; null when baselineAverage is 0 or the pattern doesn't qualify - see doc comment below. */
  ratio: number | null;
  /**
   * False when baselineAverage is 0 but current > 0 - a ratio against
   * zero cannot be expressed as a meaningful multiplier (the brief's
   * "1 this month vs 0 last month must not be called dramatic" rule).
   * The caller must not use strong language ("substantially above",
   * "increasing") when this is false, even if qualifies is true.
   */
  strongEvidence: boolean;
}

/**
 * Compares the current `days`-day window's ChangeEvent count for one
 * competitor against the mean of up to BASELINE_WINDOW_COUNT prior,
 * non-overlapping windows of the same length - the organization's OWN
 * accumulated history, never a cross-tenant baseline (see
 * PHASE7-INTELLIGENCE-MODEL.md, "Baseline / anomaly"). Requires
 * `Competitor.createdAt` to gate which prior windows are real monitoring
 * history versus periods before the competitor was even being tracked
 * (a "0 events" window before tracking began is not evidence of low
 * activity - it is the absence of any observation at all).
 */
export async function getActivityPattern(organizationId: string, competitorId: string, days: number): Promise<ActivityPattern> {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`days must be a positive integer, got ${days}`);
  }

  const competitor = await prisma.competitor.findFirst({
    where: { organizationId, id: competitorId },
    select: { createdAt: true },
  });
  const urls = await prisma.monitoredUrl.findMany({ where: { organizationId, competitorId }, select: { id: true } });
  const urlIds = urls.map((u) => u.id);

  const emptyResult: ActivityPattern = {
    competitorId,
    days,
    current: 0,
    baselineAverage: null,
    qualifyingWindows: 0,
    qualifies: false,
    direction: "INSUFFICIENT_HISTORY",
    ratio: null,
    strongEvidence: false,
  };

  if (!competitor || urlIds.length === 0) return emptyResult;

  const msPerDay = 24 * 60 * 60 * 1000;
  const now = new Date();
  const currentStart = new Date(now.getTime() - days * msPerDay);

  // Window 0 = current (already excluded from the baseline). Windows 1..N
  // are the prior, consecutive, non-overlapping baseline windows, each
  // [now - (i+1)*days, now - i*days).
  const priorWindows = Array.from({ length: BASELINE_WINDOW_COUNT }, (_, i) => {
    const end = new Date(now.getTime() - (i + 1) * days * msPerDay);
    const start = new Date(now.getTime() - (i + 2) * days * msPerDay);
    return { start, end };
  });

  const qualifyingWindows = priorWindows.filter((w) => w.start >= competitor.createdAt);

  const [currentCount, ...priorCounts] = await Promise.all([
    prisma.changeEvent.count({ where: { organizationId, monitoredUrlId: { in: urlIds }, detectedAt: { gte: currentStart, lt: now } } }),
    ...qualifyingWindows.map((w) =>
      prisma.changeEvent.count({ where: { organizationId, monitoredUrlId: { in: urlIds }, detectedAt: { gte: w.start, lt: w.end } } }),
    ),
  ]);

  if (qualifyingWindows.length < MIN_QUALIFYING_BASELINE_WINDOWS) {
    return { ...emptyResult, current: currentCount ?? 0 };
  }

  const baselineAverage = priorCounts.reduce((sum, n) => sum + n, 0) / priorCounts.length;
  const current = currentCount ?? 0;

  let direction: ActivityPatternDirection;
  let ratio: number | null;
  let strongEvidence: boolean;

  if (baselineAverage === 0) {
    ratio = null;
    strongEvidence = current === 0; // "at baseline (both zero)" is strong; "0 -> N" is not a multiplier claim
    direction = current === 0 ? "AT_BASELINE" : "ABOVE_BASELINE";
  } else {
    ratio = Math.round((current / baselineAverage) * 100) / 100;
    strongEvidence = true;
    if (ratio >= BASELINE_RATIO_THRESHOLD) direction = "ABOVE_BASELINE";
    else if (ratio <= 1 / BASELINE_RATIO_THRESHOLD) direction = "BELOW_BASELINE";
    else direction = "AT_BASELINE";
  }

  return {
    competitorId,
    days,
    current,
    baselineAverage: Math.round(baselineAverage * 100) / 100,
    qualifyingWindows: qualifyingWindows.length,
    qualifies: true,
    direction,
    ratio,
    strongEvidence,
  };
}

// ---------------------------------------------------------------------------
// Pattern: repeated price-change activity per entity (Data Audit Section 4.2)
// ---------------------------------------------------------------------------

/** Minimum number of price changes within the window to call it a "repeated" pattern, not just a change. */
const MIN_REPEATED_PRICE_CHANGES = 2;

export interface RepeatedPriceChangePattern {
  monitoredUrlId: string;
  entityKey: string;
  label: string | null;
  days: number;
  changeCount: number;
  qualifies: boolean;
  firstChangeAt: Date | null;
  lastChangeAt: Date | null;
  changeEventIds: string[];
}

/**
 * Groups this competitor's PRICE_CHANGE events (with a stable entityKey -
 * see PHASE7-DATA-AUDIT.md Section 2) within the last `days` days by
 * (monitoredUrlId, entityKey) and flags any group with
 * >= MIN_REPEATED_PRICE_CHANGES as a qualifying "repeated activity"
 * pattern. Groups below the threshold are still returned (so a caller can
 * show "1 change, not yet a pattern" rather than nothing) but
 * `qualifies` is false for them - never omit the distinction silently.
 */
export async function getRepeatedPriceChangePatterns(
  organizationId: string,
  competitorId: string,
  days: number,
): Promise<RepeatedPriceChangePattern[]> {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`days must be a positive integer, got ${days}`);
  }

  const urls = await prisma.monitoredUrl.findMany({ where: { organizationId, competitorId }, select: { id: true, label: true } });
  if (urls.length === 0) return [];
  const urlIds = urls.map((u) => u.id);
  const labelByUrlId = new Map(urls.map((u) => [u.id, u.label]));

  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const events = await prisma.changeEvent.findMany({
    where: {
      organizationId,
      monitoredUrlId: { in: urlIds },
      changeType: "PRICE_CHANGE",
      entityKey: { not: null },
      detectedAt: { gte: windowStart },
    },
    orderBy: { detectedAt: "asc" },
    select: { id: true, monitoredUrlId: true, entityKey: true, detectedAt: true },
  });

  const groups = new Map<string, RepeatedPriceChangePattern>();
  for (const event of events) {
    if (!event.entityKey) continue;
    const seriesKey = `${event.monitoredUrlId}::${event.entityKey}`;
    let group = groups.get(seriesKey);
    if (!group) {
      group = {
        monitoredUrlId: event.monitoredUrlId,
        entityKey: event.entityKey,
        label: labelByUrlId.get(event.monitoredUrlId) ?? null,
        days,
        changeCount: 0,
        qualifies: false,
        firstChangeAt: null,
        lastChangeAt: null,
        changeEventIds: [],
      };
      groups.set(seriesKey, group);
    }
    group.changeCount += 1;
    group.changeEventIds.push(event.id);
    if (!group.firstChangeAt || event.detectedAt < group.firstChangeAt) group.firstChangeAt = event.detectedAt;
    if (!group.lastChangeAt || event.detectedAt > group.lastChangeAt) group.lastChangeAt = event.detectedAt;
  }

  for (const group of groups.values()) {
    group.qualifies = group.changeCount >= MIN_REPEATED_PRICE_CHANGES;
  }

  return Array.from(groups.values()).sort((a, b) => b.changeCount - a.changeCount);
}
