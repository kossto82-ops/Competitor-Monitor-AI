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
import { calculatePeriodDelta, resolveComparisonWindow, type PeriodDelta } from "@cma/core";
import type { ChangeType } from "../../generated/client/index.js";
import { prisma } from "../client.js";

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
  const urls = await prisma.monitoredUrl.findMany({ where: { organizationId, competitorId }, select: { id: true } });
  const urlIds = urls.map((u) => u.id);
  if (urlIds.length === 0) return null;
  const latest = await prisma.changeEvent.findFirst({
    where: { organizationId, monitoredUrlId: { in: urlIds } },
    orderBy: { detectedAt: "desc" },
    select: { detectedAt: true },
  });
  return latest?.detectedAt ?? null;
}
