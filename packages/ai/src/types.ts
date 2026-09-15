/**
 * Change types the AI layer knows how to interpret (Section 1 of the
 * brief). Deliberately a subset of @cma/core's full ChangeType union -
 * PROMOTION_CHANGE and CONTENT_CHANGE are real deterministic change
 * types the monitoring engine already emits, but no analysis context
 * has been designed for them yet. Adding support means adding a case
 * here and in buildChangeAnalysisInput, not inventing behavior.
 */
export const SUPPORTED_AI_CHANGE_TYPES = ["PRICE_CHANGE", "PRODUCT_ADDED", "PRODUCT_REMOVED"] as const;
export type SupportedAiChangeType = (typeof SUPPORTED_AI_CHANGE_TYPES)[number];

export function isSupportedAiChangeType(changeType: string): changeType is SupportedAiChangeType {
  return (SUPPORTED_AI_CHANGE_TYPES as readonly string[]).includes(changeType);
}

/**
 * The minimum, bounded context sent to the model for one ChangeEvent.
 * Every string field here has already been truncated by
 * buildChangeAnalysisInput per packages/ai/src/limits.ts - this type
 * carries no raw snapshot or raw HTML, only what Section 7 (cost
 * control) allows.
 */
export interface ChangeAnalysisInput {
  changeType: SupportedAiChangeType;
  sourceUrl: string;
  detectedAt: string;
  evidenceExcerpt: string;
  previousExcerpt: string | null;
  currentExcerpt: string | null;
  priceChange: { oldValue: string | null; newValue: string | null; currency: string | null; percentageChange: number | null } | null;
  productAdded: { label: string; value: string | null } | null;
  productRemoved: { label: string; value: string | null } | null;
}

export const AI_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type AiConfidenceLevel = (typeof AI_CONFIDENCE_LEVELS)[number];

/**
 * The strict, schema-validated shape every provider must return
 * (Section 5). Nothing outside this shape is ever persisted as
 * trusted structured data.
 */
export interface AiAnalysisOutput {
  summary: string;
  facts: string[];
  interpretations: string[];
  speculation: string[];
  confidence: AiConfidenceLevel;
}

export interface AiProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AiProviderResult {
  output: AiAnalysisOutput;
  provider: string;
  model: string;
  usage: AiProviderUsage;
}

/**
 * Section 6: the only contract the rest of the system depends on.
 * `analyzeChange` may throw AiProviderTimeoutError, AiProviderRequestError
 * or AiOutputValidationError (see errors.ts) - callers (aiPipeline.ts in
 * apps/worker) are responsible for turning those into a FAILED
 * AiAnalysis row, never for retrying indefinitely.
 */
export interface AiProvider {
  readonly name: string;
  analyzeChange(input: ChangeAnalysisInput): Promise<AiProviderResult>;
}
