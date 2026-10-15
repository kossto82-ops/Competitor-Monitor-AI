import type { SignalKind } from "./signalRules.js";

/**
 * Phase 29 E1: patterns across competitors. A signal says one competitor did something; a pattern says several
 * of them did the same thing in the same period, which is the only thing a single page can never show. It is an
 * INTERPRETATION of facts (the signals), never a fact itself, and it is only claimed when the sample is large
 * enough: too few competitors, or too little history, produces no pattern and a stated reason instead.
 *
 * Deterministic and pure. Directions are never mixed (a rise and a fall are different patterns), every affected
 * competitor is named, and every signal behind the pattern is kept as evidence, not only the latest.
 */
export const MARKET_PATTERN_KINDS = ["MARKET_PRICES_UP", "MARKET_PRICES_DOWN", "MARKET_PLANS_ADDED", "MARKET_PLANS_REMOVED", "MARKET_PROMOTIONS"] as const;
export type MarketPatternKind = (typeof MARKET_PATTERN_KINDS)[number];

export const MARKET_PATTERN_RULE_VERSION = 1;

export interface MarketPatternConfig {
  /** How far back the signals count. */
  windowDays: number;
  /** Competitors with at least `minHistoryDays` of verified observation that must exist before any pattern is claimed. */
  minObservedCompetitors: number;
  minHistoryDays: number;
  /** At least this many competitors did the thing, and at least this share of those observed. */
  minAffected: number;
  minShare: number;
}

export const DEFAULT_MARKET_PATTERN_CONFIG: MarketPatternConfig = {
  windowDays: 30,
  minObservedCompetitors: 3,
  minHistoryDays: 14,
  minAffected: 2,
  minShare: 0.4,
};

const KIND_FOR_SIGNAL: Partial<Record<SignalKind, MarketPatternKind>> = {
  PRICE_INCREASE: "MARKET_PRICES_UP",
  PRICE_DECREASE: "MARKET_PRICES_DOWN",
  PLAN_ADDED: "MARKET_PLANS_ADDED",
  PLAN_REMOVED: "MARKET_PLANS_REMOVED",
  PROMOTION_STARTED: "MARKET_PROMOTIONS",
};

export interface SignalForPattern {
  id: string;
  kind: SignalKind;
  competitorId: string;
  occurredAt: Date;
  percentageChange: number | null;
}

export interface ObservedCompetitor {
  id: string;
  name: string;
  /** When its first verified scan happened: how long we have really been looking at it. */
  observedSince: Date;
}

export interface AffectedCompetitor {
  competitorId: string;
  name: string;
  signalIds: string[];
  firstAt: Date;
  lastAt: Date;
  /** The size of the biggest price move, for price patterns. */
  largestPercentageChange: number | null;
}

export interface MarketPattern {
  kind: MarketPatternKind;
  ruleVersion: number;
  /** An interpretation of facts: never presented as one. */
  epistemicLevel: "INTERPRETATION";
  windowStart: Date;
  windowEnd: Date;
  affected: AffectedCompetitor[];
  affectedCount: number;
  observedCount: number;
  /** affectedCount / observedCount. */
  share: number;
  summary: string;
}

export type MarketPatternResult =
  | { status: "INSUFFICIENT_SAMPLE"; reason: string; observedCount: number; eligibleCount: number; patterns: [] }
  | { status: "EVALUATED"; observedCount: number; eligibleCount: number; patterns: MarketPattern[] };

const DAY_MS = 24 * 60 * 60_000;

function phrase(kind: MarketPatternKind): string {
  const verb: Record<MarketPatternKind, string> = {
    MARKET_PRICES_UP: "raised prices",
    MARKET_PRICES_DOWN: "lowered prices",
    MARKET_PLANS_ADDED: "added a plan",
    MARKET_PLANS_REMOVED: "removed a plan",
    MARKET_PROMOTIONS: "started a promotion",
  };
  return verb[kind];
}

function describeAffected(kind: MarketPatternKind, a: AffectedCompetitor): string {
  if ((kind === "MARKET_PRICES_UP" || kind === "MARKET_PRICES_DOWN") && a.largestPercentageChange !== null) {
    const pct = Math.round(Math.abs(a.largestPercentageChange) * 10) / 10;
    return `${a.name} (${kind === "MARKET_PRICES_UP" ? "+" : "-"}${pct}%)`;
  }
  return a.name;
}

