import { createFakeAiProvider } from "./providers/fakeProvider.js";
import { OpenAiProvider } from "./providers/openaiProvider.js";
import { OpenAiCompatibleProvider } from "./providers/openaiCompatibleProvider.js";
import type { AiProvider } from "./types.js";

/**
 * The full set of provider kinds the registry knows how to construct.
 * "fake" is a development/test-only kind - never customer-selectable
 * (see SELECTABLE_AI_PROVIDER_KINDS below).
 */
export const AI_PROVIDER_KINDS = ["fake", "openai", "openai-compatible"] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/**
 * Section 6/26: what an organization can actually choose when creating
 * an AiConnection. Deliberately excludes "fake" - that kind exists only
 * for local development and automated tests (see
 * apps/worker/src/resolveAiProvider.ts), never as a real tenant's
 * configuration.
 */
export const SELECTABLE_AI_PROVIDER_KINDS = ["openai", "openai-compatible"] as const;
export type SelectableAiProviderKind = (typeof SELECTABLE_AI_PROVIDER_KINDS)[number];

export function isAiProviderKind(value: string): value is AiProviderKind {
  return (AI_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function isSelectableAiProviderKind(value: string): value is SelectableAiProviderKind {
  return (SELECTABLE_AI_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** Thrown for a `provider` value the registry has no adapter for at all. */
export class UnsupportedAiProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported AI provider "${provider}". Supported: ${AI_PROVIDER_KINDS.join(", ")}.`);
    this.name = "UnsupportedAiProviderError";
  }
}

/** Thrown for a recognized provider kind missing a field it requires (e.g. openai without an apiKey). */
export class AiProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderConfigError";
  }
}

/**
 * Provider-neutral configuration (Section 3): the shape both an
 * organization's `AiConnection` (packages/db) and the local-dev
 * environment-variable fallback (apps/worker) resolve down to before
 * reaching the registry. `apiKey` here is always the DECRYPTED value -
 * this type must never be logged, persisted, or included in a queue
 * payload as-is (Section 5/25).
 */
export interface AiConnectionConfig {
  provider: AiProviderKind;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

/**
 * Section 7: the ONLY place in the codebase that maps a provider
 * identifier to a concrete `AiProvider` implementation. Adding a future
 * provider (e.g. Anthropic) means adding one `case` here plus its own
 * adapter file - never touching the monitoring pipeline, the queue, or
 * any other call site of this function.
 */
export function createAiProvider(config: AiConnectionConfig): AiProvider {
  switch (config.provider) {
    case "fake":
      return createFakeAiProvider();

    case "openai": {
      if (!config.apiKey) {
        throw new AiProviderConfigError("An 'openai' AI connection requires an apiKey.");
      }
      return new OpenAiProvider({ apiKey: config.apiKey, model: config.model });
    }

    case "openai-compatible": {
      if (!config.apiKey) {
        throw new AiProviderConfigError("An 'openai-compatible' AI connection requires an apiKey.");
      }
      if (!config.baseUrl) {
        throw new AiProviderConfigError("An 'openai-compatible' AI connection requires a baseUrl.");
      }
      return new OpenAiCompatibleProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });
    }

    default: {
      // Exhaustiveness guard: if AI_PROVIDER_KINDS ever grows without a
      // matching case above, this is a compile error, not a runtime surprise.
      const exhaustiveCheck: never = config.provider;
      throw new UnsupportedAiProviderError(exhaustiveCheck as string);
    }
  }
}
