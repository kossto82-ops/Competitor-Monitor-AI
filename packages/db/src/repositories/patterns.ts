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
  /**
   * How many of the BASELINE_WINDOW_COUNT (3) HISTORICAL windows were
   * within the competitor's actual monitoring history - always the true
   * count (0, 1, 2, or 3), even when `qualifies` is false (e.g. 1 when
   * only the most recent historical window has enough tracked history
   * yet, still short of MIN_QUALIFYING_BASELINE_WINDOWS). Never
   * artificially forced to 0 just because the pattern didn't qualify.
   */
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
 * competitor against the mean of up to BASELINE_WINDOW_COUNT (3) prior,
 * non-overlapping HISTORICAL windows of the same length - the
 * organization's OWN accumulated history, never a cross-tenant baseline
 * (see PHASE7-INTELLIGENCE-MODEL.md, "Baseline / anomaly").
 *
 * CANONICAL WINDOW MODEL (see PHASE7.1-VALIDATION-REPORT.md "Window
 * Semantics" for the full worked example with D=30):
 *
 *   Current:      [now - D,   now)          <- NOT counted as a "baseline window"
 *   Historical 1: [now - 2D,  now - D)
 *   Historical 2: [now - 3D,  now - 2D)
 *   Historical 3: [now - 4D,  now - 3D)
 *
 * "3-window baseline" means 3 HISTORICAL windows (current excluded), for
 * 4 total analysis windows when the current window is counted too. A
 * historical window only "qualifies" (counts toward `qualifyingWindows`)
 * when it lies entirely within the competitor's tracked history
 * (`window.start >= Competitor.createdAt`) - a partial/pre-tracking
 * window is NEVER included, not even fractionally. Because windows are
 * evaluated most-recent-first, Historical 1 always qualifies before
 * Historical 2, which always qualifies before Historical 3 - so reaching
 * MIN_QUALIFYING_BASELINE_WINDOWS (2) always means "Historical 1 + 2
 * qualify", which requires >= 3D of tracked history (competitor tracked
 * since at least `now - 3D`), NOT 2D. The pattern therefore first
 * becomes usable at exactly 3D of history (90 days when D=30), using 2
 * of the 3 historical windows; the FULL 3-window baseline requires 4D
 * (120 days when D=30). Do not describe this as "2D of history needed" -
 * that undercounts by one full window (a documented Phase 7.1 fix; the
 * arithmetic below was already correct, only the doc prose was wrong).
 *
 * `now` is an injectable parameter (defaulting to `new Date()`, same
 * convention as `resolveComparisonWindow` in packages/core/src/period.ts)
 * purely so tests can assert exact half-open-interval boundary behavior
 * deterministically instead of racing the real clock.
 */