/**
 * Finds the patterns among `signals` over the last `windowDays`. Only competitors with enough verified history
 * count in the sample: a competitor we only just started watching cannot be said to have "not done" something.
 */
export function detectMarketPatterns(
  signals: readonly SignalForPattern[],
  competitors: readonly (ObservedCompetitor & { observedSince: Date })[],
  now: Date,
  config: MarketPatternConfig = DEFAULT_MARKET_PATTERN_CONFIG,
): MarketPatternResult {
  const windowStart = new Date(now.getTime() - config.windowDays * DAY_MS);
  const eligible = competitors.filter((c) => now.getTime() - c.observedSince.getTime() >= config.minHistoryDays * DAY_MS);
  const eligibleIds = new Set(eligible.map((c) => c.id));

  if (eligible.length < config.minObservedCompetitors) {
    const days = competitors.map((c) => Math.floor((now.getTime() - c.observedSince.getTime()) / DAY_MS)).sort((a, b) => b - a);
    return {
      status: "INSUFFICIENT_SAMPLE",
      reason:
        `Patterns need at least ${config.minObservedCompetitors} competitors watched for ${config.minHistoryDays} days or more; ` +
        `${eligible.length} of ${competitors.length} qualify${days.length > 0 ? ` (the longest history is ${days[0]} day${days[0] === 1 ? "" : "s"})` : ""}.`,
      observedCount: competitors.length,
      eligibleCount: eligible.length,
      patterns: [],
    };
  }

  const byKind = new Map<MarketPatternKind, Map<string, AffectedCompetitor>>();
  const nameOf = new Map(eligible.map((c) => [c.id, c.name]));
  for (const signal of signals) {
    const kind = KIND_FOR_SIGNAL[signal.kind];
    if (!kind || !eligibleIds.has(signal.competitorId)) continue;
    if (signal.occurredAt < windowStart || signal.occurredAt > now) continue;
    const group = byKind.get(kind) ?? new Map<string, AffectedCompetitor>();
    const existing = group.get(signal.competitorId);
    const pct = signal.percentageChange === null ? null : Math.abs(signal.percentageChange);
    if (existing) {
      existing.signalIds.push(signal.id);
      if (signal.occurredAt < existing.firstAt) existing.firstAt = signal.occurredAt;
      if (signal.occurredAt > existing.lastAt) existing.lastAt = signal.occurredAt;
      if (pct !== null && (existing.largestPercentageChange === null || pct > existing.largestPercentageChange)) existing.largestPercentageChange = pct;
    } else {
      group.set(signal.competitorId, {
        competitorId: signal.competitorId,
        name: nameOf.get(signal.competitorId) ?? signal.competitorId,
        signalIds: [signal.id],
        firstAt: signal.occurredAt,
        lastAt: signal.occurredAt,
        largestPercentageChange: pct,
      });
    }
    byKind.set(kind, group);
  }

  const patterns: MarketPattern[] = [];
  for (const kind of MARKET_PATTERN_KINDS) {
    const group = byKind.get(kind);
    if (!group) continue;
    const affected = [...group.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime() || a.name.localeCompare(b.name));
    const share = affected.length / eligible.length;
    if (affected.length < config.minAffected || share < config.minShare) continue;
    const list = affected.map((a) => describeAffected(kind, a)).join(", ");
    patterns.push({
      kind,
      ruleVersion: MARKET_PATTERN_RULE_VERSION,
      epistemicLevel: "INTERPRETATION",
      windowStart,
      windowEnd: now,
      affected,
      affectedCount: affected.length,
      observedCount: eligible.length,
      share: Math.round(share * 1000) / 1000,
      summary: `${affected.length} of ${eligible.length} competitors ${phrase(kind)} in the last ${config.windowDays} days: ${list}.`,
    });
  }
  patterns.sort((a, b) => b.share - a.share || a.kind.localeCompare(b.kind));
  return { status: "EVALUATED", observedCount: competitors.length, eligibleCount: eligible.length, patterns };
}
