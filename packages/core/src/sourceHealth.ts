/**
 * Phase 29 B2: the health of one monitored source, derived deterministically from facts the
 * pipeline already records. Nothing here is a score or a guess - each state has a plain rule, so
 * the UI and the alerts can always say exactly why a source is in that state.
 *
 * - DISABLED : the system stopped monitoring it after sustained failure (`disabledAt` set).
 * - PAUSED   : the customer paused it.
 * - PENDING  : never attempted yet.
 * - STALE    : the last good observation is older than the data can be trusted to represent today
 *              (more than STALE_CADENCE_MULTIPLE x the configured cadence, never less than 48 h),
 *              whether or not the latest attempts failed.
 * - DEGRADED : the latest attempt(s) failed, but the last good observation is still recent.
 * - PARTIAL  : scans succeed, but most of the recent ones could not be verified (the page did not show
 *              what we compare, e.g. a price configurator, or it alternates between two layouts), so
 *              changes are only detected on the few scans that could be compared.
 * - HEALTHY  : the latest attempt succeeded and the data is fresh.
 */
export const SOURCE_HEALTH_STATES = ["HEALTHY", "DEGRADED", "PARTIAL", "STALE", "PENDING", "PAUSED", "DISABLED"] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATES)[number];

export const STALE_CADENCE_MULTIPLE = 3;
export const STALE_MIN_MS = 48 * 60 * 60_000;
/** PARTIAL needs at least this many recent scans, and at least this share of them unverified. */
export const PARTIAL_MIN_SCANS = 6;
export const PARTIAL_UNVERIFIED_SHARE = 0.5;

export interface SourceHealthInput {
  isActive: boolean;
  disabledAt?: Date | null;
  consecutiveFailureCount: number;
  lastSuccessfulScanAt: Date | null;
  lastAttemptAt: Date | null;
  scanFrequencyMinutes: number;
  createdAt: Date;
  /** The most recent scans' outcomes (up to ~10); when absent the verification share is not judged. */
  recentScans?: { total: number; unverified: number };
}

export interface SourceHealth {
  state: SourceHealthState;
  /** Short, factual sentence for the UI; never speculates about the cause of a failure. */
  reason: string;
}

export function staleAfterMs(scanFrequencyMinutes: number): number {
  return Math.max(STALE_MIN_MS, STALE_CADENCE_MULTIPLE * scanFrequencyMinutes * 60_000);
}

export function deriveSourceHealth(source: SourceHealthInput, now: Date = new Date()): SourceHealth {
  if (source.disabledAt) {
    return { state: "DISABLED", reason: "Monitoring was stopped automatically after sustained failures." };
  }
  if (!source.isActive) return { state: "PAUSED", reason: "Paused." };
  if (!source.lastAttemptAt && !source.lastSuccessfulScanAt) {
    return { state: "PENDING", reason: "Not scanned yet." };
  }

  // The age of the last good observation; a source that never worked is aged from its creation.
  const referenceMs = (source.lastSuccessfulScanAt ?? source.createdAt).getTime();
  const ageMs = now.getTime() - referenceMs;
  if (ageMs > staleAfterMs(source.scanFrequencyMinutes)) {
    return {
      state: "STALE",
      reason: source.lastSuccessfulScanAt
        ? "The last successful scan is too old to represent the current page."
        : "No scan has succeeded since this source was added.",
    };
  }
  if (source.consecutiveFailureCount > 0) {
    return {
      state: "DEGRADED",
      reason: `The last ${source.consecutiveFailureCount} scan attempt(s) failed.`,
    };
  }
  const recent = source.recentScans;
  if (recent && recent.total >= PARTIAL_MIN_SCANS && recent.unverified / recent.total >= PARTIAL_UNVERIFIED_SHARE) {
    return {
      state: "PARTIAL",
      reason: `${recent.unverified} of the last ${recent.total} scans could not be verified (the page did not show comparable content), so changes are only detected on the scans that could.`,
    };
  }
  return { state: "HEALTHY", reason: "The latest scan succeeded." };
}
