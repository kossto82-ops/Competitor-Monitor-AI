/**
 * Phase 6: the Competitive Intelligence Core.
 *
 * Every function here is a deterministic query over the ChangeEvent
 * history that already exists (Phase 1-5) - there is NO parallel event
 * store, NO persisted metric table, and NO AI call anywhere in this
 * file. See PHASE6-DATA-AUDIT.md for why: the historical facts a
 * customer needs ("how active has this competitor been", "how has
 * pricing moved", "what's been added/removed") are all derivable by
 * aggregating ChangeEvent rows that Phase 1's monitoring pipeline
 * already writes with full evidence, so a second event system would be
 * pure duplication (Section 17 of the Phase 6 brief).
 *
 * Every query is scoped by `organizationId` directly on ChangeEvent
 * (never inferred through a join), matching the tenant-isolation
 * convention documented at the top of schema.prisma.
 */
import { calculatePeriodDelta, describeChangeEvent, resolveComparisonWindow, type PeriodDelta } from "@cma/core";
import type { ChangeType, Severity } from "../../generated/client/index.js";
import { prisma } from "../client.js";
import {
  getActivityPattern,
  getRepeatedPriceChangePatterns,
  getSustainedActivityTrend,
  type ActivityPattern,
  type RepeatedPriceChangePattern,
  type SustainedActivityTrend,
} from "./patterns.js";

const CHANGE_TYPES: ChangeType[] = ["PRICE_CHANGE", "PRODUCT_ADDED", "PRODUCT_REMOVED", "PROMOTION_CHANGE", "CONTENT_CHANGE"];

export interface ChangeTypeBreakdown {
  changeType: ChangeType;
  current: number;
  previous: number;
}

export interface ActivityMetrics {
  days: number;
  timezone: string;
  windowStart: Date;
  windowEnd: Date;
  total: PeriodDelta;
  byType: ChangeTypeBreakdown[];
}

/**
 * Counts ChangeEvents in `where` split into the current and previous
 * `days`-day windows with a single groupBy query per window (Section 23:
 * prefer SQL aggregation over loading rows into Node) - 2 queries total
 * regardless of how many ChangeEvents exist or how many change types
 * are represented.
 */
async function countByTypeForWindows(
  where: { organizationId: string; monitoredUrlId?: { in: string[] } },
  days: number,
  timezone: string | null | undefined,
): Promise<ActivityMetrics> {
  const window = resolveComparisonWindow(days, timezone);

  const [currentGroups, previousGroups] = await Promise.all([
    prisma.changeEvent.groupBy({
      by: ["changeType"],
      where: { ...where, detectedAt: { gte: window.currentStart, lt: window.currentEnd } },
      _count: { _all: true },
    }),
    prisma.changeEvent.groupBy({
      by: ["changeType"],
      where: { ...where, detectedAt: { gte: window.previousStart, lt: window.previousEnd } },
      _count: { _all: true },
    }),
  ]);

  const currentByType = new Map(currentGroups.map((g) => [g.changeType, g._count._all]));
  const previousByType = new Map(previousGroups.map((g) => [g.changeType, g._count._all]));

  const byType: ChangeTypeBreakdown[] = CHANGE_TYPES.map((changeType) => ({
    changeType,
    current: currentByType.get(changeType) ?? 0,
    previous: previousByType.get(changeType) ?? 0,
  })).filter((row) => row.current > 0 || row.previous > 0);

  const totalCurrent = [...currentByType.values()].reduce((sum, n) => sum + n, 0);
  const totalPrevious = [...previousByType.values()].reduce((sum, n) => sum + n, 0);

  return {
    days,
    timezone: window.timezone,
    windowStart: window.currentStart,
    windowEnd: window.currentEnd,
    total: calculatePeriodDelta(totalCurrent, totalPrevious),
    byType,
  };
}

/**
 * Org-wide activity overview (Section 6: dashboard). `timezone` should
 * be the organization's own timezone (Organization.timezone) - callers
 * pass it in rather than this function re-reading Organization, so it
 * stays a pure aggregation over ChangeEvent plus one already-known value.
 */
