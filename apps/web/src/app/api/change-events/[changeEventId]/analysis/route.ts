import { NextResponse } from "next/server";
import {
  getChangeEventForOrg,
  getOrCreatePendingAiAnalysis,
  getAiAnalysisForChangeEvent,
  markAiAnalysisFailed,
  NotFoundError,
} from "@cma/db";
import { createAiAnalysisQueue } from "@cma/queue";
import { isSupportedAiChangeType, PROMPT_VERSION } from "@cma/ai";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ changeEventId: string }>;
}

/**
 * Section 12: the only two AI-analysis endpoints. Neither exposes any
 * provider configuration to the browser - the browser only ever sees
 * an AiAnalysis row's structured output, never a provider credential
 * or a raw prompt. The actual AI call happens in apps/worker (see
 * aiPipeline.ts), never in this process.
 */
export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { changeEventId } = await params;
    // Confirms the ChangeEvent belongs to the caller's org before ever
    // looking at an AiAnalysis row - never trust changeEventId alone.
    const changeEvent = await getChangeEventForOrg(session.organizationId, changeEventId);
    if (!changeEvent) throw new NotFoundError("ChangeEvent");

    const analysis = await getAiAnalysisForChangeEvent(session.organizationId, changeEventId);
    return NextResponse.json({ analysis });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Idempotent trigger (Section 10): if an analysis already exists for
 * this ChangeEvent (in any state, including a prior failure), this
 * returns that row instead of creating a second one and instead of
 * enqueueing a redundant job when one is already PENDING/RUNNING or
 * already COMPLETED. Re-triggering after a FAILED analysis is allowed
 * (its own job attempt already ended in a terminal state) and enqueues
 * a fresh job against the *same* row, since BullMQ's own jobId dedup
 * (the row's own id) plus aiPipeline.ts's "already COMPLETED" check
 * together guarantee this can never double-charge for a completed
 * analysis - only ever re-run a failed one on request.
 */
export async function POST(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { changeEventId } = await params;
    const changeEvent = await getChangeEventForOrg(session.organizationId, changeEventId);
    if (!changeEvent) throw new NotFoundError("ChangeEvent");

    if (!isSupportedAiChangeType(changeEvent.changeType)) {
      return NextResponse.json(
        { error: `AI analysis is not supported for change type "${changeEvent.changeType}" yet.` },
        { status: 422 },
      );
    }

    const analysis = await getOrCreatePendingAiAnalysis(session.organizationId, changeEventId, PROMPT_VERSION);

    if (analysis.status === "COMPLETED" || analysis.status === "RUNNING") {
      return NextResponse.json({ analysis }, { status: 200 });
    }

    const queue = createAiAnalysisQueue();
    try {
      await queue.add(
        "analyze",
        { organizationId: session.organizationId, changeEventId, aiAnalysisId: analysis.id },
        { jobId: analysis.id },
      );
      return NextResponse.json({ analysis }, { status: 202 });
    } catch (enqueueErr) {
      // Same lesson as the monitored-url scan route (Phase 2.1 hardening
      // Bug #1): never leave a PENDING row that nothing will ever pick up.
      const message = enqueueErr instanceof Error ? enqueueErr.message : "Failed to enqueue AI analysis job";
      await markAiAnalysisFailed(analysis.id, message).catch((markErr: unknown) => {
        console.error(`Failed to mark orphaned AiAnalysis ${analysis.id} as FAILED after enqueue error:`, markErr);
      });
      throw enqueueErr;
    } finally {
      await queue.close().catch((closeErr: unknown) => {
        console.error("Failed to close AI analysis queue connection:", closeErr);
      });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
