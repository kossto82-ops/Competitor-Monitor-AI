import type { ChangeEventDraft, ComparisonResult, ExtractedEntity, Severity } from "@cma/core";

export interface PriorSnapshotData {
  contentHash: string | null;
  structuredDataHash: string | null;
  normalizedContent: string;
  entities: ExtractedEntity[];
}

export interface CurrentExtractionData {
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
export function compareSnapshots(prior: PriorSnapshotData | null, current: CurrentExtractionData): ComparisonResult {
  const failureReason = describeExtractionFailure(current);
  if (failureReason) {
    return { verificationState: "FAILED_TO_VERIFY", reason: failureReason, changeEvents: [] };
  }

  if (prior === null) {
    return { verificationState: "NO_CHANGE", reason: "No prior snapshot exists - this is the baseline.", changeEvents: [] };
  }

  const identical = current.contentHash === prior.contentHash && current.structuredDataHash === prior.structuredDataHash;
  if (identical) {
    return { verificationState: "NO_CHANGE", reason: "Content and structured data hashes are unchanged.", changeEvents: [] };
  }

  const changeEvents: ChangeEventDraft[] = [
    ...detectPriceChanges(prior.entities, current.entities),
    ...detectProductAddedOrRemoved(prior.entities, current.entities),
    ...detectPromotionChanges(prior.entities, current.entities),
    ...detectPromotionAddedOrRemoved(prior.entities, current.entities),
  ];

  const explainedByEntities = changeEvents.length > 0;
  if (!explainedByEntities && current.contentHash !== prior.contentHash) {
    changeEvents.push(detectGenericContentChange(prior.normalizedContent, current.normalizedContent));
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

function parseNumeric(value: string | null): number | null {
  if (value === null) return null;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  if (cleaned.length === 0) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
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
    if (!previous || previous.value === current.value) continue;

    const oldNum = parseNumeric(previous.value);
    const newNum = parseNumeric(current.value);

    if (oldNum === null || newNum === null || oldNum === 0) {
      // Can't compute a reliable percentage - still a real, evidenced value
      // change, just without a derived percentage.
      events.push({
        changeType: "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.7,
        entityKey: current.key,
        fieldPath: current.key,
        oldValue: previous.value,
        newValue: current.value,
        currency: current.currency ?? previous.currency,
        percentageChange: null,
        evidenceExcerpt: `${previous.label}: ${previous.value ?? "?"} -> ${current.value ?? "?"}`,
      });
      continue;
    }

    const percentageChange = ((newNum - oldNum) / oldNum) * 100;
    events.push({
      changeType: "PRICE_CHANGE",
      severity: severityForPercentageChange(Math.abs(percentageChange)),
      confidence: 0.95,
      entityKey: current.key,
      fieldPath: current.key,
      oldValue: previous.value,
      newValue: current.value,
      currency: current.currency ?? previous.currency,
      percentageChange: Math.round(percentageChange * 100) / 100,
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

function detectGenericContentChange(previousText: string, currentText: string): ChangeEventDraft {
  const excerptLength = 300;
  return {
    changeType: "CONTENT_CHANGE",
    severity: "LOW",
    confidence: 0.5,
    entityKey: null,
    fieldPath: "page.visibleText",
    oldValue: previousText.slice(0, excerptLength),
    newValue: currentText.slice(0, excerptLength),
    currency: null,
    percentageChange: null,
    evidenceExcerpt: `Visible page text changed (showing first ${excerptLength} characters of each version).`,
  };
}
