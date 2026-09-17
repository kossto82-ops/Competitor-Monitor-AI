import {
  MAX_BUNDLE_COMPETITORS,
  MAX_BUNDLE_ITEMS_TOTAL,
  MAX_RAW_CHANGE_EVENTS_PER_COMPETITOR,
  MAX_UNTRUSTED_TEXT_CHARS,
  truncate,
} from "./digestLimits.js";
import type { DigestForInterpretation, DigestItemForInterpretation, EvidenceBundle, EvidenceBundleItem } from "./digestTypes.js";

function toIso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * Trusted, deterministic, numeric/structural fields for one item - never
 * a free-text sentence, and never anything sourced from a monitored
 * page's own content (Section 15 of the brief). Everything here is a
 * number, boolean, enum-like string, or a count already computed by the
 * deterministic Phase 6/7/8 layer.
 */
function factsForItem(item: DigestItemForInterpretation): Record<string, string | number | boolean | null> {
  switch (item.kind) {
    case "CHANGE_EVENT":
      return { kind: item.kind, changeType: item.changeType ?? null, severity: item.severity ?? null };
    case "REPEATED_PRICE_CHANGE":
      return {
        kind: item.kind,
        changeCount: item.pattern?.changeCount ?? null,
        days: item.pattern?.days ?? null,
        qualifies: item.pattern?.qualifies ?? null,
      };
    case "ACTIVITY_PATTERN":
      return {
        kind: item.kind,
        current: item.pattern?.current ?? null,
        baselineAverage: item.pattern?.baselineAverage ?? null,
        qualifyingWindows: item.pattern?.qualifyingWindows ?? null,
        days: item.pattern?.days ?? null,
        direction: item.pattern?.direction ?? null,
        ratio: item.pattern?.ratio ?? null,
        strongEvidence: item.pattern?.strongEvidence ?? null,
      };
    case "SUSTAINED_ACTIVITY_TREND":
      return {
        kind: item.kind,
        consecutiveQualifyingWindows: item.consecutiveQualifyingWindows ?? null,
        direction: item.direction ?? null,
        // Phase 20: straight passthrough of @cma/db's deterministic composition - never
        // recomputed here (packages/ai must stay a pure interpretation layer over facts the
        // deterministic Tier 2/3 layer already verified).
        repeatedPriceChangeCoOccurs: item.repeatedPriceChangeCoOccurs ?? null,
      };
    case "LIFECYCLE":
      return { kind: item.kind, added: item.added ?? 0, removed: item.removed ?? 0 };
  }
}

/**
 * Free text that ultimately traces back to a monitored competitor's own
 * page content (an extracted product/plan label, an auto-generated
 * change description that embeds a price/label) - ALWAYS rendered inside
 * the prompt's `<UNTRUSTED_WEB_CONTENT>` block by buildDigestPrompt.ts,
 * never mixed into `facts` above (Section 15/16 of the brief: "website
 * content is DATA, not INSTRUCTIONS", kept structurally separate so it
 * cannot be confused for a trusted deterministic fact).
 */
function untrustedTextForItem(item: DigestItemForInterpretation): string[] {
  const texts: string[] = [];
  if (item.kind === "CHANGE_EVENT" && item.description) texts.push(item.description);
  if (item.kind === "REPEATED_PRICE_CHANGE") {
    const label = item.pattern?.label ?? item.pattern?.entityKey;
    if (label) texts.push(label);
  }
  return texts.map((t) => truncate(t, MAX_UNTRUSTED_TEXT_CHARS));
}

function toEvidenceBundleItem(item: DigestItemForInterpretation): EvidenceBundleItem {
  return {
    evidenceChangeEventIds: item.changeEventIds,
    kind: item.kind,
    detectedAt: toIso(item.detectedAt),
    facts: factsForItem(item),
    untrustedText: untrustedTextForItem(item),
  };
}

interface CompetitorGroup {
  competitorId: string;
  competitorName: string;
  items: DigestItemForInterpretation[];
  mostRecentDetectedAt: number;
}