export async function getActivityPattern(
  organizationId: string,
  competitorId: string,
  days: number,
  now: Date = new Date(),
): Promise<ActivityPattern> {
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
  const currentStart = new Date(now.getTime() - days * msPerDay);

  // Historical windows 1..BASELINE_WINDOW_COUNT, each
  // [now - (i+2)*days, now - (i+1)*days) - see the canonical window model
  // in this function's doc comment above.
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
    // Phase 7.1 fix: preserve the REAL qualifyingWindows count here (e.g.
    // 1, when only Historical 1 has enough tracked history yet) instead
    // of the hardcoded 0 from emptyResult - reporting "0 windows" when 1
    // genuinely qualified was a factually wrong diagnostic value, even
    // though the qualifies/direction outcome (both false/INSUFFICIENT_HISTORY)
    // was already correct either way. See PHASE7.1-VALIDATION-REPORT.md.
    return { ...emptyResult, current: currentCount ?? 0, qualifyingWindows: qualifyingWindows.length };
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
// Pattern: sustained activity-vs-baseline trend (Phase 14A/14B)
// ---------------------------------------------------------------------------

/** Number of PRIOR offsets checked, in addition to offset 0 (the current window itself). */
const MAX_SUSTAINED_LOOKBACK = 2;
/** consecutiveQualifyingWindows threshold for `sustained: true`. */
const MIN_SUSTAINED_WINDOWS = 2;

export interface SustainedActivityTrend {
  competitorId: string;
  days: number;
  /** Offset-0 result (the same window `getActivityPattern` alone would return), unchanged shape. */
  current: ActivityPattern;
  /** Offset-0 first, then -D, then -2D, ... - only the offsets actually evaluated (bounded by MAX_SUSTAINED_LOOKBACK). */
  lookback: ActivityPattern[];
  /** 0 if offset-0 itself does not qualify. */
  consecutiveQualifyingWindows: number;
  /** consecutiveQualifyingWindows >= MIN_SUSTAINED_WINDOWS. */
  sustained: boolean;
  /** False if tracked history is too short to evaluate the next offset (distinct from "the trend broke"). */
  sustainedDataAvailable: boolean;
}

/**
 * Composes the existing, unmodified `getActivityPattern` at the current
 * window (offset 0) and up to MAX_SUSTAINED_LOOKBACK immediately-preceding
 * "current windows" (offset -D, -2D, ...), each with its OWN independent
 * baseline computed relative to that offset's own `now` - see
 * PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md Section 6.1 for the full
 * qualification model this function implements verbatim.
 *
 * This function issues NO direct ChangeEvent queries of its own - it is a
 * pure composition over `getActivityPattern`, inheriting that function's
 * tenant isolation, window semantics, and INSUFFICIENT_HISTORY handling for
 * free, with zero risk of subtly diverging from its already-hardened
 * behavior (Phase 14A Section 17/18: `getActivityPattern` must never be
 * modified for this feature).
 *
 * Qualification rule (verbatim from the design audit):
 * - If offset-0 (`current`) does not qualify, no sustained claim can start
 *   from an unqualified base: `consecutiveQualifyingWindows: 0`,
 *   `sustained: false`, `sustainedDataAvailable: false`.
 * - Otherwise offset-0 counts as the first window in the streak
 *   (`streak = 1`), and each subsequent offset i (1..MAX_SUSTAINED_LOOKBACK)
 *   is evaluated in order:
 *     - if that offset's pattern does NOT qualify, tracked history is not
 *       yet long enough to look this far back - stop, `sustainedDataAvailable:
 *       false` (distinct from a reversal).
 *     - if that offset's direction differs from offset-0's direction (a
 *       reversal - no averaging, no smoothing), OR offset-0's own direction
 *       was `AT_BASELINE` (neutral - never a sustained direction), stop,
 *       `sustainedDataAvailable: true`.
 *     - otherwise the streak continues (`streak += 1`).
 * - `sustained: true` iff the final streak >= MIN_SUSTAINED_WINDOWS.
 *
 * `now` is an injectable parameter (default `new Date()`) for deterministic
 * boundary testing, same convention as `getActivityPattern`.
 */
export async function getSustainedActivityTrend(
  organizationId: string,
  competitorId: string,
  days: number,
  now: Date = new Date(),
): Promise<SustainedActivityTrend> {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`days must be a positive integer, got ${days}`);
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const current = await getActivityPattern(organizationId, competitorId, days, now);

  if (!current.qualifies) {
    return {
      competitorId,
      days,
      current,
      lookback: [current],
      consecutiveQualifyingWindows: 0,
      sustained: false,
      sustainedDataAvailable: false,
    };
  }

  const lookback: ActivityPattern[] = [current];
  let streak = 1; // offset 0 itself counts as the first window in the streak

  for (let i = 1; i <= MAX_SUSTAINED_LOOKBACK; i += 1) {
    const offsetNow = new Date(now.getTime() - i * days * msPerDay);
    // eslint-disable-next-line no-await-in-loop -- must short-circuit at the first break; each offset depends on the prior offset's qualification.
    const prior = await getActivityPattern(organizationId, competitorId, days, offsetNow);
    lookback.push(prior);

    if (!prior.qualifies) {
      // Not enough tracked history yet to look this far back.
      return {
        competitorId,
        days,
        current,
        lookback,
        consecutiveQualifyingWindows: streak,
        sustained: streak >= MIN_SUSTAINED_WINDOWS,
        sustainedDataAvailable: false,
      };
    }

    if (prior.direction !== current.direction || current.direction === "AT_BASELINE") {
      // Streak broken by a reversal, or offset-0 itself was only AT_BASELINE
      // (neutral - never a sustained direction) - no averaging, no smoothing.
      return {
        competitorId,
        days,
        current,
        lookback,
        consecutiveQualifyingWindows: streak,
        sustained: streak >= MIN_SUSTAINED_WINDOWS,
        sustainedDataAvailable: true,
      };
    }

    streak += 1;
  }

  return {
    competitorId,
    days,
    current,
    lookback,
    consecutiveQualifyingWindows: streak,
    sustained: streak >= MIN_SUSTAINED_WINDOWS,
    sustainedDataAvailable: true,
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
 * see PHASE7-DATA-AUDIT.md Section 2) within the half-open window
 * `[now - days, now)` by (monitoredUrlId, entityKey) and flags any group
 * with >= MIN_REPEATED_PRICE_CHANGES as a qualifying "repeated activity"
 * pattern. Groups below the threshold are still returned (so a caller can
 * show "1 change, not yet a pattern" rather than nothing) but
 * `qualifies` is false for them - never omit the distinction silently.
 *
 * This pattern has no "insufficient history" state (unlike
 * getActivityPattern): it counts events strictly within the requested
 * window regardless of how long the competitor has been tracked, because
 * it makes no historical-baseline claim - only "how many changes
 * happened in this window," which is always answerable (possibly as 0).
 *
 * `now` is an injectable parameter (default `new Date()`) for
 * deterministic boundary testing - same convention as `getActivityPattern`.
 */
export async function getRepeatedPriceChangePatterns(
  organizationId: string,
  competitorId: string,
  days: number,
  now: Date = new Date(),
): Promise<RepeatedPriceChangePattern[]> {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`days must be a positive integer, got ${days}`);
  }

  const urls = await prisma.monitoredUrl.findMany({ where: { organizationId, competitorId }, select: { id: true, label: true } });
  if (urls.length === 0) return [];
  const urlIds = urls.map((u) => u.id);
  const labelByUrlId = new Map(urls.map((u) => [u.id, u.label]));

  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const events = await prisma.changeEvent.findMany({
    where: {
      organizationId,
      monitoredUrlId: { in: urlIds },
      changeType: "PRICE_CHANGE",
      entityKey: { not: null },
      detectedAt: { gte: windowStart, lt: now },
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
