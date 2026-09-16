import type { AiProvider, ChangeAnalysisInput, EvidenceBundleInput, NormalizedAiResponse } from "../types.js";

/**
 * Deterministic test double for AiProvider (Section 11/26: "the fake
 * provider must be injected through the provider interface... automated
 * test suites must NOT depend on paid external AI calls"). Also usable
 * from apps/worker in a real (non-mocked) process when
 * CMA_AI_PROVIDER=fake is set - e.g. for Playwright E2E runs, so the
 * full queue/worker/UI path is exercised without a real API key or
 * real cost, exactly like CMA_ALLOW_PRIVATE_TARGETS lets E2E hit the
 * fixture server without touching the real internet.
 *
 * `respond` receives the exact bounded input the real provider would
 * receive and returns raw response text - this text goes through the
 * exact same parseAiOutput() validation a real provider's output would
 * (via analyzeAndValidateChange.ts), never a shortcut around it, so a
 * test asserting "malformed JSON is rejected" or "schema-invalid output
 * is rejected" exercises the real validation path.
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
  /** Phase 11: same `respond`/`throwError` shape as analyzeChange, for the interpretDigest operation. */
  respondDigest?: (input: EvidenceBundleInput) => string | Promise<string>;
  throwErrorDigest?: () => Error;
  failFirstNDigestCalls?: number;
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

/**
 * Deterministic canned Tier-4 response - always cites the first
 * evidenceChangeEventId of the first competitor/item it finds, so a
 * test asserting "evidence links work" has something real to click
 * without depending on real-model output. Returns the brief's own
 * "insufficient evidence" shape when the bundle has nothing to interpret.
 */
function defaultCannedDigestResponse(input: EvidenceBundleInput): string {
  const firstCompetitor = input.competitors[0];
  const firstItem = firstCompetitor?.items[0];
  if (!firstCompetitor || !firstItem) {
    return JSON.stringify({
      summary: "There is not enough verified activity in this period to interpret.",
      observations: [],
      interpretations: [],
      hypotheses: [],
    });
  }

  const evidenceChangeEventIds = firstItem.evidenceChangeEventIds;
  return JSON.stringify({
    summary: `Fake interpretation of ${input.competitors.length} tracked competitor(s) over the last ${input.period.days} days.`,
    observations: [
      { text: `${firstCompetitor.competitorName} has verified activity in this period.`, evidenceChangeEventIds },
    ],
    interpretations: [],
    hypotheses: [],
  });
}

export function createFakeAiProvider(
  options: FakeAiProviderOptions = {},
): AiProvider & { callCount: number; digestCallCount: number } {
  let callCount = 0;
  let digestCallCount = 0;

  return {
    name: "fake",
    get callCount() {
      return callCount;
    },
    get digestCallCount() {
      return digestCallCount;
    },
    async analyzeChange(input: ChangeAnalysisInput): Promise<NormalizedAiResponse> {
      callCount += 1;

      if (options.throwError && (options.failFirstNCalls === undefined || callCount <= options.failFirstNCalls)) {
        throw options.throwError();
      }

      const content = options.respond ? await options.respond(input) : defaultCannedResponse(input);
      return { content, inputTokens: 100, outputTokens: 50, totalTokens: 150, finishReason: "stop" };
    },
    async interpretDigest(input: EvidenceBundleInput): Promise<NormalizedAiResponse> {
      digestCallCount += 1;

      if (options.throwErrorDigest && (options.failFirstNDigestCalls === undefined || digestCallCount <= options.failFirstNDigestCalls)) {
        throw options.throwErrorDigest();
      }

      const content = options.respondDigest ? await options.respondDigest(input) : defaultCannedDigestResponse(input);
      return { content, inputTokens: 200, outputTokens: 80, totalTokens: 280, finishReason: "stop" };
    },
  };
}
