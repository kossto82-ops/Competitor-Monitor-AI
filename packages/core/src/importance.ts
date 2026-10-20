import type { SignalKind } from "./signalRules.js";

/**
 * Phase 29 D3: how much a signal matters, as a sum of named factors that can each be shown to the customer.
 * No hidden score and no AI: every factor is a number from 0 to 1 computed by a plain rule, multiplied by a
 * weight from a versioned configuration, and the result carries the breakdown and a sentence per factor.
 *
 * Importance and confidence are different questions and are never mixed: importance asks "if this is true,
 * how much should I care?", confidence asks "how sure are we that it is true?". A signal can be very
 * important and uncertain (a big price drop seen once), or certain and unimportant (a footer text change).
 */
export const IMPORTANCE_FACTORS = ["magnitude", "kind", "recency", "relevance", "corroboration", "history", "repetition"] as const;
export type ImportanceFactor = (typeof IMPORTANCE_FACTORS)[number];

export interface ImportanceConfig {
  /** Bumped whenever weights or emphasis change; every breakdown says which version produced it. */
  version: number;
  /** Non-negative; they are normalised to sum to 1 when used, so only their proportions matter. */
  weights: Record<ImportanceFactor, number>;
  /** The customer's strategic emphasis per kind of signal, 0 to 1 (what they care about most). */
  kindEmphasis: Record<SignalKind, number>;
  /** Importance at or above these values is tier HIGH / MEDIUM; anything below is LOW. */
  tiers: { high: number; medium: number };
  /** Days after which a signal's recency factor has halved. */
  recencyHalfLifeDays: number;
}

export const DEFAULT_IMPORTANCE_CONFIG: ImportanceConfig = {
  version: 1,
  // What happened (magnitude, kind, history, corroboration) carries most of the weight; recency, relevance and
  // repetition only shape it. Otherwise every fresh signal would start with a high floor, text changes included.
  weights: { magnitude: 0.3, kind: 0.25, recency: 0.1, relevance: 0.05, corroboration: 0.1, history: 0.1, repetition: 0.1 },
  kindEmphasis: {
    PRICE_INCREASE: 1,
    PRICE_DECREASE: 1,
    PLAN_ADDED: 0.8,
    PLAN_REMOVED: 0.8,
    PROMOTION_STARTED: 0.6,
    PROMOTION_CHANGED: 0.6,
    PROMOTION_ENDED: 0.5,
    CONTENT_UPDATE: 0.15,
    CAPABILITY_ADDED: 0.5,
    CAPABILITY_REMOVED: 0.45,
  },
  tiers: { high: 65, medium: 40 },
  recencyHalfLifeDays: 7,
};

/** Relevance of a competitor to the customer: 1 low, 2 normal, 3 high. */
export type CompetitorRelevance = 1 | 2 | 3;

export interface SignalForScoring {
  id: string;
  kind: SignalKind;
  entityKey: string | null;
  percentageChange: number | null;
  confidence: number;
  occurredAt: Date;
  monitoredUrlId: string;
  competitorId: string;
}

export interface ScoringContext {
  now: Date;
  /** Missing competitors count as normal (2). */
  competitorRelevance: ReadonlyMap<string, CompetitorRelevance>;
  /** Every signal of the last ~30 days (including the ones being scored): repetition and corroboration come from it. */
  recentSignals: readonly SignalForScoring[];
  /** Earlier verified changes of an entity (`${monitoredUrlId}|${entityKey}` -> count): how unusual a change is for it. */
  priorChangesByEntity: ReadonlyMap<string, number>;
}

export interface FactorBreakdown {
  factor: ImportanceFactor;
  /** 0 to 1, from the rule. */
  value: number;
  /** The normalised weight actually applied. */
  weight: number;
  /** value x weight, in importance points (0-100 scale). */
  points: number;
  explanation: string;
}

export type ImportanceTier = "HIGH" | "MEDIUM" | "LOW";