export async function getOrgActivityMetrics(organizationId: string, days: number, timezone: string | null | undefined = "UTC") {
  return countByTypeForWindows({ organizationId }, days, timezone);
}

/**
 * One competitor's activity across ALL of its monitored URLs (Section
 * 6). Resolves the competitor's monitored URL ids first (1 query), then
 * a single groupBy per window scoped to those ids AND organizationId -
 * so a competitor id belonging to another organization silently returns
 * zero URLs and therefore zero activity, never another org's data.
 */
export async function getCompetitorActivityMetrics(
  organizationId: string,
  competitorId: string,
  days: number,
  timezone: string | null | undefined = "UTC",
): Promise<ActivityMetrics> {
  const urls = await prisma.monitoredUrl.findMany({
    where: { organizationId, competitorId },
    select: { id: true },
  });
  const urlIds = urls.map((u) => u.id);
  if (urlIds.length === 0) {
    const window = resolveComparisonWindow(days, timezone);
    return {
      days,
      timezone: window.timezone,
      windowStart: window.currentStart,
      windowEnd: window.currentEnd,
      total: calculatePeriodDelta(0, 0),
      byType: [],
    };
  }
  return countByTypeForWindows({ organizationId, monitoredUrlId: { in: urlIds } }, days, timezone);
}

export interface ProductLifecycleSummary {
  days: number;
  added: PeriodDelta;
  removed: PeriodDelta;
}

/**
 * Section 8: added/removed counts, current vs. previous period.
 * Deliberately reuses getCompetitorActivityMetrics's byType breakdown
 * rather than a second pair of queries - PRODUCT_ADDED/PRODUCT_REMOVED
 * are already counted there.
 */
export async function getProductLifecycleSummary(
  organizationId: string,
  competitorId: string,
  days: number,
  timezone: string | null | undefined = "UTC",
): Promise<ProductLifecycleSummary> {
  const activity = await getCompetitorActivityMetrics(organizationId, competitorId, days, timezone);
  const added = activity.byType.find((r) => r.changeType === "PRODUCT_ADDED");
  const removed = activity.byType.find((r) => r.changeType === "PRODUCT_REMOVED");
  return {
    days,
    added: calculatePeriodDelta(added?.current ?? 0, added?.previous ?? 0),
    removed: calculatePeriodDelta(removed?.current ?? 0, removed?.previous ?? 0),
  };
}

export interface PriceSeriesPoint {
  changeEventId: string;
  detectedAt: Date;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
}

export interface PriceSeries {
  monitoredUrlId: string;
  url: string;
  label: string | null;
  /** The stable product/plan identity this series tracks - see the module doc comment for why this is defensible. */
  entityKey: string;
  /** A human label for the series, taken from the first available evidence excerpt's entity name (see below). */
  points: PriceSeriesPoint[];
}

/**
 * Section 7: a deterministic price-history series, built ONLY where the
 * data has a defensible stable identity - `entityKey` on a PRICE_CHANGE
 * ChangeEvent is exactly that (see packages/detection/src/compare.ts's
 * doc comment: "their `key` is derived from a product name, so it is
 * stable across scans" - restricted to JSON-LD-sourced PRICE entities on
 * purpose). Grouped by (monitoredUrlId, entityKey) because the same
 * product name COULD collide across two different monitored URLs of the
 * same competitor; grouping per-URL keeps each series unambiguous.
 *
 * PRICE_CHANGE events with a null entityKey (can happen for
 * non-JSON-LD-sourced price detection paths) are excluded from every
 * series - Section 7 explicitly forbids inventing a unified price line
 * when the identity isn't stable enough to justify one.
 */
