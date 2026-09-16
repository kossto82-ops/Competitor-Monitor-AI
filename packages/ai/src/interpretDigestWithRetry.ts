import { AiProviderRequestError, AiProviderTimeoutError } from "./errors.js";
import type { AiProvider, EvidenceBundleInput, NormalizedAiResponse } from "./types.js";

function isRetryable(err: unknown): boolean {
  if (err instanceof AiProviderRequestError) return err.retryable;
  if (err instanceof AiProviderTimeoutError) return true;
  return false;
}

/**
 * Phase 11's equivalent of analyzeChangeWithRetry.ts - exactly one retry
 * on a transient failure, never more (Section 18 of the brief: "maximum
 * provider calls = 1" per interpretation *attempt*; this is the single,
 * uniformly-applied exception the ChangeEvent path already has, not a
 * second, looser retry budget). A digest interpretation "act" (one
 * BullMQ job) therefore makes at most 2 HTTP attempts and never more
 * than that, exactly mirroring the ChangeEvent path.
 */
export async function interpretDigestWithRetry(provider: AiProvider, input: EvidenceBundleInput): Promise<NormalizedAiResponse> {
  try {
    return await provider.interpretDigest(input);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    return provider.interpretDigest(input);
  }
}
