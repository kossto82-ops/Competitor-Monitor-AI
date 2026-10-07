import { comparePrices, parseAmount, type ChangeEventDraft, type ComparisonResult, type ExtractedEntity, type Severity } from "@cma/core";
import { diffText, type TextHunk } from "./textDiff.js";

export interface PriorSnapshotData {
  /** Version of the extraction logic that produced this snapshot (Phase 29 C2); absent = unknown, assumed comparable. */
  extractorVersion?: number;
  contentHash: string | null;
  structuredDataHash: string | null;
  normalizedContent: string;
  entities: ExtractedEntity[];
}

export interface CurrentExtractionData {
  extractorVersion?: number;
  /** 0-1 quality of the extraction itself (Phase 29 C4); lowers the confidence of every event drawn from it. Absent = 1. */
  confidence?: number;
  httpStatus: number | null;
  errorMessage: string | null;
  contentHash: string | null;
  structuredDataHash: string | null;
  normalizedContent: string;
  entities: ExtractedEntity[];
}

/**
 * The single deterministic entry point of the whole product: given what
 * we saw last time and what we see now, decide CHANGED / NO_CHANGE /
 * FAILED_TO_VERIFY and, only for CHANGED, produce the concrete
 * ChangeEvent drafts. No AI call happens here or is needed here - this
 * is the "source of truth" step the brief requires (Section 1/3).
 */
/** A change already recorded for the same URL; used to recognise a value that flips back and forth. */
export interface RecentChangeEvent {
  entityKey: string | null;
  changeType: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  detectedAt: Date;
}

export interface CompareOptions {
  recentEvents?: RecentChangeEvent[];
  now?: Date;
}

export function compareSnapshots(prior: PriorSnapshotData | null, current: CurrentExtractionData, options: CompareOptions = {}): ComparisonResult {
  const failureReason = describeExtractionFailure(current);
  if (failureReason) {
    return { verificationState: "FAILED_TO_VERIFY", reason: failureReason, changeEvents: [] };
  }

  if (prior === null) {
    return { verificationState: "NO_CHANGE", reason: "No prior snapshot exists - this is the baseline.", changeEvents: [] };
  }

  // The extraction logic decides WHICH text is hashed. A snapshot taken under another version is not
  // comparable: report it as the new baseline rather than as every page having changed at once.
  if (prior.extractorVersion !== undefined && current.extractorVersion !== undefined && prior.extractorVersion !== current.extractorVersion) {
    return {
      verificationState: "NO_CHANGE",
      reason: `Extraction logic changed (v${prior.extractorVersion} -> v${current.extractorVersion}); this scan is the new baseline, not a page change.`,
      changeEvents: [],
    };
  }

  const identical = current.contentHash === prior.contentHash && current.structuredDataHash === prior.structuredDataHash;
  if (identical) {
    return { verificationState: "NO_CHANGE", reason: "Content and structured data hashes are unchanged.", changeEvents: [] };
  }

  const entityEvents: ChangeEventDraft[] = [
    ...detectPriceChanges(prior.entities, current.entities),
    ...detectProductAddedOrRemoved(prior.entities, current.entities),
    ...detectPromotionChanges(prior.entities, current.entities),
    ...detectPromotionAddedOrRemoved(prior.entities, current.entities),
  ].map((event) => finalizeEvent(event, current.confidence ?? 1));
  const changeEvents = dedupeEvents(
    linkPossibleRenames(flagOscillations(entityEvents, options.recentEvents ?? [], options.now ?? new Date()), prior.entities, current.entities),
  );

  // Phase 29 C4: the page text is diffed block by block. Changes that an entity event already explains
  // (the price digits of a PRICE_CHANGE, the card of a PRODUCT_ADDED) are not repeated as a vague
  // content change, but text that changed for any OTHER reason is no longer hidden just because some
  // entity event exists on the same page.
  if (current.contentHash !== prior.contentHash) {
    const diff = diffText(prior.normalizedContent, current.normalizedContent);
    const hints = buildExplanationHints(changeEvents, prior.entities, current.entities);
    const unexplained = diff.hunks.filter((hunk) => !isHunkExplained(hunk, hints));
    if (unexplained.length > 0) {
      changeEvents.push(finalizeEvent(buildContentChangeEvent(unexplained, diff.truncated), current.confidence ?? 1));
    }
  }

  return {
    verificationState: "CHANGED",
    reason: "Content hash or structured data differs from the previous successful snapshot.",
    changeEvents,
  };
}

