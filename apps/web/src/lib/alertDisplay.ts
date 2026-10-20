import type { AlertLevel, ImportanceTier, MarketPatternKind, SignalKind } from "@cma/core";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * Phase 29 D5: the words and colours of alerts and signals, in one place so that the Today page, the alert
 * list and any later email say the same thing about the same level.
 */
export const ALERT_LEVEL_DISPLAY: Record<AlertLevel, { label: string; tone: BadgeTone; meaning: string }> = {
  URGENT: { label: "Urgent", tone: "red", meaning: "A very large change that is very likely real." },
  IMPORTANT: { label: "Important", tone: "amber", meaning: "A price or plan change worth looking at today." },
  NOTICE: { label: "Notice", tone: "blue", meaning: "Worth knowing, not worth acting on." },
};

export const TIER_DISPLAY: Record<ImportanceTier, { label: string; tone: BadgeTone }> = {
  HIGH: { label: "High importance", tone: "red" },
  MEDIUM: { label: "Medium importance", tone: "amber" },
  LOW: { label: "Low importance", tone: "gray" },
};

const KIND_LABEL: Record<SignalKind, string> = {
  PRICE_INCREASE: "Price up",
  PRICE_DECREASE: "Price down",
  PLAN_ADDED: "Plan added",
  PLAN_REMOVED: "Plan removed",
  PROMOTION_STARTED: "Promotion started",
  PROMOTION_CHANGED: "Promotion changed",
  PROMOTION_ENDED: "Promotion ended",
  CONTENT_UPDATE: "Text changed",
  CAPABILITY_ADDED: "Offers something new",
  CAPABILITY_REMOVED: "Stopped saying it offers",
};

export function signalKindLabel(kind: string): string {
  return KIND_LABEL[kind as SignalKind] ?? kind;
}

/** Confidence is a separate question from importance, so it is always shown in words next to the percentage. */
export function confidenceLabel(confidence: number): string {
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.85) return `High confidence (${pct}%)`;
  if (confidence >= 0.65) return `Moderate confidence (${pct}%)`;
  return `Low confidence (${pct}%)`;
}

/** The share of the 0-100 importance scale a factor's points take, for drawing a bar (never above 100). */
export function pointsBarPercent(points: number, maxPoints = 30): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  return Math.min(100, Math.round((points / maxPoints) * 100));
}

/** What to say when nothing needs attention: a quiet day is information, not an empty screen. */
export function quietDaySummary(sourceCount: number, signalCount: number): string {
  if (sourceCount === 0) return "No pages are monitored yet.";
  return signalCount === 0
    ? `${sourceCount} page${sourceCount === 1 ? " is" : "s are"} being watched and nothing noteworthy changed.`
    : `${sourceCount} page${sourceCount === 1 ? " is" : "s are"} being watched; the changes below are minor.`;
}

const PATTERN_LABEL: Record<MarketPatternKind, string> = {
  MARKET_PRICES_UP: "Prices going up",
  MARKET_PRICES_DOWN: "Prices going down",
  MARKET_PLANS_ADDED: "New plans",
  MARKET_PLANS_REMOVED: "Plans removed",
  MARKET_PROMOTIONS: "Promotions",
};

export function patternKindLabel(kind: string): string {
  return PATTERN_LABEL[kind as MarketPatternKind] ?? kind;
}
