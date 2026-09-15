import { createAiProvider, isAiProviderKind, UnsupportedAiProviderError, type AiConnectionConfig, type AiProvider } from "@cma/ai";
import { getEnabledAiConnectionConfigForOrg, type DecryptedAiConnectionConfig } from "@cma/db";

/**
 * Section 3's configured production default when no per-organization
 * model override exists. Comes from CMA_AI_MODEL when set for the
 * dev/test fallback path (Section 16); an AiConnection's own `model`
 * always takes precedence (Section 15) - this constant is never
 * consulted once an organization has a real connection.
 */
const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

/**
 * Mirrors packages/security/src/resolveHost.ts's
 * privateTargetsAllowedForTesting() convention: an opt-in env flag that
 * is a no-op whenever NODE_ENV=production, so a misconfigured
 * production deployment can never silently fall back to fake AI
 * output. Set CMA_AI_PROVIDER=fake for local development and E2E runs
 * (see DevRunbook.md) so the full queue -> worker -> UI path can be
 * exercised without a real API key or real cost.
 */
export function fakeAiProviderAllowedForTesting(): boolean {
  return process.env["NODE_ENV"] !== "production" && process.env["CMA_AI_PROVIDER"] === "fake";
}

/**
 * Section 16: a bootstrap convenience for local development ONLY - a
 * developer with an OPENAI_API_KEY in their shell/`.env` can test the
 * real OpenAI path without first creating an AiConnection row via the
 * API. Never available in production: a production deployment MUST
 * configure a tenant-specific AiConnection (Section 4's "never a single
 * global production API key assumption").
 */
function envOpenAiBootstrapAllowed(): boolean {
  return process.env["NODE_ENV"] !== "production" && process.env["CMA_AI_PROVIDER"] === "openai";
}

function resolveEnvBootstrapConfig(): AiConnectionConfig | null {
  if (!envOpenAiBootstrapAllowed()) return null;
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  return { provider: "openai", model: process.env["CMA_AI_MODEL"] ?? DEFAULT_OPENAI_MODEL, apiKey };
}

/**
 * The stored `provider` column is a plain string (Section 12: no
 * provider-specific enum baked into the schema), so it must be
 * validated against the registry's known kinds before being handed to
 * `createAiProvider` - this is what would surface a data-integrity
 * problem (a row written with a provider string the current build no
 * longer recognizes) as a clean UnsupportedAiProviderError rather than
 * a type-unsafe cast.
 */
function toAiConnectionConfig(row: DecryptedAiConnectionConfig): AiConnectionConfig {
  if (!isAiProviderKind(row.provider)) {
    throw new UnsupportedAiProviderError(row.provider);
  }
  return { provider: row.provider, model: row.model, baseUrl: row.baseUrl, apiKey: row.apiKey };
}

/** Thrown when no provider could be resolved at all - callers must turn this into a cleanly FAILED AiAnalysis, never a crash. */
export class NoAiProviderConfiguredError extends Error {
  constructor(organizationId: string) {
    super(
      `No AI provider is configured for organization ${organizationId}. Create an AiConnection, or set ` +
        `CMA_AI_PROVIDER=fake/openai for local development (never in production).`,
    );
    this.name = "NoAiProviderConfiguredError";
  }
}

export interface ResolveAiProviderDeps {
  getEnabledAiConnectionConfigForOrg: (organizationId: string) => Promise<DecryptedAiConnectionConfig | null>;
}

export function createDefaultResolveAiProviderDeps(): ResolveAiProviderDeps {
  return { getEnabledAiConnectionConfigForOrg };
}

export interface ResolvedAiProvider {
  provider: AiProvider;
  /** The config actually used to build `provider` - callers persist `config.model` alongside `provider.name` (Section 15/16/17). */
  config: AiConnectionConfig;
}

/**
 * Section 4/17: the runtime flow is ChangeEvent -> organizationId ->
 * AiConnection -> provider -> model -> credential. Precedence is
 * strict and never silently crosses providers:
 *   1. The organization's own enabled AiConnection (production path).
 *   2. The local dev/test fallback (CMA_AI_PROVIDER=fake or
 *      =openai+OPENAI_API_KEY), only outside production.
 *   3. Otherwise, fail cleanly - NoAiProviderConfiguredError, never a
 *      silent substitution of a different provider than the one (if
 *      any) the customer actually configured.
 */
export async function resolveAiProviderForOrg(
  organizationId: string,
  deps: ResolveAiProviderDeps = createDefaultResolveAiProviderDeps(),
): Promise<ResolvedAiProvider> {
  const orgRow = await deps.getEnabledAiConnectionConfigForOrg(organizationId);
  if (orgRow) {
    const config = toAiConnectionConfig(orgRow);
    return { provider: createAiProvider(config), config };
  }

  if (fakeAiProviderAllowedForTesting()) {
    const config: AiConnectionConfig = { provider: "fake", model: "fake" };
    return { provider: createAiProvider(config), config };
  }

  const bootstrapConfig = resolveEnvBootstrapConfig();
  if (bootstrapConfig) return { provider: createAiProvider(bootstrapConfig), config: bootstrapConfig };

  throw new NoAiProviderConfiguredError(organizationId);
}
