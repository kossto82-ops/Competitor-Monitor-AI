import {
  analyzeAndValidateDigest,
  buildDigestInterpretationInput,
  calculateCostUsd,
  DIGEST_PROMPT_VERSION,
  type DigestForInterpretation,
} from "@cma/ai";
import * as db from "@cma/db";
import type { DigestInterpretationJobPayload } from "@cma/queue";
import { resolveAiProviderForOrg, type ResolvedAiProvider } from "./resolveAiProvider.js";

export interface RunDigestInterpretationJobResult {
  digestAiInterpretationId: string;
  status: "COMPLETED" | "FAILED" | "SKIPPED";
}

interface DigestAiInterpretationRowLike {
  id: string;
  status: string;
}

/**
 * Injectable collaborators - same rationale as aiPipeline.ts's
 * AiAnalysisDeps: unit tested with a fake @cma/ai provider and fake db
 * functions, never against a live Postgres or a real model. Production
 * code only ever uses createDefaultDigestInterpretationDeps.
 */
export interface DigestInterpretationDeps {
  resolveProvider: (organizationId: string) => Promise<ResolvedAiProvider>;
  getDigestAiInterpretationForOrgOrThrow: (organizationId: string, id: string) => Promise<DigestAiInterpretationRowLike>;
  getOrganizationById: (organizationId: string) => Promise<{ timezone: string } | null>;
  getDigestForOrganization: (organizationId: string, days: number, timezone: string | null | undefined) => Promise<DigestForInterpretation>;
  markDigestAiInterpretationRunning: (id: string) => Promise<unknown>;
  markDigestAiInterpretationCompleted: (id: string, input: db.CompleteDigestAiInterpretationInput) => Promise<unknown>;
  markDigestAiInterpretationFailed: (id: string, errorMessage: string) => Promise<unknown>;
}

export function createDefaultDigestInterpretationDeps(): DigestInterpretationDeps {
  return {
    resolveProvider: resolveAiProviderForOrg,
    getDigestAiInterpretationForOrgOrThrow: db.getDigestAiInterpretationForOrgOrThrow,
    getOrganizationById: db.getOrganizationById,
    getDigestForOrganization: db.getDigestForOrganization,
    markDigestAiInterpretationRunning: db.markDigestAiInterpretationRunning,
    markDigestAiInterpretationCompleted: db.markDigestAiInterpretationCompleted,
    markDigestAiInterpretationFailed: db.markDigestAiInterpretationFailed,
  };
}

/**
 * Phase 11's equivalent of aiPipeline.ts's runAiAnalysisJob, for the
 * Digest interpretation path: DigestAiInterpretation row -> resolve the
 * organization's AiConnection -> recompute the CURRENT deterministic
 * Digest (Phase 10's getDigestForOrganization, unmodified) -> build a
 * bounded EvidenceBundle -> AiProvider -> schema-and-evidence-validated
 * output -> persisted row.
 *
 * Deliberately recomputes the Digest fresh (via getDigestForOrganization
 * with `now = new Date()` at job-run time) rather than trying to thread
 * the exact window the UI showed when the user clicked "Interpret" -
 * Phase 10's window is a rolling [now-days, now) range, so a few
 * seconds/minutes of queueing delay between "user clicked" and "job
 * runs" is immaterial; the row's own windowStart/windowEnd fields are
 * set from THIS actually-used window at completion time (see
 * digestAiInterpretation.ts), so the UI can always show which period the
 * interpretation actually covers, never a stale claim about the window
 * originally requested.
 *
 * NEVER touches ChangeEvent, ActivityPattern, RepeatedPriceChangePattern,
 * or the cross-competitor context in any way - a Digest interpretation
 * failure (including "no provider configured") is a completely separate
 * concept from the deterministic Digest itself remaining fully available
 * (Section 20/23 of the brief).
 */
export async function runDigestInterpretationJob(
  payload: DigestInterpretationJobPayload,
  deps: DigestInterpretationDeps = createDefaultDigestInterpretationDeps(),
): Promise<RunDigestInterpretationJobResult> {
  const row = await deps.getDigestAiInterpretationForOrgOrThrow(payload.organizationId, payload.digestAiInterpretationId);

  // Idempotency: a duplicate BullMQ delivery, or a worker retry, must
  // never spend a second paid AI call against an already-COMPLETED row.
  if (row.status === "COMPLETED") {
    return { digestAiInterpretationId: row.id, status: "COMPLETED" };
  }

  let resolved: ResolvedAiProvider;
  try {
    resolved = await deps.resolveProvider(payload.organizationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.markDigestAiInterpretationFailed(row.id, message).catch(() => undefined);
    throw err;
  }

  await deps.markDigestAiInterpretationRunning(row.id);

  const startedAt = Date.now();
  try {
    const organization = await deps.getOrganizationById(payload.organizationId);
    const digest = await deps.getDigestForOrganization(payload.organizationId, payload.days, organization?.timezone);
    const bundle = buildDigestInterpretationInput(digest);

    // Section 18 (cost control): a bundle with nothing to interpret
    // never spends a paid provider call at all - deterministically
    // completed with the brief's own "insufficient evidence" shape
    // (Section 8) instead. This is NOT an AI-generated statement; it is
    // this pipeline's own short-circuit, documented here rather than
    // silently hidden inside @cma/ai.
    if (bundle.competitors.length === 0) {
      const completed = await deps.markDigestAiInterpretationCompleted(row.id, {
        provider: "none",
        model: "none",
        windowStart: digest.windowStart instanceof Date ? digest.windowStart : new Date(digest.windowStart),
        windowEnd: digest.windowEnd instanceof Date ? digest.windowEnd : new Date(digest.windowEnd),
        summary: "There is not enough verified activity in this period to interpret.",
        observations: [],
        interpretations: [],
        hypotheses: [],
        durationMs: Date.now() - startedAt,
      });
      return { digestAiInterpretationId: (completed as DigestAiInterpretationRowLike).id, status: "COMPLETED" };
    }

    const { output, raw } = await analyzeAndValidateDigest(resolved.provider, bundle);
    await deps.markDigestAiInterpretationCompleted(row.id, {
      provider: resolved.config.provider,
      model: resolved.config.model,
      windowStart: digest.windowStart instanceof Date ? digest.windowStart : new Date(digest.windowStart),
      windowEnd: digest.windowEnd instanceof Date ? digest.windowEnd : new Date(digest.windowEnd),
      summary: output.summary,
      observations: output.observations,
      interpretations: output.interpretations,
      hypotheses: output.hypotheses,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      costUsd: calculateCostUsd(resolved.config.provider, resolved.config.model, raw.inputTokens, raw.outputTokens) ?? undefined,
      durationMs: Date.now() - startedAt,
      providerMetadata: isPlainObject(raw.providerMetadata) ? raw.providerMetadata : undefined,
    });
    return { digestAiInterpretationId: row.id, status: "COMPLETED" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.markDigestAiInterpretationFailed(row.id, message).catch(() => undefined);
    return { digestAiInterpretationId: row.id, status: "FAILED" };
  }
}

/** Guards providerMetadata (Section 12/25): only a plain serializable object is ever persisted, never an Error, a Buffer, or similar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { DIGEST_PROMPT_VERSION };
