import { AiProviderRequestError, calculateCostUsd, classifyPageCapabilities } from "@cma/ai";
import * as db from "@cma/db";
import type { CapabilityAiJobPayload } from "@cma/queue";
import { resolveAiProviderForOrg, type ResolvedAiProvider } from "./resolveAiProvider.js";

export interface RunCapabilityAiJobResult {
  capabilityAiRunId: string;
  status: "COMPLETED" | "FAILED";
}

type RunRow = { id: string; status: string };

/** Injectable collaborators, same rationale as aiPipeline.ts: tested with a fake provider and fake db functions, never a live model. */
export interface CapabilityAiDeps {
  resolveProvider: (organizationId: string) => Promise<ResolvedAiProvider>;
  getRun: (organizationId: string, id: string) => Promise<RunRow>;
  markRunning: (id: string) => Promise<unknown>;
  markFailed: (id: string, message: string) => Promise<unknown>;
  markCompleted: (id: string, input: db.CompleteCapabilityAiRunInput) => Promise<unknown>;
  selectPages: (organizationId: string) => Promise<{ pages: db.CapabilityAiPage[]; remaining: number }>;
  recordFindings: typeof db.recordAiCapabilityFindings;
}

export function createDefaultCapabilityAiDeps(): CapabilityAiDeps {
  return {
    resolveProvider: resolveAiProviderForOrg,
    getRun: db.getCapabilityAiRunForOrgOrThrow,
    markRunning: db.markCapabilityAiRunRunning,
    markFailed: db.markCapabilityAiRunFailed,
    markCompleted: db.markCapabilityAiRunCompleted,
    selectPages: (organizationId) => db.selectPagesForCapabilityAi(organizationId),
    recordFindings: db.recordAiCapabilityFindings,
  };
}

/**
 * Phase 29 F3: reads a bounded batch of the organization's competitor pages with its own AI key, asking only about
 * the capabilities the deterministic rules did not find. One call per page (one retry on a transient failure).
 * A page whose call fails is left unmarked, so the next run reads it again; a key that is refused ends the run
 * after the first page instead of failing ten times. Findings are inferences: they carry a quote checked against
 * the page and never create change events.
 */
export async function runCapabilityAiJob(payload: CapabilityAiJobPayload, deps: CapabilityAiDeps = createDefaultCapabilityAiDeps()): Promise<RunCapabilityAiJobResult> {
  const row = await deps.getRun(payload.organizationId, payload.capabilityAiRunId);
  if (row.status === "COMPLETED" || row.status === "FAILED") return { capabilityAiRunId: row.id, status: row.status };

  let resolved: ResolvedAiProvider;
  try {
    resolved = await deps.resolveProvider(payload.organizationId);
  } catch (err) {
    await deps.markFailed(row.id, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    return { capabilityAiRunId: row.id, status: "FAILED" };
  }

  await deps.markRunning(row.id);
  const totals = { pagesChecked: 0, findings: 0, rejectedCount: 0, failedPages: 0, inputTokens: 0, outputTokens: 0 };
  try {
    const { pages, remaining } = await deps.selectPages(payload.organizationId);
    for (const [index, page] of pages.entries()) {
      try {
        const { result, raw } = await classifyPageCapabilities(resolved.provider, { sourceUrl: page.url, pageText: page.text, candidates: page.candidates });
        const { stored } = await deps.recordFindings({ organizationId: payload.organizationId, page, accepted: result.accepted });
        totals.pagesChecked += 1;
        totals.findings += stored;
        totals.rejectedCount += result.rejected.length;
        totals.inputTokens += raw.inputTokens ?? 0;
        totals.outputTokens += raw.outputTokens ?? 0;
      } catch (err) {
        totals.failedPages += 1;
        // A refused key, an unsafe endpoint: the same on every page, so stop instead of paying for ten failures.
        if (index === 0 && err instanceof AiProviderRequestError && !err.retryable) throw err;
      }
    }
    await deps.markCompleted(row.id, {
      provider: resolved.config.provider,
      model: resolved.config.model,
      ...totals,
      pagesRemaining: remaining,
      costUsd: calculateCostUsd(resolved.config.provider, resolved.config.model, totals.inputTokens, totals.outputTokens) ?? undefined,
    });
    return { capabilityAiRunId: row.id, status: "COMPLETED" };
  } catch (err) {
    await deps.markFailed(row.id, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    return { capabilityAiRunId: row.id, status: "FAILED" };
  }
}
