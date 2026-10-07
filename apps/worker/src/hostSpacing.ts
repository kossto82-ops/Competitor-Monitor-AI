/**
 * Phase 29 B1: spreads the jobs that target the same site over time.
 *
 * Without this, five monitored URLs of one competitor become due on the same tick and are fetched
 * at the same moment - a burst that looks like abuse to the competitor's bot protection and is the
 * likeliest way to get a source blocked. The first URL of each host runs immediately; each further
 * one is delayed by `spacingMs` more, plus a random jitter so recurring ticks never line up.
 * Different hosts never delay each other.
 */
export interface HostSpacingOptions {
  spacingMs: number;
  jitterMs: number;
  /** Injectable for deterministic tests; must return a number in [0, 1). */
  random?: () => number;
  /** Upper bound so a competitor with very many URLs cannot push jobs past the next tick. */
  maxDelayMs?: number;
}

export function planHostDelays<T extends { url: string }>(items: T[], hostOf: (url: string) => string | null, options: HostSpacingOptions): number[] {
  const random = options.random ?? Math.random;
  const maxDelayMs = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  const seenPerHost = new Map<string, number>();

  return items.map((item) => {
    const host = hostOf(item.url);
    if (!host) return 0;
    const position = seenPerHost.get(host) ?? 0;
    seenPerHost.set(host, position + 1);
    if (position === 0) return 0;
    const jitter = options.jitterMs > 0 ? Math.floor(random() * options.jitterMs) : 0;
    return Math.min(position * options.spacingMs + jitter, maxDelayMs);
  });
}

function readNonNegativeMs(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const DEFAULT_HOST_SPACING_MS = 30_000;
export const DEFAULT_HOST_JITTER_MS = 10_000;

export function readHostSpacingFromEnv(): HostSpacingOptions {
  return {
    spacingMs: readNonNegativeMs("CMA_SCHEDULER_HOST_SPACING_MS", DEFAULT_HOST_SPACING_MS),
    jitterMs: readNonNegativeMs("CMA_SCHEDULER_HOST_JITTER_MS", DEFAULT_HOST_JITTER_MS),
    // Stay well inside the 15-minute tick: a delayed job must not still be waiting at the next one.
    maxDelayMs: 10 * 60_000,
  };
}
