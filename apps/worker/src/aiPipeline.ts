import { analyzeAndValidateChange, buildChangeAnalysisInput, calculateCostUsd, PROMPT_VERSION, type ChangeEventForAnalysis } from "@cma/ai";
import * as db from "@cma/db";
import type { AiAnalysisJobPayload } from "@cma/queue";
import { resolveAiProviderForOrg, type ResolvedAiProvider } from "./resolveAiProvider.js";

export interface RunAiAnalysisJobResult {
  aiAnalysisId: string;
  status: "COMPLETED" | "FAILED" | "SKIPPED";
}

interface AiAnalysisRowLike {
  id: string;
  status: string;
}

/**
 * Injectable collaborators, same rationale as pipeline.ts's
 * PipelineDeps: `runAiAnalysisJob` is unit tested with a fake @cma/ai
 * provider and fake db functions, never against a live Postgres or a
 * real model. Production code only ever uses createDefaultAiAnalysisDeps.
 *
 * `resolveProvider` takes the organizationId (never trusts a provider
 * pre-selected some other way) - Section 4's "ChangeEvent ->
 * organizationId -> AiConnection -> provider" flow, resolved once per
 * job rather than once per worker process, so two organizations with
 * different configured providers are served correctly by the same
 * worker.
 */
export interface AiAnalysisDeps {
  resolveProvider: (organizationId: string) => Promise<ResolvedAiProvider>;
  getAiAnalysisForOrg: (organizationId: string, aiAnalysisId: string) => Promise<AiAnalysisRowLike>;
  getChangeEventForOrg: (organizationId: string, changeEventId: string) => Promise<ChangeEventForAnalysis | null>;
  markAiAnalysisRunning: (aiAnalysisId: string) => Promise<unknown>;
  markAiAnalysisCompleted: (aiAnalysisId: string, input: db.CompleteAiAnalysisInput) => Promise<unknown>;
  markAiAnalysisFailed: (aiAnalysisId: string, errorMessage: string) => Promise<unknown>;
}

export function createDefaultAiAnalysisDeps(): AiAnalysisDeps {
  return {
    resolveProvider: resolveAiProviderForOrg,
    getAiAnalysisForOrg: db.getAiAnalysisForOrg,
    getChangeEventForOrg: db.getChangeEventForOrg,
    markAiAnalysisRunning: db.markAiAnalysisRunning,
    markAiAnalysisCompleted: db.markAiAnalysisCompleted,
    markAiAnalysisFailed: db.markAiAnalysisFailed,
  };
}

/**
 * The AI analysis pipeline: ChangeEvent -> resolve the organization's
 * AiConnection -> bounded context -> AiProvider -> schema-validated
 * output -> AiAnalysis row. Mirrors pipeline.ts's shape deliberately
 * (fetch -> validate ownership -> RUNNING -> do the work -> terminal
 * state in a try/catch) since it is a job with the same lifecycle
 * concerns, just calling a different backend - and that backend is
 * resolved per-organization, per Phase 3.1's multi-tenant requirement,
 * never fixed for the whole worker process.
 *
 * Never touches the ChangeEvent or MonitoringJob rows in any way - an
 * AI analysis failure (including "no provider configured for this
 * organization") is a completely separate concept from a monitoring
 * failure or FAILED_TO_VERIFY, and must never make the underlying
 * deterministic change event unavailable (Section 13/18).
 */
export async function runAiAnalysisJob(
  payload: AiAnalysisJobPayload,
  deps: AiAnalysisDeps = createDefaultAiAnalysisDeps(),
): Promise<RunAiAnalysisJobResult> {
  const analysis = await deps.getAiAnalysisForOrg(payload.organizationId, payload.aiAnalysisId);

  /**
   * Idempotency (Section 11): a duplicate BullMQ delivery, a worker
   * retry, or two near-simultaneous trigger requests that both got as
   * far as enqueueing must never result in a second paid provider
   * call for a ChangeEvent that already has a completed analysis. The
   * `changeEventId @unique` constraint stops a second *row* from ever
   * being created, but only this check stops a second *AI call* against
   * the same row.
   */
  if (analysis.status === "COMPLETED") {
    return { aiAnalysisId: analysis.id, status: "COMPLETED" };
  }

  const changeEvent = await deps.getChangeEventForOrg(payload.organizationId, payload.changeEventId);
  if (!changeEvent) {
    await deps.markAiAnalysisFailed(analysis.id, "ChangeEvent not found for this organization");
    return { aiAnalysisId: analysis.id, status: "FAILED" };
  }

  // Defense-in-depth: structurally, compareSnapshots never emits a
  // ChangeEvent for a FAILED_TO_VERIFY snapshot, so this branch should
  // be unreachable in production - but a job must never spend a paid
  // call analyzing evidence the system itself does not trust.
  if (changeEvent.currentSnapshot.verificationState === "FAILED_TO_VERIFY") {
    await deps.markAiAnalysisFailed(analysis.id, "Refusing to analyze a change event backed by a FAILED_TO_VERIFY snapshot");
    return { aiAnalysisId: analysis.id, status: "FAILED" };
  }

  const input = buildChangeAnalysisInput(changeEvent);
  if (!input) {
    await deps.markAiAnalysisFailed(analysis.id, `changeType "${changeEvent.changeType}" has no AI analysis context defined`);
    return { aiAnalysisId: analysis.id, status: "FAILED" };
  }

  // Section 4/18: resolved from THIS ChangeEvent's own organizationId,
  // never from a provider chosen by any other means - if resolution
  // fails (no AiConnection and no dev fallback), the analysis fails
  // cleanly below without ever having called any provider.
  let resolved: ResolvedAiProvider;
  try {
    resolved = await deps.resolveProvider(payload.organizationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.markAiAnalysisFailed(analysis.id, message).catch(() => undefined);
    throw err;
  }

  await deps.markAiAnalysisRunning(analysis.id);

  const startedAt = Date.now();
  try {
    const { output, raw } = await analyzeAndValidateChange(resolved.provider, input);
    await deps.markAiAnalysisCompleted(analysis.id, {
      // config.provider (not provider.name) is the persisted source of
      // truth for which provider was selected - in production the two
      // always agree (createAiProvider builds the adapter FROM this
      // config), but config.provider is the one tied to pricing lookups
      // and to what the organization actually configured.
      provider: resolved.config.provider,
      model: resolved.config.model,
      summary: output.summary,
      facts: output.facts,
      interpretations: output.interpretations,
      speculation: output.speculation,
      confidence: output.confidence,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      // Section 14: computed once, centrally (packages/ai/src/pricing.ts),
      // never by a provider itself - null (never fabricated) when the
      // configured provider/model has no known published price, which
      // is the expected state for this project's default CMA_AI_MODEL
      // and for every openai-compatible connection.
      costUsd: calculateCostUsd(resolved.config.provider, resolved.config.model, raw.inputTokens, raw.outputTokens) ?? undefined,
      durationMs: Date.now() - startedAt,
      providerMetadata: isPlainObject(raw.providerMetadata) ? raw.providerMetadata : undefined,
    });
    return { aiAnalysisId: analysis.id, status: "COMPLETED" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.markAiAnalysisFailed(analysis.id, message).catch(() => undefined);
    throw err;
  }
}

/** Guards providerMetadata (Section 12): only a plain serializable object is ever persisted, never an Error, a Buffer, or similar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { PROMPT_VERSION };
