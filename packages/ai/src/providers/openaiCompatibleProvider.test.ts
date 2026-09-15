import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "./openaiCompatibleProvider.js";
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
  summary: "The price dropped.",
  facts: ["The listed price changed from 49.00 EUR to 39.00 EUR."],
  interpretations: [],
  speculation: [],
  confidence: "medium",
});

/**
 * `safePostJson` (Section 20) rejects loopback/private targets unless
 * this exact opt-in is set - same convention as every other SSRF-guard
 * test in this codebase (see packages/security/src/resolveHost.ts).
 * Enabled only for tests that need to actually reach the local server;
 * the dedicated SSRF-rejection tests below deliberately do NOT set it.
 */
function allowLoopbackForThisTest() {
  const originalNodeEnv = process.env["NODE_ENV"];
  const originalAllow = process.env["CMA_ALLOW_PRIVATE_TARGETS"];
  process.env["NODE_ENV"] = "development";
  process.env["CMA_ALLOW_PRIVATE_TARGETS"] = "true";
  return () => {
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
    if (originalAllow === undefined) delete process.env["CMA_ALLOW_PRIVATE_TARGETS"];
    else process.env["CMA_ALLOW_PRIVATE_TARGETS"] = originalAllow;
  };
}

describe("OpenAiCompatibleProvider", () => {
  let server: http.Server;
  let port: number;
  let lastAuthHeader: string | undefined;
  let responseOverride: { status: number; body: unknown } | null = null;
  let delayMs = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastAuthHeader = req.headers["authorization"] as string | undefined;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (responseOverride) {
          res.writeHead(responseOverride.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseOverride.body));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-abc",
            model: "custom-model-v1",
            choices: [{ message: { content: VALID_OUTPUT_TEXT }, finish_reason: "stop" }],
            usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let restoreEnv: () => void;
  beforeEach(() => {
    responseOverride = null;
    delayMs = 0;
    restoreEnv = allowLoopbackForThisTest();
  });
  afterEach(() => {
    restoreEnv();
  });

  function makeProvider(overrides: Partial<{ baseUrl: string; timeoutMs: number }> = {}) {
    return new OpenAiCompatibleProvider({
      apiKey: "sk-customer-value",
      model: "custom-model-v1",
      baseUrl: overrides.baseUrl ?? `http://127.0.0.1:${port}`,
      timeoutMs: overrides.timeoutMs,
    });
  }

  it("normalizes a successful chat-completions response into content + token usage (Section 9/13)", async () => {
    const provider = makeProvider();
    const result = await provider.analyzeChange(INPUT);
    expect(result.content).toBe(VALID_OUTPUT_TEXT);
    expect(result.inputTokens).toBe(90);
    expect(result.outputTokens).toBe(30);
    expect(result.totalTokens).toBe(120);
    expect(result.finishReason).toBe("stop");
  });

  it("sends the customer's API key via Authorization, never anywhere else", async () => {
    const provider = makeProvider();
    await provider.analyzeChange(INPUT);
    expect(lastAuthHeader).toBe("Bearer sk-customer-value");
  });

  it("accepts a baseUrl with a trailing slash", async () => {
    const provider = makeProvider({ baseUrl: `http://127.0.0.1:${port}/` });
    await expect(provider.analyzeChange(INPUT)).resolves.toBeDefined();
  });

  it("treats a 401 as non-retryable", async () => {
    responseOverride = { status: 401, body: { error: { message: "invalid api key" } } };
    try {
      await makeProvider().analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AiProviderRequestError).retryable).toBe(false);
    }
  });

  it("treats a 429 as retryable", async () => {
    responseOverride = { status: 429, body: { error: { message: "rate limited" } } };
    try {
      await makeProvider().analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AiProviderRequestError).retryable).toBe(true);
    }
  });

  it("treats a 5xx as retryable", async () => {
    responseOverride = { status: 503, body: { error: { message: "upstream unavailable" } } };
    try {
      await makeProvider().analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AiProviderRequestError).retryable).toBe(true);
    }
  });

  it("fails with a non-retryable error when the response has no choices[0].message.content", async () => {
    responseOverride = { status: 200, body: { choices: [] } };
    try {
      await makeProvider().analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderRequestError);
      expect((err as AiProviderRequestError).retryable).toBe(false);
    }
  });

  it("surfaces a timeout as AiProviderTimeoutError", async () => {
    delayMs = 200;
    const provider = makeProvider({ timeoutMs: 10 });
    await expect(provider.analyzeChange(INPUT)).rejects.toBeInstanceOf(AiProviderTimeoutError);
  });
});

describe("OpenAiCompatibleProvider - SSRF protection (Section 20)", () => {
  it("rejects a loopback baseUrl by default, without the dev/test opt-in", async () => {
    const provider = new OpenAiCompatibleProvider({ apiKey: "sk-x", model: "m", baseUrl: "http://127.0.0.1:9" });
    try {
      await provider.analyzeChange(INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderRequestError);
      expect((err as AiProviderRequestError).retryable).toBe(false);
      expect((err as Error).message).toContain("Refusing unsafe endpoint");
    }
  });

  it("rejects a baseUrl that resolves to the cloud metadata address", async () => {
    // 169.254.169.254 is a literal IP - resolveAndValidateHost validates
    // it directly, no DNS resolution needed for this test.
    const provider = new OpenAiCompatibleProvider({ apiKey: "sk-x", model: "m", baseUrl: "http://169.254.169.254" });
    await expect(provider.analyzeChange(INPUT)).rejects.toThrow(/Refusing unsafe endpoint/);
  });

  it("rejects a non-http(s) baseUrl scheme", async () => {
    const provider = new OpenAiCompatibleProvider({ apiKey: "sk-x", model: "m", baseUrl: "file:///etc/passwd" });
    await expect(provider.analyzeChange(INPUT)).rejects.toThrow(/Refusing unsafe endpoint/);
  });
});
