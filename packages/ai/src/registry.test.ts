import { describe, expect, it } from "vitest";
import {
  createAiProvider,
  isAiProviderKind,
  isSelectableAiProviderKind,
  AiProviderConfigError,
  UnsupportedAiProviderError,
} from "./registry.js";
import { OpenAiProvider } from "./providers/openaiProvider.js";
import { OpenAiCompatibleProvider } from "./providers/openaiCompatibleProvider.js";

describe("createAiProvider (Section 7: provider factory/registry)", () => {
  it("builds a fake provider for provider='fake'", () => {
    const provider = createAiProvider({ provider: "fake", model: "irrelevant" });
    expect(provider.name).toBe("fake");
  });

  it("builds an OpenAiProvider for provider='openai' with an apiKey", () => {
    const provider = createAiProvider({ provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-test" });
    expect(provider).toBeInstanceOf(OpenAiProvider);
  });

  it("throws AiProviderConfigError for provider='openai' with no apiKey", () => {
    expect(() => createAiProvider({ provider: "openai", model: "gpt-5.6-luna" })).toThrow(AiProviderConfigError);
  });

  it("builds an OpenAiCompatibleProvider for provider='openai-compatible' with an apiKey and baseUrl", () => {
    const provider = createAiProvider({
      provider: "openai-compatible",
      model: "custom-model",
      apiKey: "sk-test",
      baseUrl: "https://provider.example/v1",
    });
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it("throws AiProviderConfigError for provider='openai-compatible' with no baseUrl", () => {
    expect(() => createAiProvider({ provider: "openai-compatible", model: "m", apiKey: "sk-test" })).toThrow(AiProviderConfigError);
  });

  it("throws AiProviderConfigError for provider='openai-compatible' with no apiKey", () => {
    expect(() =>
      createAiProvider({ provider: "openai-compatible", model: "m", baseUrl: "https://provider.example/v1" }),
    ).toThrow(AiProviderConfigError);
  });

  it("throws UnsupportedAiProviderError for an unrecognized provider identifier", () => {
    // @ts-expect-error - deliberately passing an invalid provider kind to test runtime behavior
    expect(() => createAiProvider({ provider: "anthropic", model: "claude" })).toThrow(UnsupportedAiProviderError);
  });
});

describe("isAiProviderKind / isSelectableAiProviderKind", () => {
  it("recognizes all three known kinds as valid provider kinds", () => {
    expect(isAiProviderKind("fake")).toBe(true);
    expect(isAiProviderKind("openai")).toBe(true);
    expect(isAiProviderKind("openai-compatible")).toBe(true);
    expect(isAiProviderKind("anthropic")).toBe(false);
  });

  it("excludes 'fake' from the customer-selectable set (Section 6: never a real tenant configuration)", () => {
    expect(isSelectableAiProviderKind("fake")).toBe(false);
    expect(isSelectableAiProviderKind("openai")).toBe(true);
    expect(isSelectableAiProviderKind("openai-compatible")).toBe(true);
  });
});
