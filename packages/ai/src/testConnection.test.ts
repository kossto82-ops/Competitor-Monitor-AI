import { describe, expect, it } from "vitest";
import { runConnectionTest, testAiConnection } from "./testConnection.js";
import { OpenAiProvider } from "./providers/openaiProvider.js";
import type { AiConnectionConfig } from "./registry.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("testAiConnection", () => {
  it("returns SUCCESS for the fake provider (development/test only)", async () => {
    const config: AiConnectionConfig = { provider: "fake", model: "fake" };
    const result = await testAiConnection(config);
    expect(result).toEqual({ status: "SUCCESS", message: "Connection successful." });
  });

  it("classifies a 401 (invalid API key) as INVALID_CREDENTIALS, without leaking the vendor's raw message", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-wrong",
      model: "gpt-4o-mini",
      fetchImpl: async () => jsonResponse(401, { error: { message: "Incorrect API key provided: sk-wrong." } }),
    });
    const result = await runConnectionTest(provider);
    expect(result.status).toBe("INVALID_CREDENTIALS");
    expect(result.message).not.toContain("sk-wrong");
  });

  it("classifies a 400 'model does not exist' as MODEL_UNAVAILABLE", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-x",
      model: "not-a-real-model",
      fetchImpl: async () => jsonResponse(400, { error: { message: "The model `not-a-real-model` does not exist." } }),
    });
    const result = await runConnectionTest(provider);
    expect(result.status).toBe("MODEL_UNAVAILABLE");
  });

  it("classifies a 500 as PROVIDER_UNAVAILABLE", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-x",
      model: "gpt-4o-mini",
      fetchImpl: async () => jsonResponse(500, { error: { message: "internal server error" } }),
    });
    const result = await runConnectionTest(provider);
    expect(result.status).toBe("PROVIDER_UNAVAILABLE");
  });

  it("classifies a timeout as PROVIDER_UNAVAILABLE", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-x",
      model: "gpt-4o-mini",
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
    const result = await runConnectionTest(provider);
    expect(result.status).toBe("PROVIDER_UNAVAILABLE");
  });

  it("SUCCESS when the provider responds with a well-formed 200, regardless of whether the content parses as valid analysis JSON", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-x",
      model: "gpt-4o-mini",
      fetchImpl: async () =>
        jsonResponse(200, { id: "resp_1", model: "gpt-4o-mini", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: "not valid analysis json" }] }] }),
    });
    const result = await runConnectionTest(provider);
    expect(result.status).toBe("SUCCESS");
  });

  it("returns INVALID_CONFIGURATION for a recognized provider missing a required field (e.g. openai-compatible without baseUrl)", async () => {
    const config: AiConnectionConfig = { provider: "openai-compatible", model: "custom", apiKey: "sk-x" };
    const result = await testAiConnection(config);
    expect(result.status).toBe("INVALID_CONFIGURATION");
  });

  it("returns INVALID_CONFIGURATION for an unrecognized provider string rather than throwing", async () => {
    const result = await testAiConnection({ provider: "not-a-real-provider" as never, model: "x" });
    expect(result.status).toBe("INVALID_CONFIGURATION");
  });

  it("never includes the API key anywhere in the result, for any outcome", async () => {
    const secretKey = "sk-super-secret-value-123";
    const provider = new OpenAiProvider({
      apiKey: secretKey,
      model: "gpt-4o-mini",
      fetchImpl: async () => jsonResponse(401, { error: { message: `Bad key: ${secretKey}` } }),
    });
    const result = await runConnectionTest(provider);
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });
});
