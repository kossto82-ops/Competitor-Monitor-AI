import { NextResponse } from "next/server";
import { createCapabilityAiRun, getLatestCapabilityAiRun, markCapabilityAiRunFailed } from "@cma/db";
import { addJobReplacingTerminal, createCapabilityAiQueue, type CapabilityAiJobPayload } from "@cma/queue";
import { assertPermission, requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";
import { readLimits } from "@/lib/limits";
import { checkLimit } from "@/lib/limitResponse";

/** The latest AI check of this organization's capabilities, for the Features page to poll while it runs. */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    return NextResponse.json({ run: await getLatestCapabilityAiRun(session.organizationId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Phase 29 F3: starts one on-demand AI check, with the organization's own key. Never automatic: it runs when a
 * person clicks, reads a bounded batch of pages, and a second click while one is running returns that run
 * instead of starting another paid one.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    assertPermission(session, "run_scans_and_ai");

    // Checked before a run row is created: a refused request must not leave a job-less PENDING run.
    const limited = await checkLimit(`ai-capabilities:${session.organizationId}`, readLimits().aiCapabilityChecksPerDay, 86_400, "Daily AI capability check limit reached for your organization. It resets within 24 hours.");
    if (limited) return limited;

    const { run, created } = await createCapabilityAiRun(session.organizationId);
    if (!created) return NextResponse.json({ run }, { status: 200 });

    const queue = createCapabilityAiQueue();
    try {
      const payload: CapabilityAiJobPayload = { organizationId: session.organizationId, capabilityAiRunId: run.id };
      await addJobReplacingTerminal(queue, "classify", payload, run.id);
      return NextResponse.json({ run }, { status: 202 });
    } catch (enqueueErr) {
      const message = enqueueErr instanceof Error ? enqueueErr.message : "Failed to enqueue capability check job";
      await markCapabilityAiRunFailed(run.id, message).catch((markErr: unknown) => console.error(`Failed to mark orphaned CapabilityAiRun ${run.id} as FAILED:`, markErr));
      throw enqueueErr;
    } finally {
      await queue.close().catch((closeErr: unknown) => console.error("Failed to close capability AI queue connection:", closeErr));
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
