import { AiProviderRequestError, AiProviderTimeoutError } from "./errors.js";
import type { AiProvider, ChangeAnalysisInput, NormalizedAiResponse } from "./types.js";

function isRetryable(err: unknown): boolean {
  if (err instanceof AiProviderRequestError) return err.retryable;
  if (err instanceof AiProviderTimeoutError) return true;
  return false;
}

/**
 * Exactly one retry on a transient failure (Section 6's "retry
 * policy"), applied uniformly to any AiProvider so an implementation
 * only needs to classify its own errors as retryable via
 * AiProviderRequestError's `retryable` flag - it does not need its own
 * retry loop. Deliberately just one retry, not exponential backoff:
 * Section 7 (cost control) means every retry is a second paid call, and
 * this runs inside a BullMQ job that already has its own outer
 * lifecycle (see apps/worker/src/aiPipeline.ts).
 */
export async function analyzeChangeWithRetry(provider: AiProvider, input: ChangeAnalysisInput): Promise<NormalizedAiResponse> {
  try {
    return await provider.analyzeChange(input);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    return provider.analyzeChange(input);
  }
}
