import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "@cma/ai";
import { resolveAiProviderForOrg, NoAiProviderConfiguredError, type ResolveAiProviderDeps } from "./resolveAiProvider.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("resolveAiProviderForOrg (Section 4/17: precedence, never silently crosses providers)", () => {
  beforeEach(() => {
    resetEnv();
    process.env["NODE_ENV"] = "development";
  });
  afterEach(resetEnv);

  it("uses the organization's own enabled AiConnection when one exists (precedence 1)", async () => {
    const deps: ResolveAiProviderDeps = {
      getEnabledAiConnectionConfigForOrg: vi.fn().mockResolvedValue({ provider: "openai", model: "gpt-5.6-luna", baseUrl: null, apiKey: "sk-org" }),
    };
    // Even though CMA_AI_PROVIDER=fake is set, the org's own connection wins.
    process.env["CMA_AI_PROVIDER"] = "fake";

    const { provider, config } = await resolveAiProviderForOrg("org-1", deps);
    expect(provider).toBeInstanceOf(OpenAiProvider);
    expect(config).toEqual({ provider: "openai", model: "gpt-5.6-luna", baseUrl: null, apiKey: "sk-org" });
  });

  it("falls back to the fake provider only when no AiConnection exists and CMA_AI_PROVIDER=fake (dev/test fallback, precedence 2)", async () => {
    const deps: ResolveAiProviderDeps = { getEnabledAiConnectionConfigForOrg: vi.fn().mockResolvedValue(null) };
    process.env["CMA_AI_PROVIDER"] = "fake";

    const { provider } = await resolveAiProviderForOrg("org-1", deps);
    expect(provider.name).toBe("fake");
  });

  it("never falls back to fake in production, even with CMA_AI_PROVIDER=fake set", async () => {
    const deps: ResolveAiProviderDeps = { getEnabledAiConnectionConfigForOrg: vi.fn().mockResolvedValue(null) };
    process.env["NODE_ENV"] = "production";
    process.env["CMA_AI_PROVIDER"] = "fake";

    await expect(resolveAiProviderForOrg("org-1", deps)).rejects.toBeInstanceOf(NoAiProviderConfiguredError);
  });

  it("falls back to the env-configured OpenAI bootstrap only outside production, when no AiConnection exists", async () => {
    const deps: ResolveAiProviderDeps = { getEnabledAiConnectionConfigForOrg: vi.fn().mockResolvedValue(null) };
    process.env["CMA_AI_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-dev-bootstrap";

    const { provider, config } = await resolveAiProviderForOrg("org-1", deps);
    expect(provider).toBeInstanceOf(OpenAiProvider);
    expect(config.model).toBe("gpt-5.6-luna");
  });

  it("never uses the env bootstrap in production", async () => {
    const deps: ResolveAiProviderDeps = { getEnabledAiConnectionConfigForOrg: vi.fn().mockResolvedValue(null) };
    process.env["NODE_ENV"] = "production";
    process.env["CMA_AI_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-should-be-ignored";

    await expect(resolveAiProviderForOrg("org-1", deps)).rejects.toBeInstanceOf(NoAiProviderConfiguredError);
  });

  it("fails cleanly with NoAiProviderConfiguredError when nothing is configured at all (precedence 3)", async () => {
    const deps: ResolveAiProviderDeps = { getEnabledAiConnectionConfigForOrg: vi.fn().mockResolvedValue(null) };
    await expect(resolveAiProviderForOrg("org-1", deps)).rejects.toBeInstanceOf(NoAiProviderConfiguredError);
  });

  it("never silently substitutes a different provider than the one the organization configured (e.g. an unrecognized provider string is a hard failure, not a fallback)", async () => {
    const deps: ResolveAiProviderDeps = {
      getEnabledAiConnectionConfigForOrg: vi.fn().mockResolvedValue({ provider: "anthropic", model: "claude", baseUrl: null, apiKey: "sk-x" }),
    };
    process.env["CMA_AI_PROVIDER"] = "fake"; // must NOT be used as a fallback
    await expect(resolveAiProviderForOrg("org-1", deps)).rejects.toThrow(/Unsupported AI provider/);
  });

  it("two organizations with different configured providers each get their own, independent of the other (multi-tenant isolation)", async () => {
    const deps: ResolveAiProviderDeps = {
      getEnabledAiConnectionConfigForOrg: vi.fn(async (organizationId: string) => {
        if (organizationId === "org-a") return { provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: "sk-a" };
        if (organizationId === "org-b") return { provider: "openai-compatible", model: "custom", baseUrl: "https://provider-b.example/v1", apiKey: "sk-b" };
        return null;
      }),
    };

    const resolvedA = await resolveAiProviderForOrg("org-a", deps);
    const resolvedB = await resolveAiProviderForOrg("org-b", deps);

    expect(resolvedA.config.provider).toBe("openai");
    expect(resolvedB.config.provider).toBe("openai-compatible");
    expect(resolvedA.provider).not.toBe(resolvedB.provider);
  });
});