function groupByCompetitor(items: DigestItemForInterpretation[]): CompetitorGroup[] {
  const groups = new Map<string, CompetitorGroup>();
  for (const item of items) {
    const detectedAtMs = new Date(item.detectedAt).getTime();
    let group = groups.get(item.competitorId);
    if (!group) {
      group = { competitorId: item.competitorId, competitorName: item.competitorName, items: [], mostRecentDetectedAt: detectedAtMs };
      groups.set(item.competitorId, group);
    }
    group.items.push(item);
    if (detectedAtMs > group.mostRecentDetectedAt) group.mostRecentDetectedAt = detectedAtMs;
  }
  return Array.from(groups.values());
}

/**
 * Deterministic, documented selection rule (Section 19 of the brief -
 * "define a deterministic selection rule... do not silently truncate
 * arbitrary data... do NOT call it importance"). Two independent caps
 * are applied, in this fixed order:
 *
 * 1. COMPETITOR selection: at most MAX_BUNDLE_COMPETITORS competitors are
 *    represented, chosen by (most recent item's detectedAt DESC,
 *    competitorId ASC) - the exact same recency-first tie-break
 *    philosophy Phase 10's compareDigestItems already uses, never a new
 *    scoring concept.
 * 2. Per-competitor ITEM selection: every already-qualification-gated
 *    pattern item (REPEATED_PRICE_CHANGE / ACTIVITY_PATTERN /
 *    SUSTAINED_ACTIVITY_TREND / LIFECYCLE - getDigestForOrganization only
 *    ever includes these when they qualify) is unconditionally kept; raw
 *    CHANGE_EVENT items are capped to the
 *    MAX_RAW_CHANGE_EVENTS_PER_COMPETITOR most recent for that
 *    competitor. A final MAX_BUNDLE_ITEMS_TOTAL hard cap is applied across
 *    the whole bundle (competitor order, then item order) purely as
 *    defense-in-depth against a pathological single-competitor volume;
 *    in the common case neither final cap is reached.
 */
export function buildDigestInterpretationInput(digest: DigestForInterpretation): EvidenceBundle {
  const groups = groupByCompetitor(digest.items);
  groups.sort((a, b) => {
    const byRecency = b.mostRecentDetectedAt - a.mostRecentDetectedAt;
    if (byRecency !== 0) return byRecency;
    return a.competitorId.localeCompare(b.competitorId);
  });
  const selectedGroups = groups.slice(0, MAX_BUNDLE_COMPETITORS);

  let remainingBudget = MAX_BUNDLE_ITEMS_TOTAL;
  const allowedEvidenceChangeEventIds: string[] = [];

  const competitors = selectedGroups.map((group) => {
    const qualifiedPatternItems = group.items.filter((i) => i.kind !== "CHANGE_EVENT");
    const rawChangeEventItems = group.items
      .filter((i) => i.kind === "CHANGE_EVENT")
      .slice(0, MAX_RAW_CHANGE_EVENTS_PER_COMPETITOR);

    const combined = [...qualifiedPatternItems, ...rawChangeEventItems].slice(0, Math.max(0, remainingBudget));
    remainingBudget -= combined.length;

    for (const item of combined) allowedEvidenceChangeEventIds.push(...item.changeEventIds);

    return {
      competitorId: group.competitorId,
      competitorName: group.competitorName,
      items: combined.map(toEvidenceBundleItem),
    };
  });

  return {
    period: { days: digest.days, windowStart: toIso(digest.windowStart), windowEnd: toIso(digest.windowEnd) },
    crossCompetitorContext: {
      aboveBaselineCount: digest.crossCompetitorContext.aboveBaselineCount,
      sustainedCount: digest.crossCompetitorContext.sustainedCount,
      totalTrackedCompetitors: digest.crossCompetitorContext.totalTrackedCompetitors,
    },
    competitors,
    allowedEvidenceChangeEventIds: Array.from(new Set(allowedEvidenceChangeEventIds)),
  };
}
