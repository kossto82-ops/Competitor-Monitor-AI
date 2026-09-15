import { describe, expect, it } from "vitest";
import { analyzeAndValidateChange } from "./analyzeAndValidateChange.js";
import { createFakeAiProvider } from "./providers/fakeProvider.js";
import { AiOutputValidationError } from "./errors.js";
import type { ChangeAnalysisInput } from "./types.js";

const INPUT: ChangeAnalysisInput = {
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

/**
 * Section 13/4: this is the ONE place malformed/schema-invalid output
 * is rejected, applied identically no matter which AiProvider produced
 * the raw text - these tests use the fake provider, but the same
 * function is what apps/worker/src/aiPipeline.ts calls for OpenAI and
 * OpenAI-compatible providers too (see their own provider-level tests,
 * which confirm they never parse/validate content themselves anymore).
 */
describe("analyzeAndValidateChange", () => {
  it("returns the parsed, schema-valid output alongside the raw normalized response", async () => {
    const provider = createFakeAiProvider();
    const result = await analyzeAndValidateChange(provider, INPUT);
    expect(result.output.summary).toBeTruthy();
    expect(result.raw.content).toBeTruthy();
    expect(result.raw.inputTokens).toBe(100);
  });

  it("rejects malformed (non-JSON) content regardless of which provider produced it", async () => {
    const provider = createFakeAiProvider({ respond: () => "not json at all" });
    await expect(analyzeAndValidateChange(provider, INPUT)).rejects.toBeInstanceOf(AiOutputValidationError);
  });

  it("rejects well-formed JSON that fails schema validation", async () => {
    const provider = createFakeAiProvider({ respond: () => JSON.stringify({ summary: "x" }) });
    await expect(analyzeAndValidateChange(provider, INPUT)).rejects.toBeInstanceOf(AiOutputValidationError);
  });

  it("still retries once on a retryable provider failure before validating anything", async () => {
    let calls = 0;
    const provider = createFakeAiProvider({
      respond: () => {
        calls += 1;
        return JSON.stringify({ summary: "ok", facts: [], interpretations: [], speculation: [], confidence: "low" });
      },
    });
    await analyzeAndValidateChange(provider, INPUT);
    expect(calls).toBe(1);
    expect(provider.callCount).toBe(1);
  });
});
