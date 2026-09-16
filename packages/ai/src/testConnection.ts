import { createAiProvider, AiProviderConfigError, UnsupportedAiProviderError, type AiConnectionConfig } from "./registry.js";
import { AiProviderTimeoutError, AiProviderRequestError } from "./errors.js";
import type { ChangeAnalysisInput } from "./types.js";

/**
 * Phase 5 (Section 9): the customer-facing "Test connection" action.
 * Deliberately reuses the exact same `createAiProvider` +
 * `provider.analyzeChange` path production analysis uses (Section 28:
 * no duplication) with a single, cheap, synthetic input - it makes ONE
 * real provider call with a short timeout, never the retried path
 * (`analyzeChangeWithRetry`), since a connection test should fail fast
 * and reflect exactly what just happened, not a retried outcome.
 *
 * Never surfaces the provider's raw error message to the caller
 * (Section 9: "do not expose raw provider errors containing
 * credentials or sensitive data") - every outcome is mapped to one of a
 * small, fixed set of customer-safe messages.
 */
export type ConnectionTestStatus =
  | "SUCCESS"
  | "INVALID_CREDENTIALS"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_CONFIGURATION";

export interface ConnectionTestResult {
  status: ConnectionTestStatus;
  message: string;
}

const HUMAN_MESSAGE: Record<ConnectionTestStatus, string> = {
  SUCCESS: "Connection successful.",
  INVALID_CREDENTIALS: "Invalid credentials. Check the API key for this provider.",
  MODEL_UNAVAILABLE: "The configured model is unavailable for this API key.",
  PROVIDER_UNAVAILABLE: "The provider did not respond. It may be temporarily unavailable.",
  INVALID_CONFIGURATION: "This configuration is invalid. Check the provider, model, and base URL.",
};

/** A tiny, fixed, synthetic change - never real customer or competitor data - used purely to exercise the real request path. */
const TEST_INPUT: ChangeAnalysisInput = {
  changeType: "PRICE_CHANGE",
  sourceUrl: "https://example.test/pricing",
  detectedAt: new Date(0).toISOString(),
  evidenceExcerpt: "Pro Plan price changed from 49.00 to 59.00 USD.",
  previousExcerpt: "Pro Plan 49.00 USD",
  currentExcerpt: "Pro Plan 59.00 USD",
  priceChange: { oldValue: "49.00", newValue: "59.00", currency: "USD", percentageChange: 20.41 },
  productAdded: null,
  productRemoved: null,
};

/**
 * Classifies an AiProviderRequestError. `retryable` (set by the
 * provider adapter from the HTTP status - see openaiProvider.ts's
 * "429/5xx are transient" comment) is checked FIRST: a retryable
 * failure is a provider-side/transient problem, never the customer's
 * configuration, regardless of the vendor's wording. Only a
 * non-retryable (permanent, 4xx-other-than-429) failure falls through
 * to a message-based heuristic, since provider adapters do not
 * currently carry a more structured error code.
 */
function classifyRequestError(message: string, retryable: boolean): ConnectionTestStatus {
  if (retryable) return "PROVIDER_UNAVAILABLE";

  const lower = message.toLowerCase();
  if (lower.includes("api key") || lower.includes("apikey") || lower.includes("auth") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("permission")) {
    return "INVALID_CREDENTIALS";
  }
  if (lower.includes("model")) {
    return "MODEL_UNAVAILABLE";
  }
  return "INVALID_CONFIGURATION";
}

/**
 * Runs the test against an ALREADY-CONSTRUCTED provider - split out from
 * `testAiConnection` purely so tests can inject a provider with a custom
 * `fetchImpl` (see testConnection.test.ts) without needing
 * `AiConnectionConfig` to carry test-only plumbing. `testAiConnection`
 * (below) is the real entry point every call site outside this file uses.
 */
export async function runConnectionTest(provider: { analyzeChange: (input: ChangeAnalysisInput) => Promise<unknown> }): Promise<ConnectionTestResult> {
  try {
    await provider.analyzeChange(TEST_INPUT);
    // A well-formed response came back at all - the credential, model, and
    // (for openai-compatible) base URL are all reachable and accepted.
    // Whether the model's OWN output happens to validate against the
    // structured-output schema is a model-quality concern for real
    // analyses, not a connectivity concern for this test.
    return { status: "SUCCESS", message: HUMAN_MESSAGE.SUCCESS };
  } catch (err) {
    if (err instanceof AiProviderTimeoutError) {
      return { status: "PROVIDER_UNAVAILABLE", message: HUMAN_MESSAGE.PROVIDER_UNAVAILABLE };
    }
    if (err instanceof AiProviderRequestError) {
      const status = classifyRequestError(err.message, err.retryable);
      return { status, message: HUMAN_MESSAGE[status] };
    }
    return { status: "INVALID_CONFIGURATION", message: HUMAN_MESSAGE.INVALID_CONFIGURATION };
  }
}

export async function testAiConnection(config: AiConnectionConfig): Promise<ConnectionTestResult> {
  let provider;
  try {
    provider = createAiProvider(config);
  } catch (err) {
    if (err instanceof AiProviderConfigError || err instanceof UnsupportedAiProviderError) {
      return { status: "INVALID_CONFIGURATION", message: HUMAN_MESSAGE.INVALID_CONFIGURATION };
    }
    throw err;
  }

  return runConnectionTest(provider);
}