/**
 * Per Section 3 of the brief: a failed fetch/timeout/block is NEVER
 * treated as evidence of a real-world change. An empty successful
 * response is conservatively treated as unverified too, because Phase 1
 * has no page-category-aware way to confirm "this page genuinely has no
 * products" versus "the extractor failed to see the real content".
 */
function describeExtractionFailure(current: CurrentExtractionData): string | null {
  if (current.errorMessage) {
    return current.errorMessage;
  }
  if (current.normalizedContent.trim().length === 0) {
    return "Extraction returned no content; treated as unverified rather than as a deletion.";
  }
  return null;
}

export function severityForPercentageChange(pctAbs: number): Severity {
  if (pctAbs >= 15) return "HIGH";
  if (pctAbs >= 5) return "MEDIUM";
  return "LOW";
}

function byKey(entities: ExtractedEntity[]): Map<string, ExtractedEntity> {
  return new Map(entities.map((e) => [e.key, e]));
}

/**
 * Restricted to PRICE-type entities on both sides (Phase 23 fix): before
 * PROMOTION entities existed, this loop's lack of a type filter was
 * harmless in practice because the only other entity kind sharing this
 * code path (GENERIC, regex-matched) uses a context-hash key that is
 * never stable across scans, so a same-key collision with a different
 * type never happened. PROMOTION entities DO use a stable,
 * product-scoped key on purpose (so PROMOTION_CHANGE can be detected the
 * same way) - without this filter, a promotion's own value-changed event
 * would collide by key and be mis-classified as a PRICE_CHANGE. See
 * detectPromotionChanges below for the PROMOTION-type equivalent of this
 * exact diff.
 */
function detectPriceChanges(priorEntities: ExtractedEntity[], currentEntities: ExtractedEntity[]): ChangeEventDraft[] {
  const priorByKey = byKey(priorEntities.filter((e) => e.type === "PRICE"));
  const events: ChangeEventDraft[] = [];

  for (const current of currentEntities) {
    if (current.type !== "PRICE") continue;
    const previous = priorByKey.get(current.key);
    if (!previous) continue;

    const currency = current.currency ?? previous.currency;
    const comparison = comparePrices(previous, current);

    if (comparison.kind === "same") continue; // "10" vs "10.00", or the same amount in another locale

    if (comparison.kind === "unparseable") {
      if (previous.value === current.value && previous.currency === current.currency) continue;
      // A real, evidenced value change whose numbers we cannot read - reported without a percentage.
      events.push({
        changeType: "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.7,
        entityKey: current.key,
        fieldPath: current.key,
        oldValue: previous.value,
        newValue: current.value,
        currency,
        percentageChange: null,
        evidenceExcerpt: `${previous.label}: ${previous.value ?? "?"} -> ${current.value ?? "?"}`,
      });
      continue;
    }

    if (comparison.currencyChanged) {
      // The currency itself moved: a percentage across currencies would be meaningless, so none is given.
      const amountNote = comparison.amountChanged ? "" : " (amount unchanged)";
      events.push({
        changeType: "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.85,
        entityKey: current.key,
        fieldPath: current.key,
        oldValue: previous.value,
        newValue: current.value,
        currency: current.currency ?? previous.currency,
        percentageChange: null,
        evidenceExcerpt: `${previous.label}: currency changed ${previous.currency} -> ${current.currency}${amountNote}: ${previous.value} -> ${current.value}`,
      });
      continue;
    }

    if (comparison.percentageChange === null) {
      // Old amount was 0 (e.g. free -> paid): still a real change, just without a derived percentage.
      events.push({
        changeType: "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.7,
        entityKey: current.key,
        fieldPath: current.key,
        oldValue: previous.value,
        newValue: current.value,
        currency,
        percentageChange: null,
        evidenceExcerpt: `${previous.label}: ${previous.value ?? "?"} -> ${current.value ?? "?"}`,
      });
      continue;
    }

    events.push({
      changeType: "PRICE_CHANGE",
      severity: severityForPercentageChange(Math.abs(comparison.percentageChange)),
      // A number with two valid readings (e.g. "1.299") is less certain than an unambiguous one.
      confidence: comparison.ambiguous ? 0.8 : 0.95,
      entityKey: current.key,
      fieldPath: current.key,
      oldValue: previous.value,
      newValue: current.value,
      currency,
      percentageChange: comparison.percentageChange,
      evidenceExcerpt: `${previous.label}: ${previous.value} ${previous.currency ?? ""} -> ${current.value} ${current.currency ?? ""}`.trim(),
    });
  }

  return events;
}