export async function getPriceHistoryForCompetitor(organizationId: string, competitorId: string): Promise<PriceSeries[]> {
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
      changeType: "PRICE_CHANGE",
      entityKey: { not: null },
    },
    orderBy: { detectedAt: "asc" },
    select: {
      id: true,
      monitoredUrlId: true,
      entityKey: true,
      detectedAt: true,
      oldValue: true,
      newValue: true,
      currency: true,
      percentageChange: true,
    },
  });

  const seriesByKey = new Map<string, PriceSeries>();
  for (const event of events) {
    // entityKey is filtered to `not: null` above; narrow it for TS.
    if (!event.entityKey) continue;
    const url = urlById.get(event.monitoredUrlId);
    if (!url) continue;
    const seriesKey = `${event.monitoredUrlId}::${event.entityKey}`;
    let series = seriesByKey.get(seriesKey);
    if (!series) {
      series = { monitoredUrlId: url.id, url: url.url, label: url.label, entityKey: event.entityKey, points: [] };
      seriesByKey.set(seriesKey, series);
    }
    series.points.push({
      changeEventId: event.id,
      detectedAt: event.detectedAt,
      oldValue: event.oldValue,
      newValue: event.newValue,
      currency: event.currency,
      percentageChange: event.percentageChange,
    });
  }

  return Array.from(seriesByKey.values()).sort((a, b) => b.points.length - a.points.length);
}

export interface CompetitorComparisonRow {
  competitorId: string;
  name: string;
  totalChanges: PeriodDelta;
  priceChanges: PeriodDelta;
  productsAdded: PeriodDelta;
  productsRemoved: PeriodDelta;
  latestChangeAt: Date | null;
}

/**
 * Section 10/11: descriptive (NOT ranked) cross-competitor comparison.
 * Deliberately returns raw counts per competitor with no derived
 * "score", "winner", or ordering beyond the caller's own competitorIds
 * order - see the module doc comment and PHASE6-VALIDATION.md's Product
 * Assessment section for why ranking is explicitly out of scope.
 *
 * Every competitorId is independently re-checked against
 * `organizationId` (via the same monitoredUrl lookup as
 * getCompetitorActivityMetrics) - a competitorId from another
 * organization silently contributes an all-zero row rather than leaking
 * that organization's data.
 */
