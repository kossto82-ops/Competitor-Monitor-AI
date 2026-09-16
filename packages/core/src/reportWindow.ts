/**
 * Phase 4 (Section 3): pure, DB-free logic for turning "which calendar
 * day, in which organization's timezone" into concrete UTC instants a
 * repository query can use directly (`detectedAt >= startUtc AND
 * detectedAt < endUtc`). Deliberately has zero Prisma/DB dependency so
 * it can be unit tested exhaustively (DST transitions, missing
 * timezone, month/year rollover) without a database.
 *
 * Section 3 explicitly asks NOT to overbuild timezone management here -
 * this is the calendar-day model the brief calls "acceptable for the
 * first implementation", nothing more sophisticated (no
 * previous-report-to-current-report period diffing yet).
 */

/** The documented safe default (Section 3) when an organization has no timezone configured. */
export const DEFAULT_REPORT_TIMEZONE = "UTC";

export interface ReportWindow {
  /** The calendar date this window represents, in `timezone` - e.g. "2026-09-16". */
  reportDate: string;
  timezone: string;
  /** Inclusive UTC instant the window starts at. */
  startUtc: Date;
  /** Exclusive UTC instant the window ends at. */
  endUtc: Date;
}

/**
 * Falls back to DEFAULT_REPORT_TIMEZONE for a missing/blank value AND
 * for a value `Intl` does not recognize as a valid IANA zone - a typo'd
 * or corrupted timezone string must never silently produce a
 * window computed against the WRONG zone; it degrades to the documented
 * UTC default instead; never crashes report generation.
 */
export function normalizeOrgTimezone(timezone: string | null | undefined): string {
  const trimmed = timezone?.trim();
  if (!trimmed) return DEFAULT_REPORT_TIMEZONE;
  try {
    // Constructing the formatter is enough to validate the zone name -
    // an unrecognized IANA name throws RangeError here.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return trimmed;
  } catch {
    return DEFAULT_REPORT_TIMEZONE;
  }
}

export function parseReportDate(reportDate: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reportDate);
  if (!match) {
    throw new Error(`Invalid reportDate "${reportDate}" - expected "YYYY-MM-DD"`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The UTC offset (in ms, `local - utc`) that `timeZone` observes at the instant `instantMs`. */
function offsetMsAt(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asIfUtc - instantMs;
}

/**
 * The UTC instant corresponding to local midnight of (year, month, day)
 * in `timeZone`. Two passes: the first computes the offset at a naive
 * UTC-midnight guess, the second re-derives the offset at the corrected
 * instant - correct even when a DST transition happens to land exactly
 * at local midnight for this zone (rare, but cheap to guard against a
 * one-hour-off report boundary).
 */
function localMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const naiveUtcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = naiveUtcGuess - offsetMsAt(naiveUtcGuess, timeZone);
  instant = naiveUtcGuess - offsetMsAt(instant, timeZone);
  return new Date(instant);
}

/**
 * Resolves the [startUtc, endUtc) window for one organization-local
 * calendar day. `timezone` is normalized (falls back to UTC) so this
 * function never throws for a missing/invalid organization timezone -
 * only `reportDate` itself must be well-formed.
 */
export function resolveOrgLocalDayWindow(reportDate: string, timezone: string | null | undefined): ReportWindow {
  const tz = normalizeOrgTimezone(timezone);
  const { year, month, day } = parseReportDate(reportDate);

  const startUtc = localMidnightToUtc(year, month, day, tz);

  // Next calendar day, computed via plain (y, m, d) arithmetic (JS
  // Date.UTC normalizes a day value that overflows the month/year), NOT
  // by adding 24h to `startUtc` - a DST transition during the day would
  // otherwise shift which local calendar day midnight+24h actually
  // lands on.
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const endUtc = localMidnightToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), tz);

  return { reportDate, timezone: tz, startUtc, endUtc };
}

/** Today's reportDate string ("YYYY-MM-DD") as seen in `timezone` right now - what the scheduler enqueues by default. */
export function currentReportDateInTimezone(timezone: string | null | undefined, now: Date = new Date()): string {
  const tz = normalizeOrgTimezone(timezone);
  // en-CA formats as YYYY-MM-DD directly - avoids hand-parsing locale-specific output.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
