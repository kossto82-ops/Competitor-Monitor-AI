import { describe, expect, it } from "vitest";
import { analyzeChangeWithRetry } from "./analyzeChangeWithRetry.js";
import { createFakeAiProvider } from "./providers/fakeProvider.js";
import { AiProviderRequestError, AiProviderTimeoutError } from "./errors.js";
import type { ChangeAnalysisInput } from "./types.js";

const input: ChangeAnalysisInput = {
  changeType: "PRICE_CHANGE",
  sourceUrl: "https://competitor.test/pricing",
  detectedAt: "2026-01-01T00:00:00.000Z",
  evidenceExcerpt: "Pro Plan now 39.00 EUR",
  previousExcerpt: "Pro Plan 49.00 EUR",
  currentExcerpt: "Pro Plan 39.00 EUR",
  priceChange: { oldValue: "49.00", newValue: "39.00", currency: "EUR", percentageChange: -20.41 },
  productAdded: null,
  productRemoved: null,
};

describe("analyzeChangeWithRetry", () => {
  it("succeeds on the first attempt without retrying when nothing fails", async () => {
    const provider = createFakeAiProvider();
    const result = await analyzeChangeWithRetry(provider, input);
    expect(result.output.summary).toBeTruthy();
    expect(provider.callCount).toBe(1);
  });

  it("retries exactly once after a retryable failure, then succeeds", async () => {
    const provider = createFakeAiProvider({
      failFirstNCalls: 1,
      throwError: () => new AiProviderRequestError("fake", "temporary 503", true),
    });
    const result = await analyzeChangeWithRetry(provider, input);
    expect(result.output.summary).toBeTruthy();
    expect(provider.callCount).toBe(2);
  });

  it("treats a timeout as retryable", async () => {
    const provider = createFakeAiProvider({
      failFirstNCalls: 1,
      throwError: () => new AiProviderTimeoutError("fake", 20_000),
    });
    const result = await analyzeChangeWithRetry(provider, input);
    expect(result.output.summary).toBeTruthy();
    expect(provider.callCount).toBe(2);
  });

  it("does not retry a second time - two consecutive failures propagate the second error", async () => {
    const provider = createFakeAiProvider({
      failFirstNCalls: 2,
      throwError: () => new AiProviderRequestError("fake", "still failing", true),
    });
    await expect(analyzeChangeWithRetry(provider, input)).rejects.toThrow(AiProviderRequestError);
    expect(provider.callCount).toBe(2);
  });

  it("never retries a non-retryable failure (e.g. a bad request / auth error)", async () => {
    const provider = createFakeAiProvider({
      failFirstNCalls: 1,
      throwError: () => new AiProviderRequestError("fake", "invalid api key", false),
    });
    await expect(analyzeChangeWithRetry(provider, input)).rejects.toThrow(AiProviderRequestError);
    expect(provider.callCount).toBe(1);
  });
});