export async function compareCompetitors(
  organizationId: string,
  competitorIds: string[],
  days: number,
  timezone: string | null | undefined = "UTC",
): Promise<CompetitorComparisonRow[]> {
  if (competitorIds.length === 0) return [];

  const competitors = await prisma.competitor.findMany({
    where: { organizationId, id: { in: competitorIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(competitors.map((c) => [c.id, c.name]));

  const rows = await Promise.all(
    competitorIds
      .filter((id) => nameById.has(id)) // silently drop ids that don't belong to this org
      .map(async (competitorId) => {
        const [activity, latest] = await Promise.all([
          getCompetitorActivityMetrics(organizationId, competitorId, days, timezone),
          getLatestChangeEventAtForCompetitor(organizationId, competitorId),
        ]);
        const priceChanges = activity.byType.find((r) => r.changeType === "PRICE_CHANGE");
        const added = activity.byType.find((r) => r.changeType === "PRODUCT_ADDED");
        const removed = activity.byType.find((r) => r.changeType === "PRODUCT_REMOVED");
        const row: CompetitorComparisonRow = {
          competitorId,
          name: nameById.get(competitorId) ?? "",
          totalChanges: activity.total,
          priceChanges: calculatePeriodDelta(priceChanges?.current ?? 0, priceChanges?.previous ?? 0),
          productsAdded: calculatePeriodDelta(added?.current ?? 0, added?.previous ?? 0),
          productsRemoved: calculatePeriodDelta(removed?.current ?? 0, removed?.previous ?? 0),
          latestChangeAt: latest,
        };
        return row;
      }),
  );

  return rows;
}

async function getLatestChangeEventAtForCompetitor(organizationId: string, competitorId: string): Promise<Date | null> {
  const latest = await getLatestChangeEventForCompetitor(organizationId, competitorId);
  return latest?.detectedAt ?? null;
}

interface LatestChangeEventRef {
  id: string;
  detectedAt: Date;
}

/**
 * Phase 8: same query as getLatestChangeEventAtForCompetitor but also
 * returns the ChangeEvent id, so a caller (getCompetitiveContext) can link
 * directly to its evidence page (/changes/[id]) instead of only showing a
 * bare, unlinked date - see PHASE8-DESIGN.md Section 2/8.
 */
async function getLatestChangeEventForCompetitor(organizationId: string, competitorId: string): Promise<LatestChangeEventRef | null> {
  const urls = await prisma.monitoredUrl.findMany({ where: { organizationId, competitorId }, select: { id: true } });
  const urlIds = urls.map((u) => u.id);
  if (urlIds.length === 0) return null;
  const latest = await prisma.changeEvent.findFirst({
    where: { organizationId, monitoredUrlId: { in: urlIds } },
    orderBy: { detectedAt: "desc" },
    select: { id: true, detectedAt: true },
  });
  return latest ?? null;
}

// ---------------------------------------------------------------------------
// Phase 8: Competitive Context - purely descriptive, per-competitor-own-
// history extension of compareCompetitors. See PHASE8-DESIGN.md.
// ---------------------------------------------------------------------------

export interface CompetitiveContextRow extends CompetitorComparisonRow {
  latestChangeEventId: string | null;
  /** The exact Phase 7 ActivityPattern for this competitor - own-history baseline only, never a cross-competitor or market baseline. */
  activityPattern: ActivityPattern;
  /** Count of entities (monitoredUrlId/entityKey pairs) whose price-change count in the window meets RepeatedPriceChangePattern.qualifies - never the total count of all entities that had any price change. */
  qualifyingRepeatedPriceChangeCount: number;
}

/**
 * Phase 8: extends compareCompetitors' descriptive per-competitor row with
 * the Phase 7 pattern layer, reused verbatim (no new baseline formula, no
 * new window model - see PHASE7.1-VALIDATION-REPORT.md "Phase 8
 * Readiness" and PHASE8-DESIGN.md Section 3/4). Still no ranking: rows
 * come back in the same competitorIds order as compareCompetitors, and
 * every competitor's pattern is computed only against ITS OWN accumulated
 * history, never against another competitor's or a market average.
 *
 * Query cost is bounded by the number of SELECTED competitors (a small,
 * customer-controlled set), not by event volume - each competitor's
 * pattern/repeated-price calls run in parallel via Promise.all, matching
 * compareCompetitors' own existing per-competitor parallelism.
 */
export async function getCompetitiveContext(
  organizationId: string,
  competitorIds: string[],
  days: number,
  timezone: string | null | undefined = "UTC",
): Promise<CompetitiveContextRow[]> {
  if (competitorIds.length === 0) return [];

  const baseRows = await compareCompetitors(organizationId, competitorIds, days, timezone);

  return Promise.all(
    baseRows.map(async (row): Promise<CompetitiveContextRow> => {
      const [latest, activityPattern, repeatedPricePatterns] = await Promise.all([
        getLatestChangeEventForCompetitor(organizationId, row.competitorId),
        getActivityPattern(organizationId, row.competitorId, days),
        getRepeatedPriceChangePatterns(organizationId, row.competitorId, days),
      ]);
      return {
        ...row,
        latestChangeEventId: latest?.id ?? null,
        activityPattern,
        qualifyingRepeatedPriceChangeCount: repeatedPricePatterns.filter((p) => p.qualifies).length,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase 10: Deterministic Digest - a per-organization, evidence-linked
// composition of already-existing facts (ChangeEvent, ActivityPattern,
// RepeatedPriceChangePattern, and - since Phase 16 - SustainedActivityTrend)
// across every actively-tracked competitor. See PHASE10-VALIDATION-REPORT.md,
// PHASE9-PRODUCT-DIRECTION-AUDIT.md Section 14, and
// PHASE15-INTELLIGENCE-VALUE-AUDIT.md Section 16 for why this is pure
// composition, not a new tier of intelligence: every field below is either a
// direct ChangeEvent column or an already-tested Phase 7/14B pattern object,
// reused verbatim. There is NO new baseline formula, NO importance/relevance
// score, and NO AI call anywhere in this function.
// ---------------------------------------------------------------------------

/** Fixed, documented tie-break order for items sharing the same `detectedAt` - never a hidden importance ranking, just a stable sort key. */
const DIGEST_ITEM_KIND_ORDER = ["CHANGE_EVENT", "REPEATED_PRICE_CHANGE", "ACTIVITY_PATTERN", "SUSTAINED_ACTIVITY_TREND", "LIFECYCLE"] as const;
export type DigestItemKind = (typeof DIGEST_ITEM_KIND_ORDER)[number];

interface DigestItemCommon {
  competitorId: string;
  competitorName: string;
  /** Used for primary ordering (recency-first, descending) - never an importance score. */
  detectedAt: Date;
  /** Every digest item MUST carry at least one real ChangeEvent id - see the module doc comment above and PHASE10-VALIDATION-REPORT.md's Evidence Requirement section. Never empty. */
  changeEventIds: string[];
}

/** A single raw, verified ChangeEvent - always eligible, regardless of any pattern's qualification state. */
export interface ChangeEventDigestItem extends DigestItemCommon {
  kind: "CHANGE_EVENT";
  changeEventId: string;
  changeType: ChangeType;
  severity: Severity;
  /** The exact sentence statusDisplay.ts's summarizeChangeEvent (@cma/core's describeChangeEvent) already renders elsewhere - never a second, independently-worded description of the same fact. */
  description: string;
}

/** A qualifying (changeCount >= 2) repeated price-change pattern for one product/plan - reused verbatim from patterns.ts, never re-derived. */
export interface RepeatedPriceChangeDigestItem extends DigestItemCommon {
  kind: "REPEATED_PRICE_CHANGE";
  pattern: RepeatedPriceChangePattern;
}

/** A qualifying (qualifies === true) activity-vs-own-baseline pattern - reused verbatim from patterns.ts. Only ever compared against THIS competitor's own accumulated history. */
export interface ActivityPatternDigestItem extends DigestItemCommon {
  kind: "ACTIVITY_PATTERN";
  pattern: ActivityPattern;
}

/**
 * Phase 16: a sustained (consecutiveQualifyingWindows >= 2), multi-window
 * activity-vs-own-baseline trend - see PHASE15-INTELLIGENCE-VALUE-AUDIT.md
 * Section 16/9.4 for why this carries only these two already-computed,
 * independently-reconstructible-from-`lookback` numbers/enums (never a new
 * score) and PHASE14B-VALIDATION-REPORT.md for `getSustainedActivityTrend`
 * itself, reused verbatim and UNMODIFIED. `direction` is never `AT_BASELINE`
 * or `INSUFFICIENT_HISTORY` here - a sustained streak requires offset-0
 * itself to `qualify` with a non-neutral direction (see
 * getSustainedActivityTrend's own doc comment).
 */
export interface SustainedActivityTrendDigestItem extends DigestItemCommon {
  kind: "SUSTAINED_ACTIVITY_TREND";
  consecutiveQualifyingWindows: number;
  direction: "ABOVE_BASELINE" | "BELOW_BASELINE";
}

/** A deterministic added/removed roll-up for this competitor within the digest window, derived from the same raw ChangeEvents already fetched for the CHANGE_EVENT items above (see the function doc comment for why this is NOT a second call to getProductLifecycleSummary). */
export interface LifecycleDigestItem extends DigestItemCommon {
  kind: "LIFECYCLE";
  added: number;
  removed: number;
}

export type DigestItem =
  | ChangeEventDigestItem
  | RepeatedPriceChangeDigestItem
  | ActivityPatternDigestItem
  | SustainedActivityTrendDigestItem
  | LifecycleDigestItem;

export interface DigestCrossCompetitorContext {
  /** Count of tracked competitors whose ActivityPattern.direction is currently ABOVE_BASELINE (implies qualifies === true - see patterns.ts). Purely descriptive counting, never a causal/coordination claim - see PHASE9-PRODUCT-DIRECTION-AUDIT.md Section 9. */
  aboveBaselineCount: number;
  /** Phase 16: count of tracked competitors whose SustainedActivityTrend.sustained is currently true - the identical `.filter().length` shape as aboveBaselineCount, applied to the persistence signal instead of a single-window snapshot. Purely descriptive counting, never a ranking. */
  sustainedCount: number;
  /** Total actively-tracked competitors for this organization, regardless of whether their own pattern qualifies yet. */
  totalTrackedCompetitors: number;
}

export interface DigestResult {
  days: number;
  timezone: string;
  windowStart: Date;
  windowEnd: Date;
  totalTrackedCompetitors: number;
  /** Deterministically ordered: detectedAt DESC, then competitorId ASC, then a fixed kind order, then a stable id - see DIGEST_ITEM_KIND_ORDER above. Never truncated/hidden by an importance score. */
  items: DigestItem[];
  crossCompetitorContext: DigestCrossCompetitorContext;
}

function digestItemStableId(item: DigestItem): string {
  switch (item.kind) {
    case "CHANGE_EVENT":
      return item.changeEventId;
    case "REPEATED_PRICE_CHANGE":
      return `${item.pattern.monitoredUrlId}::${item.pattern.entityKey}`;
    case "ACTIVITY_PATTERN":
      return `activity::${item.competitorId}`;
    case "SUSTAINED_ACTIVITY_TREND":
      return `sustained::${item.competitorId}`;
    case "LIFECYCLE":
      return `lifecycle::${item.competitorId}`;
  }
}

/**
 * Deterministic ordering (see PHASE9-PRODUCT-DIRECTION-AUDIT.md Section 14
 * and PHASE10-VALIDATION-REPORT.md): newest verified information first.
 * Ties are broken by a fixed, documented, stable key - never a hidden
 * relevance/importance score.
 */
function compareDigestItems(a: DigestItem, b: DigestItem): number {
  const byDate = b.detectedAt.getTime() - a.detectedAt.getTime();
  if (byDate !== 0) return byDate;
  const byCompetitor = a.competitorId.localeCompare(b.competitorId);
  if (byCompetitor !== 0) return byCompetitor;
  const byKind = DIGEST_ITEM_KIND_ORDER.indexOf(a.kind) - DIGEST_ITEM_KIND_ORDER.indexOf(b.kind);
  if (byKind !== 0) return byKind;
  return digestItemStableId(a).localeCompare(digestItemStableId(b));
}

interface DigestRawChangeEvent {
  id: string;
  competitorId: string;
  changeType: ChangeType;
  severity: Severity;
  detectedAt: Date;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
}

/**
 * A single bulk query for every ChangeEvent in the digest window across
 * every tracked competitor - bounded by window volume (a small,
 * customer-controlled `days` value), NOT by (competitor count x event
 * count), matching PHASE10-VALIDATION-REPORT.md's Performance section.
 * The per-competitor pattern calls in getDigestForOrganization remain
 * bounded by the number of tracked competitors (Promise.all, same
 * convention as getCompetitiveContext) - this function avoids adding a
 * second per-competitor query on top of those for the raw-change/lifecycle
 * content.
 */
async function listRecentChangeEventsForDigest(
  organizationId: string,
  competitorIds: string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<DigestRawChangeEvent[]> {
  if (competitorIds.length === 0) return [];
  const events = await prisma.changeEvent.findMany({
    where: {
      organizationId,
      monitoredUrl: { competitorId: { in: competitorIds } },
      detectedAt: { gte: windowStart, lt: windowEnd },
    },
    orderBy: { detectedAt: "desc" },
    select: {
      id: true,
      changeType: true,
      severity: true,
      detectedAt: true,
      oldValue: true,
      newValue: true,
      currency: true,
      percentageChange: true,
      monitoredUrl: { select: { competitorId: true } },
    },
  });
  return events.map((e) => ({
    id: e.id,
    competitorId: e.monitoredUrl.competitorId,
    changeType: e.changeType,
    severity: e.severity,
    detectedAt: e.detectedAt,
    oldValue: e.oldValue,
    newValue: e.newValue,
    currency: e.currency,
    percentageChange: e.percentageChange,
  }));
}

/**
 * Phase 10: composes the existing pattern/derived-fact layer into one
 * per-organization, evidence-linked feed - see
 * PHASE9-PRODUCT-DIRECTION-AUDIT.md Section 14 for the product rationale
 * and PHASE10-VALIDATION-REPORT.md for the full design/validation record.
 *
 * Scope: every ACTIVELY TRACKED (isActive: true) competitor for this
 * organization - matches dailyReports.ts's countActiveCompetitorsForOrg
 * convention exactly, so the digest's "N of M tracked competitors" count
 * never silently diverges from the daily report's "N competitors
 * monitored" vocabulary (PHASE9 Section 15's open question, resolved here
 * by reusing the exact same `isActive: true` scope, not a new definition
 * of "tracked").
 *
 * ZERO new baseline formula, ZERO new schema, ZERO AI calls - every item
 * is either a direct ChangeEvent row or a verbatim Phase 7
 * ActivityPattern/RepeatedPriceChangePattern object.
 *
 * `now` is an injectable parameter (default `new Date()`, same convention
 * as getActivityPattern/getRepeatedPriceChangePatterns) and is threaded
 * through EVERY sub-call and the raw ChangeEvent fetch below, so all three
 * data sources compute against the EXACT same [now-days, now) window -
 * without this, two separately-taken `new Date()` timestamps a few
 * milliseconds apart could disagree at a boundary and make the digest's
 * "current" counts inconsistent with its own evidence list. This also
 * makes the whole function deterministically testable.
 *
 * Deliberately does NOT call getProductLifecycleSummary /
 * getCompetitorActivityMetrics for the lifecycle roll-up: those functions
 * do not accept an injectable `now` (they always resolve their own window
 * via `new Date()` at call time), which would both break the
 * single-shared-`now` guarantee above and require a second per-competitor
 * query pair on top of the bulk fetch this function already does. Added/
 * removed counts are instead derived directly from the same raw
 * ChangeEvent window already fetched for the CHANGE_EVENT items - the
 * numbers are provably identical (same organizationId/competitorId/
 * changeType/window), just computed once, deterministically, in memory.
 */
export async function getDigestForOrganization(
  organizationId: string,
  days: number,
  timezone: string | null | undefined = "UTC",
  now: Date = new Date(),
): Promise<DigestResult> {
  const window = resolveComparisonWindow(days, timezone, now);

  const competitors = await prisma.competitor.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, name: true },
  });

  const emptyResult: DigestResult = {
    days,
    timezone: window.timezone,
    windowStart: window.currentStart,
    windowEnd: window.currentEnd,
    totalTrackedCompetitors: 0,
    items: [],
    crossCompetitorContext: { aboveBaselineCount: 0, sustainedCount: 0, totalTrackedCompetitors: 0 },
  };
  if (competitors.length === 0) return emptyResult;

  const competitorIds = competitors.map((c) => c.id);
  const nameById = new Map(competitors.map((c) => [c.id, c.name]));

  const rawEvents = await listRecentChangeEventsForDigest(organizationId, competitorIds, window.currentStart, window.currentEnd);
  const eventsByCompetitor = new Map<string, DigestRawChangeEvent[]>();
  for (const event of rawEvents) {
    const list = eventsByCompetitor.get(event.competitorId);
    if (list) list.push(event);
    else eventsByCompetitor.set(event.competitorId, [event]);
  }

  const perCompetitorResults = await Promise.all(
    competitors.map(async (competitor) => {
      const [activityPattern, repeatedPricePatterns, sustainedActivityTrend] = await Promise.all([
        getActivityPattern(organizationId, competitor.id, days, now),
        getRepeatedPriceChangePatterns(organizationId, competitor.id, days, now),
        getSustainedActivityTrend(organizationId, competitor.id, days, now),
      ]);
      const events = eventsByCompetitor.get(competitor.id) ?? [];
      const items: DigestItem[] = [];

      // 1. Raw verified changes - always eligible, no qualification gate.
      for (const event of events) {
        items.push({
          kind: "CHANGE_EVENT",
          competitorId: competitor.id,
          competitorName: competitor.name,
          detectedAt: event.detectedAt,
          changeEventIds: [event.id],
          changeEventId: event.id,
          changeType: event.changeType,
          severity: event.severity,
          description: describeChangeEvent(event),
        });
      }

      // 2. Qualifying repeated price-change patterns - reused verbatim, changeCount >= 2 only.
      for (const pattern of repeatedPricePatterns) {
        if (!pattern.qualifies) continue;
        items.push({
          kind: "REPEATED_PRICE_CHANGE",
          competitorId: competitor.id,
          competitorName: competitor.name,
          // qualifies implies changeCount >= 2, so lastChangeAt is always set.
          detectedAt: pattern.lastChangeAt ?? window.currentEnd,
          changeEventIds: pattern.changeEventIds,
          pattern,
        });
      }

      // 3. Qualifying activity-vs-own-baseline pattern - ONLY when it qualifies
      // AND there is at least one real ChangeEvent in the current window to
      // cite as evidence (a qualifying pattern with zero current-window
      // events - e.g. AT_BASELINE with both sides 0 - would have no
      // ChangeEvent to point to, and Section 15 forbids an unsupported
      // item; the raw activity is fully described by (1) above in that case).
      if (activityPattern.qualifies && events.length > 0) {
        items.push({
          kind: "ACTIVITY_PATTERN",
          competitorId: competitor.id,
          competitorName: competitor.name,
          detectedAt: events[0]!.detectedAt, // events are already sorted desc by the bulk query
          changeEventIds: events.map((e) => e.id),
          pattern: activityPattern,
        });
      }

      // 3.5. Sustained multi-window activity trend (Phase 16) - reuses the
      // already-computed, unmodified getSustainedActivityTrend verbatim
      // (Phase 14B). Gated on `sustained === true` (mirroring every other
      // item's own qualification gate) AND at least one real ChangeEvent in
      // the current window to cite as evidence - same dual-condition
      // rationale as the ACTIVITY_PATTERN gate above: a sustained
      // BELOW_BASELINE streak can have `current.current === 0` (fewer
      // changes than baseline can legitimately mean zero), which would
      // leave no ChangeEvent to point to - see PHASE15-INTELLIGENCE-VALUE-AUDIT.md
      // Section 9.5 / PHASE16 brief Section 12 (never an empty evidence list).
      if (sustainedActivityTrend.sustained && events.length > 0) {
        items.push({
          kind: "SUSTAINED_ACTIVITY_TREND",
          competitorId: competitor.id,
          competitorName: competitor.name,
          detectedAt: events[0]!.detectedAt, // events are already sorted desc by the bulk query
          changeEventIds: events.map((e) => e.id),
          consecutiveQualifyingWindows: sustainedActivityTrend.consecutiveQualifyingWindows,
          // sustained === true guarantees offset-0's own direction is non-neutral (see
          // getSustainedActivityTrend's doc comment: AT_BASELINE always breaks the streak at
          // offset-0) - same narrowing convention as SustainedTrendCard.tsx.
          direction: sustainedActivityTrend.current.direction === "BELOW_BASELINE" ? "BELOW_BASELINE" : "ABOVE_BASELINE",
        });
      }

      // 4. Lifecycle roll-up - only when something was actually added/removed
      // in this window (derived from the same `events`, see the function
      // doc comment above for why this is not a second getProductLifecycleSummary call).
      const addedEvents = events.filter((e) => e.changeType === "PRODUCT_ADDED");
      const removedEvents = events.filter((e) => e.changeType === "PRODUCT_REMOVED");
      if (addedEvents.length > 0 || removedEvents.length > 0) {
        const lifecycleEvents = [...addedEvents, ...removedEvents];
        items.push({
          kind: "LIFECYCLE",
          competitorId: competitor.id,
          competitorName: competitor.name,
          detectedAt: lifecycleEvents.reduce((max, e) => (e.detectedAt > max ? e.detectedAt : max), lifecycleEvents[0]!.detectedAt),
          changeEventIds: lifecycleEvents.map((e) => e.id),
          added: addedEvents.length,
          removed: removedEvents.length,
        });
      }

      return { competitorId: competitor.id, activityPattern, sustainedActivityTrend, items };
    }),
  );

  const items = perCompetitorResults.flatMap((r) => r.items).sort(compareDigestItems);
  const aboveBaselineCount = perCompetitorResults.filter((r) => r.activityPattern.direction === "ABOVE_BASELINE").length;
  const sustainedCount = perCompetitorResults.filter((r) => r.sustainedActivityTrend.sustained).length;

  return {
    days,
    timezone: window.timezone,
    windowStart: window.currentStart,
    windowEnd: window.currentEnd,
    totalTrackedCompetitors: competitors.length,
    items,
    crossCompetitorContext: { aboveBaselineCount, sustainedCount, totalTrackedCompetitors: competitors.length },
  };
}
