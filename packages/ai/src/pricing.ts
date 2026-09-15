/**
 * Phase 3 (Section 11), widened in Phase 3.1 (Section 14) to be
 * provider-neutral: one centralized place for token pricing so
 * `costUsd` is never computed (or hard-coded) ad hoc inside any
 * provider adapter. Prices are USD per 1,000,000 tokens, matching how
 * model providers publish pricing. Keyed by `${provider}/${model}`,
 * not by model name alone - model names are not guaranteed unique
 * across vendors (an "openai-compatible" customer endpoint could name
 * its own model anything).
 *
 * Deliberately a plain lookup table, not a live pricing API call -
 * pricing changes rarely enough that a manual update here is the right
 * trade-off, and a network call on every completed analysis just to
 * price it would be its own reliability/cost problem.
 *
 * A `provider/model` not present here is a KNOWN GAP, not a bug:
 * `calculateCostUsd` returns `null` rather than guessing, and callers
 * must persist `null` rather than fabricate a number (Section 11/14:
 * "Never fabricate cost data").
 */
export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Actual published OpenAI pricing at time of writing - kept for any
  // deployment that configures one of these via CMA_AI_MODEL or an
  // AiConnection.
  "openai/gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  "openai/gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
};

/**
 * Returns null (never a guess) when the configured provider/model has
 * no entry above. This is the expected outcome for
 * `CMA_AI_MODEL=gpt-5.6-luna` (this project's Phase 3 default) and for
 * any `openai-compatible` connection - no published per-token pricing
 * exists for a customer-chosen model, so `costUsd` stays null on every
 * completed analysis until a real price is known and added to
 * MODEL_PRICING.
 */
export function calculateCostUsd(
  provider: string,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | null {
  const pricing = MODEL_PRICING[`${provider}/${model}`];
  if (!pricing || inputTokens === undefined || outputTokens === undefined) return null;
  const cost = (inputTokens / 1_000_000) * pricing.inputPerMillionUsd + (outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
