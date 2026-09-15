import { MAX_EVIDENCE_EXCERPT_CHARS, MAX_SNAPSHOT_EXCERPT_CHARS, MAX_VALUE_CHARS, truncate } from "./limits.js";
import { isSupportedAiChangeType, type ChangeAnalysisInput } from "./types.js";

/**
 * The subset of a ChangeEvent (+ its two snapshots) buildChangeAnalysisInput
 * needs. Deliberately narrow and duck-typed rather than importing
 * @cma/db's Prisma types - this package must stay usable without a
 * database dependency (see the package-level note in index.ts).
 */
export interface ChangeEventForAnalysis {
  changeType: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  entityKey: string | null;
  evidenceExcerpt: string;
  detectedAt: Date | string;
  monitoredUrl: { url: string };
  previousSnapshot: { normalizedContent: string } | null;
  // `verificationState` is not read by buildChangeAnalysisInput itself -
  // it exists on this type so callers (apps/worker/src/aiPipeline.ts)
  // can defensively refuse to analyze a FAILED_TO_VERIFY snapshot
  // without needing a second, wider type.
  currentSnapshot: { normalizedContent: string; verificationState: string };
}

/**
 * Section 1 + 7: builds the minimum, bounded, per-changeType context
 * sent to the model. Returns null when the changeType has no analysis
 * context defined yet (Section 2) - callers must treat that as "do not
 * call the AI for this ChangeEvent", not as an error.
 */
export function buildChangeAnalysisInput(changeEvent: ChangeEventForAnalysis): ChangeAnalysisInput | null {
  if (!isSupportedAiChangeType(changeEvent.changeType)) return null;

  const base = {
    changeType: changeEvent.changeType,
    sourceUrl: changeEvent.monitoredUrl.url,
    detectedAt: new Date(changeEvent.detectedAt).toISOString(),
    evidenceExcerpt: truncate(changeEvent.evidenceExcerpt, MAX_EVIDENCE_EXCERPT_CHARS),
  };

  const previousExcerpt = changeEvent.previousSnapshot
    ? truncate(changeEvent.previousSnapshot.normalizedContent, MAX_SNAPSHOT_EXCERPT_CHARS)
    : null;
  const currentExcerpt = truncate(changeEvent.currentSnapshot.normalizedContent, MAX_SNAPSHOT_EXCERPT_CHARS);

  switch (changeEvent.changeType) {
    case "PRICE_CHANGE":
      return {
        ...base,
        previousExcerpt,
        currentExcerpt,
        priceChange: {
          oldValue: changeEvent.oldValue ? truncate(changeEvent.oldValue, MAX_VALUE_CHARS) : null,
          newValue: changeEvent.newValue ? truncate(changeEvent.newValue, MAX_VALUE_CHARS) : null,
          currency: changeEvent.currency,
          percentageChange: changeEvent.percentageChange,
        },
        productAdded: null,
        productRemoved: null,
      };
    case "PRODUCT_ADDED":
      return {
        ...base,
        previousExcerpt: null,
        currentExcerpt,
        priceChange: null,
        productAdded: {
          label: changeEvent.entityKey ?? "unlabeled item",
          value: changeEvent.newValue ? truncate(changeEvent.newValue, MAX_VALUE_CHARS) : null,
        },
        productRemoved: null,
      };
    case "PRODUCT_REMOVED":
      return {
        ...base,
        previousExcerpt,
        currentExcerpt: null,
        priceChange: null,
        productAdded: null,
        productRemoved: {
          label: changeEvent.entityKey ?? "unlabeled item",
          value: changeEvent.oldValue ? truncate(changeEvent.oldValue, MAX_VALUE_CHARS) : null,
        },
      };
  }
}
