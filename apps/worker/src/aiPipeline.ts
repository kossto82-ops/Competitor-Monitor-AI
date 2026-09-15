import {
  analyzeChangeWithRetry,
  buildChangeAnalysisInput,
  PROMPT_VERSION,
  type AiProvider,
  type ChangeEventForAnalysis,
} from "@cma/ai";
import * as db from "@cma/db";
import type { AiAnalysisJobPayload } from "@cma/queue";
import { createDefaultAiProvider } from "./aiProvider.js";

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
 */
export interface AiAnalysisDeps {
  provider: AiProvider;
  getAiAnalysisForOrg: (organizationId: string, aiAnalysisId: string) => Promise<AiAnalysisRowLike>;
  getChangeEventForOrg: (organizationId: string, changeEventId: string) => Promise<ChangeEventForAnalysis | null>;
  markAiAnalysisRunning: (aiAnalysisId: string) => Promise<unknown>;
  markAiAnalysisCompleted: (aiAnalysisId: string, input: db.CompleteAiAnalysisInput) => Promise<unknown>;
  markAiAnalysisFailed: (aiAnalysisId: string, errorMessage: string) => Promise<unknown>;
}

export function createDefaultAiAnalysisDeps(): AiAnalysisDeps {
  return {
    provider: createDefaultAiProvider(),
    getAiAnalysisForOrg: db.getAiAnalysisForOrg,
    getChangeEventForOrg: db.getChangeEventForOrg,
    markAiAnalysisRunning: db.markAiAnalysisRunning,
    markAiAnalysisCompleted: db.markAiAnalysisCompleted,
    markAiAnalysisFailed: db.markAiAnalysisFailed,
  };
}

/**
 * The Phase 3 pipeline: ChangeEvent -> bounded context -> AI provider
 * -> schema-validated output -> AiAnalysis row. Mirrors pipeline.ts's
 * shape deliberately (fetch -> validate ownership -> RUNNING -> do the
 * work -> terminal state in a try/catch) since it is a job with the
 * same lifecycle concerns, just calling a different backend.
 *
 * Never touches the ChangeEvent or MonitoringJob rows in any way - an
 * AI analysis failure is a completely separate concept from a
 * monitoring failure or FAILED_TO_VERIFY (Section 9), and must never
 * make the underlying deterministic change event unavailable.
 */
export async function runAiAnalysisJob(
  payload: AiAnalysisJobPayload,
  deps: AiAnalysisDeps = createDefaultAiAnalysisDeps(),
): Promise<RunAiAnalysisJobResult> {
  const analysis = await deps.getAiAnalysisForOrg(payload.organizationId, payload.aiAnalysisId);

  /**
   * Section 10/11 (idempotency): a duplicate BullMQ delivery, a worker
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

  // Defense-in-depth (Section 4/5 of the hardening report's spirit):
  // structurally, compareSnapshots never emits a ChangeEvent for a
  // FAILED_TO_VERIFY snapshot, so this branch should be unreachable in
  // production - but a job must never spend a paid call analyzing
  // evidence the system itself does not trust.
  if (changeEvent.currentSnapshot.verificationState === "FAILED_TO_VERIFY") {
    await deps.markAiAnalysisFailed(analysis.id, "Refusing to analyze a change event backed by a FAILED_TO_VERIFY snapshot");
    return { aiAnalysisId: analysis.id, status: "FAILED" };
  }

  const input = buildChangeAnalysisInput(changeEvent);
  if (!input) {
    await deps.markAiAnalysisFailed(analysis.id, `changeType "${changeEvent.changeType}" has no AI analysis context defined`);
    return { aiAnalysisId: analysis.id, status: "FAILED" };
  }

  await deps.markAiAnalysisRunning(analysis.id);

  const startedAt = Date.now();
  try {
    const result = await analyzeChangeWithRetry(deps.provider, input);
    await deps.markAiAnalysisCompleted(analysis.id, {
      provider: result.provider,
      model: result.model,
      summary: result.output.summary,
      facts: result.output.facts,
      interpretations: result.output.interpretations,
      speculation: result.output.speculation,
      confidence: result.output.confidence,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      durationMs: Date.now() - startedAt,
    });
    return { aiAnalysisId: analysis.id, status: "COMPLETED" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.markAiAnalysisFailed(analysis.id, message).catch(() => undefined);
    throw err;
  }
}

export { PROMPT_VERSION };
