import { AnthropicProvider, createFakeAiProvider, type AiProvider } from "@cma/ai";

/**
 * Mirrors packages/security/src/resolveHost.ts's
 * privateTargetsAllowedForTesting() convention: an opt-in env flag that
 * is a no-op whenever NODE_ENV=production, so a misconfigured
 * production deployment can never silently fall back to fake AI
 * output. Set CMA_AI_PROVIDER=fake for local development and E2E runs
 * (see DevRunbook.md) so the full queue -> worker -> UI path can be
 * exercised without a real API key or real cost - exactly why
 * CMA_ALLOW_PRIVATE_TARGETS exists for the fixture server.
 */
export function fakeAiProviderAllowedForTesting(): boolean {
  return process.env["NODE_ENV"] !== "production" && process.env["CMA_AI_PROVIDER"] === "fake";
}

/**
 * Section 6 (provider abstraction): the one place production code
 * decides which AiProvider implementation to use. Deliberately lazy -
 * constructing this only happens when a job actually needs it (inside
 * createDefaultAiAnalysisDeps, called once at worker startup), so a
 * missing ANTHROPIC_API_KEY fails loudly the moment the worker tries to
 * do real AI work, not silently at import time for processes that
 * never touch this queue.
 */
export function createDefaultAiProvider(): AiProvider {
  if (fakeAiProviderAllowedForTesting()) {
    return createFakeAiProvider();
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Set it to use the real Anthropic provider, or set " +
        "CMA_AI_PROVIDER=fake for local development/testing (never in production).",
    );
  }
  return new AnthropicProvider({ apiKey, model: process.env["CMA_AI_MODEL"] });
}
