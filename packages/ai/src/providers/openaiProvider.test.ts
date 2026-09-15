import { describe, expect, it } from "vitest";
import { OpenAiProvider } from "./openaiProvider.js";
import { AiProviderRequestError, AiProviderTimeoutError } from "../errors.js";
import type { ChangeAnalysisInput } from "../types.js";

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

const VALID_OUTPUT_TEXT = JSON.stringify({
  summary: "The price dropped from 49.00 to 39.00.",
  facts: ["The listed price changed from 49.00 EUR to 39.00 EUR."],
  interpretations: ["This may make the offer more price-competitive."],
  speculation: [],
  confidence: "medium",
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function successBody(overrides: Partial<{ model: string; id: string; outputText: string; usage: { input_tokens: number; output_tokens: number; total_tokens: number } }> = {}) {
  return {
    id: overrides.id ?? "resp_abc123",
    model: overrides.model ?? "gpt-5.6-luna",
    output: [
      { type: "reasoning" }, // Responses API can emit non-message items first - must be skipped.
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: overrides.outputText ?? VALID_OUTPUT_TEXT }],
      },
    ],
    usage: overrides.usage ?? { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
  };
}

describe("OpenAiProvider", () => {
  it("normalizes a successful Responses API result into content text + token usage + bounded providerMetadata (Section 13)", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      fetchImpl: async () => jsonResponse(200, successBody()),
    });

    const result = await provider.analyzeChange(INPUT);

    // Section 2/8: no vendor-specific object escapes the provider - only
    // plain text + numbers + small metadata.
    expect(result.content).toBe(VALID_OUTPUT_TEXT);
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(40);
    expect(result.totalTokens).toBe(160);
    expect(result.finishReason).toBe("completed");
    expect(result.providerMetadata).toEqual({ responseId: "resp_abc123", responseModel: "gpt-5.6-luna" });
  });

  it("does NOT itself parse or validate the JSON inside content - that is analyzeAndValidateChange.ts's job", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      fetchImpl: async () => jsonResponse(200, successBody({ outputText: "this is not json at all" })),
    });
    // Resolves successfully even though the content is not valid JSON -
    // the provider's contract is "return the text", not "return valid JSON".
    const result = await provider.analyzeChange(INPUT);
    expect(result.content).toBe("this is not json at all");
  });

  it("skips non-message output items (e.g. a reasoning item) when extracting the text", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      fetchImpl: async () => jsonResponse(200, successBody()),
    });
    await expect(provider.analyzeChange(INPUT)).resolves.toBeDefined();
  });

  it("sends the API key only via the Authorization header, never in the body or the URL", async () => {
    let capturedInit: RequestInit | undefined;
    const provider = new OpenAiProvider({
      apiKey: "sk-secret-value",
      model: "gpt-5.6-luna",
      fetchImpl: async (_url, init) => {
        capturedInit = init;
        return jsonResponse(200, successBody());
      },
    });
    await provider.analyzeChange(INPUT);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-secret-value");
    expect(capturedInit?.body).not.toContain("sk-secret-value");
  });

  it("treats HTTP 401 (invalid/missing API key) as a non-retryable, permanent failure (Section 12)", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-bad",
      model: "gpt-5.6-luna",
      fetchImpl: async () => jsonResponse(401, { error: { message: "Incorrect API key provided" } }),
    });

    try {
      await provider.analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderRequestError);
      expect((err as AiProviderRequestError).retryable).toBe(false);
      expect((err as Error).message).toContain("Incorrect API key provided");
    }
  });

  it("treats HTTP 429 as retryable", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      fetchImpl: async () => jsonResponse(429, { error: { message: "Rate limit exceeded" } }),
    });
    try {
      await provider.analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AiProviderRequestError).retryable).toBe(true);
    }
  });

  it("treats HTTP 500 as retryable", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      fetchImpl: async () => jsonResponse(500, { error: { message: "Internal server error" } }),
    });
    try {
      await provider.analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AiProviderRequestError).retryable).toBe(true);
    }
  });

  it("treats HTTP 400 (e.g. an unknown/misconfigured model) as non-retryable", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "not-a-real-model",
      fetchImpl: async () => jsonResponse(400, { error: { message: "The model 'not-a-real-model' does not exist" } }),
    });
    try {
      await provider.analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AiProviderRequestError).retryable).toBe(false);
    }
  });

  it("surfaces a request timeout as AiProviderTimeoutError", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    await expect(provider.analyzeChange(INPUT)).rejects.toBeInstanceOf(AiProviderTimeoutError);
  });

  it("fails with a non-retryable error when the response has no output_text content block at all", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      fetchImpl: async () => jsonResponse(200, { model: "gpt-5.6-luna", output: [{ type: "reasoning" }], usage: {} }),
    });
    try {
      await provider.analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderRequestError);
      expect((err as AiProviderRequestError).retryable).toBe(false);
    }
  });

  it("classifies a network-level failure (e.g. DNS/connection error) as retryable", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.openai.com");
      },
    });
    try {
      await provider.analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderRequestError);
      expect((err as AiProviderRequestError).retryable).toBe(true);
    }
  });
});