/**
 * Restricted to JSON-LD-sourced PRICE entities on purpose: their `key`
 * is derived from a product name, so it is stable across scans.
 * GENERIC (regex-matched) entities key off surrounding text context and
 * are NOT stable enough to diff for add/remove without generating
 * constant false positives - they are only used for price-value
 * matching above, never for existence diffing.
 */
function detectProductAddedOrRemoved(
  priorEntities: ExtractedEntity[],
  currentEntities: ExtractedEntity[],
): ChangeEventDraft[] {
  const priorPriceEntities = priorEntities.filter((e) => e.type === "PRICE");
  const currentPriceEntities = currentEntities.filter((e) => e.type === "PRICE");
  const priorByKey = byKey(priorPriceEntities);
  const currentByKey = byKey(currentPriceEntities);
  const events: ChangeEventDraft[] = [];

  for (const current of currentPriceEntities) {
    if (!priorByKey.has(current.key)) {
      events.push({
        changeType: "PRODUCT_ADDED",
        severity: "MEDIUM",
        confidence: 0.8,
        entityKey: current.key,
        fieldPath: current.key,
        oldValue: null,
        newValue: current.value,
        currency: current.currency,
        percentageChange: null,
        evidenceExcerpt: `New product/plan detected: ${current.label} (${current.value ?? "no price"} ${current.currency ?? ""})`.trim(),
      });
    }
  }

  for (const previous of priorPriceEntities) {
    if (!currentByKey.has(previous.key)) {
      events.push({
        changeType: "PRODUCT_REMOVED",
        severity: "MEDIUM",
        confidence: 0.7,
        entityKey: previous.key,
        fieldPath: previous.key,
        oldValue: previous.value,
        newValue: null,
        currency: previous.currency,
        percentageChange: null,
        evidenceExcerpt: `Product/plan no longer detected on page: ${previous.label} (was ${previous.value ?? "?"} ${previous.currency ?? ""})`.trim(),
      });
    }
  }

  return events;
}

/**
 * Phase 23: PROMOTION_CHANGE detection, structurally the same byKey diff
 * as detectPriceChanges but restricted to PROMOTION-type entities and
 * WITHOUT a percentage-change computation - a promotion's `value` is a
 * composed "field=value" signature (see structuredData.ts's
 * extractPromotionSignal), not a single numeric amount, so there is no
 * defensible single percentage to derive from a literal string diff.
 * Same product-scoped `key` as the sibling PRICE entity (both are
 * `jsonld[-promo]:{name}`), so a price change and a promotion change on
 * the same product are two independent, correctly co-occurring events -
 * never merged into one.
 */
function detectPromotionChanges(priorEntities: ExtractedEntity[], currentEntities: ExtractedEntity[]): ChangeEventDraft[] {
  const priorByKey = byKey(priorEntities.filter((e) => e.type === "PROMOTION"));
  const events: ChangeEventDraft[] = [];

  for (const current of currentEntities) {
    if (current.type !== "PROMOTION") continue;
    const previous = priorByKey.get(current.key);
    if (!previous || previous.value === current.value) continue;

    events.push({
      changeType: "PROMOTION_CHANGE",
      severity: "MEDIUM",
      confidence: 0.75,
      entityKey: current.key,
      fieldPath: current.key,
      oldValue: previous.value,
      newValue: current.value,
      currency: current.currency ?? previous.currency,
      percentageChange: null,
      evidenceExcerpt: `${previous.label}: ${previous.value ?? "?"} -> ${current.value ?? "?"}`,
    });
  }

  return events;
}