export interface ScoredSignal {
  signalId: string;
  importance: number;
  tier: ImportanceTier;
  /** Passed through untouched: how sure we are that the signal is true. */
  confidence: number;
  configVersion: number;
  factors: FactorBreakdown[];
}

const DAY_MS = 24 * 60 * 60_000;
const CORROBORATION_WINDOW_DAYS = 14;
const REPETITION_WINDOW_DAYS = 30;
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function normalisedWeights(config: ImportanceConfig): Record<ImportanceFactor, number> {
  const total = IMPORTANCE_FACTORS.reduce((sum, f) => sum + Math.max(0, config.weights[f]), 0);
  const out = {} as Record<ImportanceFactor, number>;
  for (const f of IMPORTANCE_FACTORS) out[f] = total > 0 ? Math.max(0, config.weights[f]) / total : 1 / IMPORTANCE_FACTORS.length;
  return out;
}

function magnitudeOf(signal: SignalForScoring): { value: number; explanation: string } {
  switch (signal.kind) {
    case "PRICE_INCREASE":
    case "PRICE_DECREASE": {
      if (signal.percentageChange === null) return { value: 0.4, explanation: "The size of the price change is unknown." };
      const pct = Math.abs(signal.percentageChange);
      return { value: clamp01(pct / 50), explanation: `A ${round1(pct)}% price change (50% or more counts as the largest).` };
    }
    case "PLAN_ADDED":
    case "PLAN_REMOVED":
      return { value: 0.7, explanation: "A plan appearing or disappearing is a structural change." };
    case "PROMOTION_STARTED":
    case "PROMOTION_CHANGED":
    case "PROMOTION_ENDED":
      return { value: 0.5, explanation: "A promotion is temporary and narrower than a price or plan change." };
    case "CAPABILITY_ADDED":
    case "CAPABILITY_REMOVED":
      return { value: 0.5, explanation: "A change in what the page says the service offers; the claim, not necessarily the service." };
    case "CONTENT_UPDATE":
      return { value: 0.1, explanation: "A text change that no price, plan or promotion explains." };
  }
}

