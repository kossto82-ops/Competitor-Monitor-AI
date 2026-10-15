import type { FactorBreakdown, ImportanceTier } from "./importance.js";
import type { SignalKind } from "./signalRules.js";

/**
 * Phase 29 D4: when a signal becomes an alert, how urgent it is, and why. Everything is observable: a rule is a
 * name, a minimum importance, a minimum confidence and the kinds of signal it covers, and an alert always
 * carries the sentence that says which rule matched, with which numbers, and what the signal's strongest
 * reasons were. There is no alert without that explanation.
 */
export const ALERT_LEVELS = ["URGENT", "IMPORTANT", "NOTICE"] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

export const ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED", "DISMISSED"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface AlertRuleSpec {
  id: string;
  name: string;
  level: AlertLevel;
  /** The signal's importance (0-100) must be at least this. */
  minImportance: number;
  /** The signal's confidence (0-1) must be at least this. */
  minConfidence: number;
  /** The kinds of signal the rule covers; empty means all of them. */
  kinds: SignalKind[];
  enabled: boolean;
}

const PRICE_KINDS: SignalKind[] = ["PRICE_INCREASE", "PRICE_DECREASE"];
const PLAN_KINDS: SignalKind[] = ["PLAN_ADDED", "PLAN_REMOVED"];
const PROMOTION_KINDS: SignalKind[] = ["PROMOTION_STARTED", "PROMOTION_CHANGED", "PROMOTION_ENDED"];

/** What applies until an organization defines its own rules. Text-only changes never alert by default. */
export const DEFAULT_ALERT_RULES: AlertRuleSpec[] = [
  { id: "default-urgent-price", name: "Very large price change", level: "URGENT", minImportance: 80, minConfidence: 0.7, kinds: PRICE_KINDS, enabled: true },
  { id: "default-important-price-plan", name: "Important price or plan change", level: "IMPORTANT", minImportance: 65, minConfidence: 0.6, kinds: [...PRICE_KINDS, ...PLAN_KINDS], enabled: true },
  { id: "default-notice-promotion", name: "Promotion change", level: "NOTICE", minImportance: 40, minConfidence: 0.6, kinds: PROMOTION_KINDS, enabled: true },
];

/** A repeat of the same thing (same page, same plan, same kind) within this many hours joins the open alert. */
export const ALERT_COOLDOWN_HOURS = 24;

export interface SignalForAlert {
  id: string;
  kind: SignalKind;
  title: string;
  summary: string;
  entityKey: string | null;
  monitoredUrlId: string;
  competitorId: string;
  competitorName: string;
  confidence: number;
  occurredAt: Date;
  evidenceCount: number;
  importance: number;
  tier: ImportanceTier;
  factors: FactorBreakdown[];
}

export interface AlertDecision {
  level: AlertLevel;
  rule: AlertRuleSpec;
  /** Same page, same plan, same kind: signals with one key are repeats of each other. */
  dedupeKey: string;
  title: string;
  explanation: string;
}

const LEVEL_RANK: Record<AlertLevel, number> = { URGENT: 3, IMPORTANT: 2, NOTICE: 1 };

export function ruleMatches(rule: AlertRuleSpec, signal: Pick<SignalForAlert, "kind" | "importance" | "confidence">): boolean {
  return rule.enabled && signal.importance >= rule.minImportance && signal.confidence >= rule.minConfidence && (rule.kinds.length === 0 || rule.kinds.includes(signal.kind));
}

export function alertDedupeKey(signal: Pick<SignalForAlert, "monitoredUrlId" | "entityKey" | "kind">): string {
  return `${signal.monitoredUrlId}|${signal.entityKey ?? "-"}|${signal.kind}`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The mandatory explanation: which rule matched with which numbers, then the signal's strongest reasons. */
export function buildAlertExplanation(signal: SignalForAlert, rule: AlertRuleSpec): string {
  const top = [...signal.factors]
    .filter((f) => f.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);
  const parts = [
    `Rule "${rule.name}" matched: importance ${signal.importance} (at least ${rule.minImportance} needed) and confidence ${pct(signal.confidence)} (at least ${pct(rule.minConfidence)} needed).`,
    `What happened: ${signal.summary}.`,
    top.length > 0 ? `Strongest reasons: ${top.map((f) => `${f.factor} (+${f.points}): ${f.explanation}`).join(" ")}` : "",
    `Based on ${signal.evidenceCount} verified change event${signal.evidenceCount === 1 ? "" : "s"} from ${signal.competitorName}.`,
    signal.confidence < 0.75 ? "Confidence is moderate: the detector had some doubt, so check the evidence before acting on it." : "",
  ];
  return parts.filter((p) => p.length > 0).join(" ");
}

/**
 * The alert a signal deserves, or null. When several rules match, the most urgent wins (the first listed
 * among equals). An alert is returned only with a non-empty explanation.
 */
export function decideAlert(signal: SignalForAlert, rules: readonly AlertRuleSpec[] = DEFAULT_ALERT_RULES): AlertDecision | null {
  const matching = rules.filter((r) => ruleMatches(r, signal));
  if (matching.length === 0) return null;
  const rule = matching.reduce((best, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[best.level] ? r : best));
  const explanation = buildAlertExplanation(signal, rule);
  if (explanation.length === 0) return null;
  return { level: rule.level, rule, dedupeKey: alertDedupeKey(signal), title: `${signal.competitorName}: ${signal.title}`, explanation };
}

/** The first problem with a set of rules, or null when they can be saved. */
export function validateAlertRules(rules: readonly AlertRuleSpec[]): string | null {
  const ids = new Set<string>();
  for (const r of rules) {
    if (!r.id || ids.has(r.id)) return `Rule ids must be unique and not empty ("${r.id}").`;
    ids.add(r.id);
    if (r.name.trim().length === 0 || r.name.length > 80) return `A rule needs a name of up to 80 characters ("${r.id}").`;
    if (!ALERT_LEVELS.includes(r.level)) return `Unknown level "${r.level}" in rule "${r.name}".`;
    if (!Number.isFinite(r.minImportance) || r.minImportance < 0 || r.minImportance > 100) return `The minimum importance of "${r.name}" must be between 0 and 100.`;
    if (!Number.isFinite(r.minConfidence) || r.minConfidence < 0 || r.minConfidence > 1) return `The minimum confidence of "${r.name}" must be between 0 and 1.`;
  }
  return null;
}
