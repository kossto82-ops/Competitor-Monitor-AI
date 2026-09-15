import type { AiProvider, AiProviderResult, ChangeAnalysisInput } from "../types.js";
import { parseAiOutput } from "../parseOutput.js";

/**
 * Deterministic test double for AiProvider (Section 14: "the fake
 * provider must be injected through the provider interface... do not
 * use a live paid model for the automated test suite"). Also usable
 * from apps/worker in a real (non-mocked) process when
 * CMA_AI_PROVIDER=fake is set - e.g. for Playwright E2E runs, so the
 * full queue/worker/UI path is exercised without a real API key or
 * real cost, exactly like CMA_ALLOW_PRIVATE_TARGETS lets E2E hit the
 * fixture server without touching the real internet.
 *
 * `respond` receives the exact bounded input the real provider would
 * receive and returns raw response text - it goes through the same
 * parseAiOutput() as a real provider, so a test asserting "malformed
 * JSON is rejected" or "schema-invalid output is rejected" exercises
 * the real validation path, not a shortcut around it.
 */
export interface FakeAiProviderOptions {
  respond?: (input: ChangeAnalysisInput) => string | Promise<string>;
  /**
   * Throws this error instead of returning a response - use
   * `() => new AiProviderTimeoutError("fake", 20_000)` to simulate a
   * timeout without actually waiting for one in a test.
   */
  throwError?: () => Error;
  /** Number of calls (starting at 1) that should fail via throwError before succeeding. */
  failFirstNCalls?: number;
}

function defaultCannedResponse(input: ChangeAnalysisInput): string {
  const facts: string[] = [];
  const interpretations: string[] = [];

  if (input.changeType === "PRICE_CHANGE" && input.priceChange) {
    facts.push(`The listed price changed from ${input.priceChange.oldValue} to ${input.priceChange.newValue}.`);
    interpretations.push("This price change may affect how the offer compares to similar products on the monitored page.");
  } else if (input.changeType === "PRODUCT_ADDED" && input.productAdded) {
    facts.push(`A new item "${input.productAdded.label}" was detected with value ${input.productAdded.value}.`);
    interpretations.push("The newly detected item may represent an expanded offering.");
  } else if (input.changeType === "PRODUCT_REMOVED" && input.productRemoved) {
    facts.push(`The previously detected item "${input.productRemoved.label}" was no longer detected in the monitored content.`);
    interpretations.push("The item's absence may reflect a page update, though the cause cannot be confirmed from this evidence alone.");
  }

  return JSON.stringify({
    summary: `Fake analysis of a ${input.changeType} change.`,
    facts,
    interpretations,
    speculation: [],
    confidence: "medium",
  });
}

export function createFakeAiProvider(options: FakeAiProviderOptions = {}): AiProvider & { callCount: number } {
  let callCount = 0;

  return {
    name: "fake",
    get callCount() {
      return callCount;
    },
    async analyzeChange(input: ChangeAnalysisInput): Promise<AiProviderResult> {
      callCount += 1;

      if (options.throwError && (options.failFirstNCalls === undefined || callCount <= options.failFirstNCalls)) {
        throw options.throwError();
      }

      const rawText = options.respond ? await options.respond(input) : defaultCannedResponse(input);
      const output = parseAiOutput("fake", rawText);

      return {
        output,
        provider: "fake",
        model: "fake-v1",
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
      };
    },
  };
}
