import { describeChangeEvent } from "./changeDescription.js";
import { parseAmount } from "./money.js";

/**
 * Phase 29 D2: which verified change events become a Signal, and what that signal says. A ChangeEvent is a
 * raw, per-scan fact; a Signal is something a person should know about, with the rule that promoted it and
 * the events that back it. Everything here is deterministic: no scores, no AI, and the wording comes from
 * templates over the event's own fields, so a signal never says more than its evidence does.
 */

/** Words the detector writes into an event's evidence when it downgrades it; the rules read them back. */
export const REVERT_MARKER = "Reverts the change detected";
export const RENAME_MARKER = "Possibly renamed:";

export const SIGNAL_KINDS = [
  "PRICE_INCREASE",
  "PRICE_DECREASE",
  "PLAN_ADDED",
  "PLAN_REMOVED",
  "PROMOTION_STARTED",
  "PROMOTION_CHANGED",
  "PROMOTION_ENDED",
  "CONTENT_UPDATE",
  "CAPABILITY_ADDED",
  "CAPABILITY_REMOVED",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** What kind of claim a signal makes: a fact we observed, an interpretation of facts, or an inference. */
export const EPISTEMIC_LEVELS = ["FACT", "INTERPRETATION", "INFERENCE"] as const;
export type EpistemicLevel = (typeof EPISTEMIC_LEVELS)[number];

/** Rule versions: bump one when its logic changes, so a stored signal says which logic produced it. */
export const SIGNAL_RULE_VERSIONS = {
  "price-change": 1,
  "plan-added-removed": 1,
  "promotion-change": 1,
  "content-update": 1,
  "capability-change": 1,
} as const;
export type SignalRuleId = keyof typeof SIGNAL_RULE_VERSIONS;

/** An entity event below this confidence is not promoted: it was downgraded as an oscillation or is weak. */
export const MIN_ENTITY_SIGNAL_CONFIDENCE = 0.6;
/** Text changes are unspecific by nature (the detector gives them 0.5-0.6); they are grouped per day. */
export const MIN_CONTENT_SIGNAL_CONFIDENCE = 0.5;
/**
 * This many plans added (or removed) from one source in one scan is a page that changed layout or was served
 * partially, not that many launches or retirements (pilot, Zoho: six "retired plans" in one capture). The
 * detector now stops most of these upstream; this is the safety net for what still gets through.
 */
export const MASS_PLAN_CHANGE_THRESHOLD = 4;

export interface EventForSignal {
  id: string;
  monitoredUrlId: string;
  changeType: string;
  entityKey: string | null;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  confidence: number;
  evidenceExcerpt: string;
  detectedAt: Date;
}

export interface SignalDraft {
  kind: SignalKind;
  ruleId: SignalRuleId;
  ruleVersion: number;
  /** Unique per organization: promoting the same event twice, or the same day's text changes, is one signal. */
  dedupeKey: string;
  monitoredUrlId: string;
  entityKey: string | null;
  epistemicLevel: EpistemicLevel;
  title: string;
  summary: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  confidence: number;
  occurredAt: Date;
  primaryEventId: string;
}

export interface SignalSkip {
  eventId: string;
  reason: string;
}

export interface SignalDerivation {
  drafts: SignalDraft[];
  /** Why an event did not become a signal; the explanation is part of the contract, not a log line. */
  skipped: SignalSkip[];
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

function nameOf(entityKey: string | null, labels: ReadonlyMap<string, string>): string {
  if (!entityKey) return "an item";
  return (labels.get(entityKey) ?? entityKey).replace(/\s*\(per (?:month|year)\)\s*$/i, "").trim();
}

function direction(event: EventForSignal): "up" | "down" | null {
  if (event.percentageChange !== null && event.percentageChange !== 0) return event.percentageChange > 0 ? "up" : "down";
  const before = parseAmount(event.oldValue);
  const after = parseAmount(event.newValue);
  if (before === null || after === null || before === after) return null;
  return after > before ? "up" : "down";
}

function draftOf(event: EventForSignal, rule: SignalRuleId, kind: SignalKind, dedupeKey: string, title: string): SignalDraft {
  return {
    kind,
    ruleId: rule,
    ruleVersion: SIGNAL_RULE_VERSIONS[rule],
    dedupeKey,
    monitoredUrlId: event.monitoredUrlId,
    entityKey: event.entityKey,
    epistemicLevel: "FACT",
    title,
    summary: describeChangeEvent(event),
    oldValue: event.oldValue,
    newValue: event.newValue,
    currency: event.currency,
    percentageChange: event.percentageChange,
    confidence: event.confidence,
    occurredAt: event.detectedAt,
    primaryEventId: event.id,
  };
}

/**
 * Promotion rules, one per kind of verified event:
 * - price-change      : a PRICE_CHANGE with a direction, at confidence >= 0.6 and not flagged as reverting a change
 *                       seen hours before (possible A/B test or regional pricing).
 * - plan-added-removed: PRODUCT_ADDED / PRODUCT_REMOVED at confidence >= 0.6 and not half of a probable rename.
 * - promotion-change  : PROMOTION_ADDED / CHANGE / REMOVED at confidence >= 0.6.
 * - content-update    : CONTENT_CHANGE at confidence >= 0.5, one signal per source per UTC day.
 * `labels` maps an entity key to its human name (from the entity history); a missing label falls back to the key.
 */
export function deriveSignals(events: EventForSignal[], labels: ReadonlyMap<string, string> = new Map()): SignalDerivation {
  const result: SignalDerivation = { drafts: [], skipped: [] };
  const skip = (event: EventForSignal, reason: string) => result.skipped.push({ eventId: event.id, reason });

  const planChangesPerSource = new Map<string, number>();
  for (const event of events) {
    if (event.changeType === "PRODUCT_ADDED" || event.changeType === "PRODUCT_REMOVED" || event.changeType === "CAPABILITY_ADDED" || event.changeType === "CAPABILITY_REMOVED") {
      const k = `${event.monitoredUrlId}|${event.changeType}`;
      planChangesPerSource.set(k, (planChangesPerSource.get(k) ?? 0) + 1);
    }
  }

  for (const event of events) {
    const name = nameOf(event.entityKey, labels);
    const massCount = planChangesPerSource.get(`${event.monitoredUrlId}|${event.changeType}`) ?? 0;
    if (massCount >= MASS_PLAN_CHANGE_THRESHOLD) {
      skip(event, `${massCount} plans of one source changed in one scan: a layout change or a partial render, not ${massCount} separate launches or retirements`);
      continue;
    }
    switch (event.changeType) {
      case "PRICE_CHANGE": {
        if (event.confidence < MIN_ENTITY_SIGNAL_CONFIDENCE) {
          skip(event, `confidence ${event.confidence} is below ${MIN_ENTITY_SIGNAL_CONFIDENCE}`);
          break;
        }
        if (event.evidenceExcerpt.includes(REVERT_MARKER)) {
          skip(event, "reverts a recent price change (possible A/B test or regional pricing)");
          break;
        }
        const dir = direction(event);
        if (!dir) {
          skip(event, "no direction could be established");
          break;
        }
        result.drafts.push(draftOf(event, "price-change", dir === "up" ? "PRICE_INCREASE" : "PRICE_DECREASE", `price:${event.id}`, `${name}: price ${dir === "up" ? "increased" : "decreased"}`));
        break;
      }
      case "PRODUCT_ADDED":
      case "PRODUCT_REMOVED": {
        if (event.confidence < MIN_ENTITY_SIGNAL_CONFIDENCE) {
          skip(event, `confidence ${event.confidence} is below ${MIN_ENTITY_SIGNAL_CONFIDENCE}`);
          break;
        }
        if (event.evidenceExcerpt.includes(RENAME_MARKER)) {
          skip(event, "probably a rename of an existing plan, not a new or retired one");
          break;
        }
        const added = event.changeType === "PRODUCT_ADDED";
        result.drafts.push(draftOf(event, "plan-added-removed", added ? "PLAN_ADDED" : "PLAN_REMOVED", `plan:${event.id}`, added ? `New plan or price listed: ${name}` : `Plan or price no longer listed: ${name}`));
        break;
      }
      case "PROMOTION_ADDED":
      case "PROMOTION_CHANGE":
      case "PROMOTION_REMOVED": {
        if (event.confidence < MIN_ENTITY_SIGNAL_CONFIDENCE) {
          skip(event, `confidence ${event.confidence} is below ${MIN_ENTITY_SIGNAL_CONFIDENCE}`);
          break;
        }
        const [kind, verb] =
          event.changeType === "PROMOTION_ADDED"
            ? (["PROMOTION_STARTED", "started"] as const)
            : event.changeType === "PROMOTION_CHANGE"
              ? (["PROMOTION_CHANGED", "changed"] as const)
              : (["PROMOTION_ENDED", "ended"] as const);
        result.drafts.push(draftOf(event, "promotion-change", kind, `promotion:${event.id}`, `Promotion ${verb}: ${name}`));
        break;
      }
      case "CAPABILITY_ADDED":
      case "CAPABILITY_REMOVED": {
        if (event.confidence < MIN_ENTITY_SIGNAL_CONFIDENCE) {
          skip(event, `confidence ${event.confidence} is below ${MIN_ENTITY_SIGNAL_CONFIDENCE}`);
          break;
        }
        const added = event.changeType === "CAPABILITY_ADDED";
        const what = (added ? event.newValue : event.oldValue) ?? name;
        result.drafts.push(draftOf(event, "capability-change", added ? "CAPABILITY_ADDED" : "CAPABILITY_REMOVED", `capability:${event.id}`, added ? `Now says it offers: ${what}` : `No longer says it offers: ${what}`));
        break;
      }
      case "CONTENT_CHANGE": {
        if (event.confidence < MIN_CONTENT_SIGNAL_CONFIDENCE) {
          skip(event, `confidence ${event.confidence} is below ${MIN_CONTENT_SIGNAL_CONFIDENCE}`);
          break;
        }
        result.drafts.push(draftOf(event, "content-update", "CONTENT_UPDATE", `content:${event.monitoredUrlId}:${dayOf(event.detectedAt)}`, "Page text changed"));
        break;
      }
      default:
        skip(event, `no promotion rule for ${event.changeType}`);
    }
  }
  return result;
}
