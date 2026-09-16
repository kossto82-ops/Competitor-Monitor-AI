/**
 * Phase 6 (Section 5): reusable time-window logic for historical
 * competitive-intelligence queries - "last N days" plus the "previous
 * equivalent period" needed for period-over-period comparison
 * ("8 changes this month vs 5 last month").
 *
 * Deliberately pure and DB-free, like reportWindow.ts, so it can be unit
 * tested exhaustively (DST, missing timezone, boundary math) without a
 * database. Built on the same organization-timezone-aware "local
 * midnight" primitive as reportWindow.ts (Phase 4, Section 3) rather than
 * duplicating offset arithmetic.
 *
 * Windows are always [start, end) - inclusive start, exclusive end - so a
 * ChangeEvent's `detectedAt` falls into exactly one of "current" or
 * "previous" and never both, and there is never a hairline gap at the
 * boundary between the two.
 */
import { normalizeOrgTimezone } from "./reportWindow.js";

export interface ComparisonWindow {
  /** [currentStart, now) - inclusive start, exclusive end (now, at call time). */
  currentStart: Date;
  currentEnd: Date;
  /** [previousStart, previousEnd) - the immediately preceding period of the same length. */
  previousStart: Date;
  previousEnd: Date;
  days: number;
  timezone: string;
}

/** The historical-intelligence windows this product surfaces (Section 5: "at minimum"). */
export const ACTIVITY_PERIOD_DAYS = [7, 30, 90] as const;
export type ActivityPeriodDays = (typeof ACTIVITY_PERIOD_DAYS)[number];

/**
 * Resolves "the last `days` days" ending now, plus the equal-length
 * period immediately before it, both as concrete UTC instants.
 *
 * `timezone` is accepted (and normalized, mirroring reportWindow.ts) for
 * API symmetry with the rest of Phase 4/6 and so a future caller that
 * wants calendar-day-aligned windows has a single place to add that -
 * today's implementation is a rolling window (`now - N days`), not
 * calendar-day-aligned, because "last 7 days" for an activity metric is
 * conventionally a rolling window (unlike a daily report's "yesterday's
 * calendar day", which genuinely needs day alignment). This function
 * never throws for a missing/invalid timezone.
 */
export function resolveComparisonWindow(days: number, timezone: string | null | undefined = "UTC", now: Date = new Date()): ComparisonWindow {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`days must be a positive integer, got ${days}`);
  }
  const tz = normalizeOrgTimezone(timezone);
  const msPerDay = 24 * 60 * 60 * 1000;

  const currentEnd = now;
  const currentStart = new Date(now.getTime() - days * msPerDay);
  const previousEnd = currentStart;
  const previousStart = new Date(currentStart.getTime() - days * msPerDay);

  return { currentStart, currentEnd, previousStart, previousEnd, days, timezone: tz };
}

export interface PeriodDelta {
  current: number;
  previous: number;
  /** `current - previous`. Always defined. */
  absoluteChange: number;
  /**
   * `(current - previous) / previous * 100`, rounded to 2 decimals.
   * `null` when `previous` is 0 - a percentage-of-zero is undefined, and
   * the brief explicitly forbids ever displaying "Infinity%" (Section 6);
   * the UI must render an explicit "no prior activity" state instead.
   */
  percentageChange: number | null;
}

/** Pure arithmetic - the deterministic calculation behind every "current vs previous period" metric in Phase 6. */
export function calculatePeriodDelta(current: number, previous: number): PeriodDelta {
  const absoluteChange = current - previous;
  const percentageChange = previous === 0 ? null : Math.round(((current - previous) / previous) * 10000) / 100;
  return { current, previous, absoluteChange, percentageChange };
}
