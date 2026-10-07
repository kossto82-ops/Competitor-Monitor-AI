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
 * - HEALTHY  : the latest attempt succeeded and the data is fresh.
 */
export const SOURCE_HEALTH_STATES = ["HEALTHY", "DEGRADED", "STALE", "PENDING", "PAUSED", "DISABLED"] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATES)[number];

export const STALE_CADENCE_MULTIPLE = 3;
export const STALE_MIN_MS = 48 * 60 * 60_000;

export interface SourceHealthInput {
  isActive: boolean;
  disabledAt?: Date | null;
  consecutiveFailureCount: number;
  lastSuccessfulScanAt: Date | null;
  lastAttemptAt: Date | null;
  scanFrequencyMinutes: number;
  createdAt: Date;
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
  return { state: "HEALTHY", reason: "The latest scan succeeded." };
}