/**
 * Phase 23: PROMOTION_ADDED / PROMOTION_REMOVED, the same existence-diff
 * shape as detectProductAddedOrRemoved but over PROMOTION-type entities.
 * Only JSON-LD-sourced PROMOTION entities exist today (see
 * structuredData.ts's extractPromotionSignal), and their `key` is
 * product-name-derived exactly like PRICE's - the same "stable across
 * scans" property detectProductAddedOrRemoved's doc comment already
 * relies on applies here unchanged.
 */
function detectPromotionAddedOrRemoved(priorEntities: ExtractedEntity[], currentEntities: ExtractedEntity[]): ChangeEventDraft[] {
  const priorPromotionEntities = priorEntities.filter((e) => e.type === "PROMOTION");
  const currentPromotionEntities = currentEntities.filter((e) => e.type === "PROMOTION");
  const priorByKey = byKey(priorPromotionEntities);
  const currentByKey = byKey(currentPromotionEntities);
  const events: ChangeEventDraft[] = [];

  for (const current of currentPromotionEntities) {
    if (!priorByKey.has(current.key)) {
      events.push({
        changeType: "PROMOTION_ADDED",
        severity: "MEDIUM",
        confidence: 0.75,
        entityKey: current.key,
        fieldPath: current.key,
        oldValue: null,
        newValue: current.value,
        currency: current.currency,
        percentageChange: null,
        evidenceExcerpt: `New promotion detected: ${current.label} (${current.value ?? "?"})`,
      });
    }
  }

  for (const previous of priorPromotionEntities) {
    if (!currentByKey.has(previous.key)) {
      events.push({
        changeType: "PROMOTION_REMOVED",
        severity: "MEDIUM",
        confidence: 0.7,
        entityKey: previous.key,
        fieldPath: previous.key,
        oldValue: previous.value,
        newValue: null,
        currency: previous.currency,
        percentageChange: null,
        evidenceExcerpt: `Promotion no longer detected on page: ${previous.label} (was ${previous.value ?? "?"})`,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------------------------
// Phase 29 C4: evidence per changed block, derived confidence/severity, oscillation
// ---------------------------------------------------------------------------------------------

const EXCERPT_MAX = 300;
const MAX_HUNKS_IN_EVIDENCE = 3;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildContentChangeEvent(hunks: TextHunk[], truncated: boolean): ChangeEventDraft {
  const shown = hunks.slice(0, MAX_HUNKS_IN_EVIDENCE);
  const removed = shown.map((h) => h.removed).filter((t) => t.length > 0).join(" … ");
  const added = shown.map((h) => h.added).filter((t) => t.length > 0).join(" … ");
  const detail = shown
    .map((h) => `"…${[h.before, `[${h.removed || "(nothing)"} → ${h.added || "(nothing)"}]`, h.after].filter(Boolean).join(" ")}…"`)
    .join(" | ");
  const more = hunks.length > shown.length ? ` (+${hunks.length - shown.length} more changed passages)` : "";
  const note = truncated ? " The page changed so extensively that only an approximate comparison was possible." : "";
  return {
    changeType: "CONTENT_CHANGE",
    severity: "LOW",
    // A text change that no structured entity explains is real but unspecific; a wholesale rewrite even more so.
    confidence: truncated || hunks.length > 10 ? 0.5 : 0.6,
    entityKey: null,
    fieldPath: "page.visibleText",
    oldValue: removed.length > 0 ? clip(removed, EXCERPT_MAX) : null,
    newValue: added.length > 0 ? clip(added, EXCERPT_MAX) : null,
    currency: null,
    percentageChange: null,
    evidenceExcerpt: clip(`Changed text: ${detail}${more}.${note}`, 600),
  };
}

interface ExplanationHints {
  /** Lowercased words that belong to the changed entities (plan names, labels). */
  words: Set<string>;
  amounts: number[];
  /** For added/removed items: the whole item (name, features, price) is the explanation. */
  wholeLabels: string[];
}

const PERIOD_AND_CURRENCY_WORDS = new Set(["mo", "month", "monthly", "yr", "year", "yearly", "annual", "annually", "per", "billed", "usd", "eur", "gbp", "user", "seat"]);

function bare(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function numbersIn(text: string | null): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const match of text.matchAll(/\d[\d.,]*/g)) {
    const n = parseAmount(match[0]);
    if (n !== null) out.push(n);
  }
  return out;
}

function buildExplanationHints(events: ChangeEventDraft[], priorEntities: ExtractedEntity[], currentEntities: ExtractedEntity[]): ExplanationHints {
  const words = new Set<string>();
  const amounts: number[] = [];
  const wholeLabels: string[] = [];
  const byKeyAll = new Map<string, ExtractedEntity>();
  for (const e of [...priorEntities, ...currentEntities]) byKeyAll.set(e.key, e);

  for (const event of events) {
    const entity = event.entityKey ? byKeyAll.get(event.entityKey) : undefined;
    const label = entity?.label ?? "";
    for (const word of label.split(/\s+/)) {
      const w = bare(word);
      if (w) words.add(w);
    }
    amounts.push(...numbersIn(event.oldValue), ...numbersIn(event.newValue));
    if ((event.changeType === "PRODUCT_ADDED" || event.changeType === "PRODUCT_REMOVED" || event.changeType === "PROMOTION_ADDED" || event.changeType === "PROMOTION_REMOVED") && label.trim()) {
      wholeLabels.push(label.trim().toLowerCase());
    }
  }
  return { words, amounts, wholeLabels };
}

function isHunkExplained(hunk: TextHunk, hints: ExplanationHints): boolean {
  const removed = hunk.removed.toLowerCase();
  const added = hunk.added.toLowerCase();
  if (hints.wholeLabels.some((label) => removed.includes(label) || added.includes(label))) return true;

  const tokens = [...hunk.removed.split(/\s+/), ...hunk.added.split(/\s+/)].filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  return tokens.every((token) => {
    const w = bare(token);
    if (w === "") return true; // punctuation or a bare currency symbol
    if (hints.words.has(w) || PERIOD_AND_CURRENCY_WORDS.has(w)) return true;
    const numbers = numbersIn(token);
    return numbers.length > 0 && numbers.every((n) => hints.amounts.some((a) => Math.abs(a - n) < 0.005));
  });
}

/** Where an entity's value came from decides how far its change can be trusted. */
function sourceFactor(entityKey: string | null): number {
  if (!entityKey) return 1;
  if (entityKey.startsWith("jsonld")) return 1; // machine-readable by design
  if (entityKey.startsWith("plan:")) return 0.92; // read from a pricing card/table
  if (entityKey.startsWith("html-promo:")) return 0.8; // matched in visible text
  if (entityKey.startsWith("text-price:")) return 0.6; // a bare price pattern with no name
  return 0.9;
}

/**
 * Confidence = what the rule can establish (the event's own base value) x how good the extraction was
 * x how trustworthy the source of the entity is. Severity never rises above what the evidence supports:
 * a low-confidence event is shown one level lower.
 */
function finalizeEvent(event: ChangeEventDraft, extractionConfidence: number): ChangeEventDraft {
  const quality = Math.min(1, Math.max(0, extractionConfidence));
  const confidence = Math.round(Math.min(1, event.confidence * quality * sourceFactor(event.entityKey)) * 100) / 100;
  let severity = event.severity;
  if (confidence < 0.6) severity = severity === "HIGH" ? "MEDIUM" : "LOW";
  return { ...event, confidence, severity };
}

const OSCILLATION_WINDOW_MS = 48 * 60 * 60_000;

/**
 * A price that flips A -> B and, within two days, B -> A is much more often an A/B test, a regional
 * variant or a rotating experiment than two real repricings. The event is kept (it is real evidence)
 * but reported as low severity and low confidence, with the reversal stated in its evidence.
 */
function flagOscillations(events: ChangeEventDraft[], recent: RecentChangeEvent[], now: Date): ChangeEventDraft[] {
  if (recent.length === 0) return events;
  return events.map((event) => {
    if (event.changeType !== "PRICE_CHANGE" || !event.entityKey) return event;
    const reverted = recent.find(
      (r) =>
        r.changeType === "PRICE_CHANGE" &&
        r.entityKey === event.entityKey &&
        now.getTime() - r.detectedAt.getTime() <= OSCILLATION_WINDOW_MS &&
        comparePrices({ value: r.newValue, currency: r.currency }, { value: event.oldValue, currency: event.currency }).kind === "same" &&
        comparePrices({ value: r.oldValue, currency: r.currency }, { value: event.newValue, currency: event.currency }).kind === "same",
    );
    if (!reverted) return event;
    const hours = Math.max(1, Math.round((now.getTime() - reverted.detectedAt.getTime()) / 3_600_000));
    return {
      ...event,
      severity: "LOW",
      confidence: Math.round(event.confidence * 0.5 * 100) / 100,
      evidenceExcerpt: `${event.evidenceExcerpt} Reverts the change detected ${hours}h ago (possible A/B test or regional pricing).`,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Phase 29 C5: identity
// ---------------------------------------------------------------------------------------------

/** One event per (change type, field): the database enforces it, and a repeated key must never fail a scan. */
function dedupeEvents(events: ChangeEventDraft[]): ChangeEventDraft[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const id = `${event.changeType}|${event.fieldPath}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function planNameOf(label: string): string {
  return label.replace(/\s*\(per (?:month|year)\)\s*$/i, "").trim();
}

function keyFamily(key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith("plan:")) return `plan:${key.slice(key.lastIndexOf(":") + 1)}`; // same billing period
  if (key.startsWith("jsonld:")) return "jsonld";
  return null;
}

/**
 * A plan that disappears under one name while another appears with the SAME price, currency and billing
 * period is most often a rename, not a removal plus an unrelated launch. Treating it as two independent
 * events loses the connection (and, for the customer, reads as two market moves). It is only linked when
 * the match is unambiguous - exactly one candidate on each side - and never merged into a new event type:
 * both events stay (they are still true), but each says what it probably is and is shown as low severity.
 * Real identity continuity (price history surviving a rename) needs the Entity tables of Phase D.
 */
function linkPossibleRenames(events: ChangeEventDraft[], priorEntities: ExtractedEntity[], currentEntities: ExtractedEntity[]): ChangeEventDraft[] {
  const removed = events.filter((e) => e.changeType === "PRODUCT_REMOVED" && e.entityKey);
  const added = events.filter((e) => e.changeType === "PRODUCT_ADDED" && e.entityKey);
  if (removed.length === 0 || added.length === 0) return events;

  const priorByKey = new Map(priorEntities.map((e) => [e.key, e]));
  const currentByKey = new Map(currentEntities.map((e) => [e.key, e]));

  const matches = (r: ChangeEventDraft, a: ChangeEventDraft): boolean => {
    const before = priorByKey.get(r.entityKey!);
    const after = currentByKey.get(a.entityKey!);
    if (!before || !after || before.value === null || after.value === null) return false;
    const familyBefore = keyFamily(before.key);
    if (familyBefore === null || familyBefore !== keyFamily(after.key)) return false;
    return comparePrices(before, after).kind === "same";
  };

  const replacements = new Map<ChangeEventDraft, ChangeEventDraft>();
  for (const r of removed) {
    const candidates = added.filter((a) => matches(r, a));
    if (candidates.length !== 1) continue;
    const a = candidates[0]!;
    if (removed.filter((other) => matches(other, a)).length !== 1) continue;

    const oldName = planNameOf(priorByKey.get(r.entityKey!)!.label);
    const newName = planNameOf(currentByKey.get(a.entityKey!)!.label);
    const note = `Possibly renamed: "${oldName}" -> "${newName}" (same price, currency and billing period).`;
    replacements.set(r, { ...r, severity: "LOW", confidence: Math.round(r.confidence * 0.8 * 100) / 100, evidenceExcerpt: `${r.evidenceExcerpt} ${note}` });
    replacements.set(a, { ...a, severity: "LOW", confidence: Math.round(a.confidence * 0.8 * 100) / 100, evidenceExcerpt: `${a.evidenceExcerpt} ${note}` });
  }
  return events.map((e) => replacements.get(e) ?? e);
}