/** Scores one signal; the context carries what the factors need to know about everything else. */
export function scoreSignal(signal: SignalForScoring, context: ScoringContext, config: ImportanceConfig = DEFAULT_IMPORTANCE_CONFIG): ScoredSignal {
  const weights = normalisedWeights(config);
  const ageDays = Math.max(0, (context.now.getTime() - signal.occurredAt.getTime()) / DAY_MS);

  const magnitude = magnitudeOf(signal);
  const emphasis = clamp01(config.kindEmphasis[signal.kind] ?? 0.5);
  const recency = Math.pow(0.5, ageDays / Math.max(0.1, config.recencyHalfLifeDays));
  const relevance = (context.competitorRelevance.get(signal.competitorId) ?? 2) / 3;

  const competitorsSameKind = new Set(
    context.recentSignals
      .filter((s) => s.kind === signal.kind && (context.now.getTime() - s.occurredAt.getTime()) / DAY_MS <= CORROBORATION_WINDOW_DAYS)
      .map((s) => s.competitorId),
  );
  competitorsSameKind.add(signal.competitorId);
  const corroboration = clamp01((competitorsSameKind.size - 1) / 3);

  const sameSourceRecent = context.recentSignals.filter(
    (s) => s.id !== signal.id && s.kind === signal.kind && s.monitoredUrlId === signal.monitoredUrlId && (context.now.getTime() - s.occurredAt.getTime()) / DAY_MS <= REPETITION_WINDOW_DAYS,
  ).length;
  const repetition = 1 / (1 + 0.5 * sameSourceRecent);

  const isPriceOrPlan = signal.entityKey !== null;
  const priorChanges = isPriceOrPlan ? (context.priorChangesByEntity.get(`${signal.monitoredUrlId}|${signal.entityKey}`) ?? 0) : null;
  const history = priorChanges === null ? 0 : 1 / (1 + priorChanges);

  const rows: Record<ImportanceFactor, { value: number; explanation: string }> = {
    magnitude,
    kind: { value: emphasis, explanation: `Your emphasis on this kind of change is ${Math.round(emphasis * 100)}%.` },
    recency: { value: recency, explanation: `Seen ${round1(ageDays)} days ago; its weight halves every ${config.recencyHalfLifeDays} days.` },
    relevance: { value: relevance, explanation: `This competitor is marked ${["", "low", "normal", "high"][context.competitorRelevance.get(signal.competitorId) ?? 2]} relevance.` },
    corroboration: {
      value: corroboration,
      explanation:
        competitorsSameKind.size > 1
          ? `${competitorsSameKind.size} competitors showed this kind of change in the last ${CORROBORATION_WINDOW_DAYS} days.`
          : `No other competitor showed this kind of change in the last ${CORROBORATION_WINDOW_DAYS} days.`,
    },
    history: {
      value: history,
      explanation:
        priorChanges === null
          ? "Not tied to a price or plan, so history does not apply."
          : priorChanges === 0
            ? "The first change ever seen on this price or plan."
            : `${priorChanges} earlier change${priorChanges === 1 ? "" : "s"} on this price or plan, so this one is less unusual.`,
    },
    repetition: {
      value: repetition,
      explanation:
        sameSourceRecent === 0
          ? "Nothing similar from this page in the last 30 days."
          : `${sameSourceRecent} similar signal${sameSourceRecent === 1 ? "" : "s"} from this page in the last 30 days, which makes this one less informative.`,
    },
  };

  const factors: FactorBreakdown[] = IMPORTANCE_FACTORS.map((factor) => ({
    factor,
    value: Math.round(rows[factor].value * 1000) / 1000,
    weight: Math.round(weights[factor] * 1000) / 1000,
    points: round1(rows[factor].value * weights[factor] * 100),
    explanation: rows[factor].explanation,
  }));
  const importance = Math.round(IMPORTANCE_FACTORS.reduce((sum, f) => sum + rows[f].value * weights[f], 0) * 100);
  const tier: ImportanceTier = importance >= config.tiers.high ? "HIGH" : importance >= config.tiers.medium ? "MEDIUM" : "LOW";
  return { signalId: signal.id, importance, tier, confidence: signal.confidence, configVersion: config.version, factors };
}

/** Scores every signal and orders them by importance, newest first among equals. */
export function prioritizeSignals(signals: readonly SignalForScoring[], context: ScoringContext, config: ImportanceConfig = DEFAULT_IMPORTANCE_CONFIG): ScoredSignal[] {
  const occurredAt = new Map(signals.map((s) => [s.id, s.occurredAt.getTime()]));
  return signals
    .map((s) => scoreSignal(s, context, config))
    .sort((a, b) => b.importance - a.importance || (occurredAt.get(b.signalId) ?? 0) - (occurredAt.get(a.signalId) ?? 0));
}

/** The first problem with a configuration, or null when it can be saved. */
export function validateImportanceConfig(config: Pick<ImportanceConfig, "weights" | "kindEmphasis" | "tiers" | "recencyHalfLifeDays">): string | null {
  for (const f of IMPORTANCE_FACTORS) {
    const w = config.weights[f];
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0) return `The weight of "${f}" must be a number of 0 or more.`;
  }
  if (IMPORTANCE_FACTORS.every((f) => config.weights[f] === 0)) return "At least one weight must be above 0.";
  for (const [kind, value] of Object.entries(config.kindEmphasis)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return `The emphasis on "${kind}" must be between 0 and 1.`;
  }
  if (!(config.tiers.high > config.tiers.medium && config.tiers.medium >= 0 && config.tiers.high <= 100)) return "Tier thresholds must satisfy 0 <= medium < high <= 100.";
  if (!(config.recencyHalfLifeDays > 0 && config.recencyHalfLifeDays <= 365)) return "The recency half-life must be between 0 and 365 days.";
  return null;
}
