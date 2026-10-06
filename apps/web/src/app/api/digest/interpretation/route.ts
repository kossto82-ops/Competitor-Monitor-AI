import { NextResponse } from "next/server";
import { getDigestAiInterpretationForOrg, getOrCreateDigestAiInterpretationSlot, markDigestAiInterpretationFailed } from "@cma/db";
import { addJobReplacingTerminal, createDigestInterpretationQueue, type DigestInterpretationJobPayload } from "@cma/queue";
import { DIGEST_PROMPT_VERSION } from "@cma/ai";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";
import { readLimits } from "@/lib/limits";
import { checkLimit } from "@/lib/limitResponse";

/** Same period selector convention as /digest, /dashboard, /compare - see intelligence.ts's getDigestForOrganization. */
const VALID_PERIOD_DAYS = [7, 30, 90] as const;

function parseDays(value: string | null): number | null {
  const parsed = Number(value);
  return VALID_PERIOD_DAYS.includes(parsed as (typeof VALID_PERIOD_DAYS)[number]) ? parsed : null;
}

/**
 * Phase 11 (Tier 4 - Evidence-Grounded AI Interpretation): the only two
 * endpoints for the Digest's optional AI interpretation layer. Mirrors
 * apps/web/src/app/api/change-events/[changeEventId]/analysis/route.ts's
 * shape exactly - the browser only ever sees a DigestAiInterpretation
 * row's structured, already-evidence-validated output, never a provider
 * credential or a raw prompt/evidence bundle. The actual AI call happens
 * in apps/worker (see digestInterpretationPipeline.ts), never here.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const days = parseDays(new URL(request.url).searchParams.get("days"));
    if (days === null) {
      return NextResponse.json({ error: "days must be one of 7, 30, 90" }, { status: 400 });
    }

    const interpretation = await getDigestAiInterpretationForOrg(session.organizationId, days);
    return NextResponse.json({ interpretation });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Idempotent trigger, adapted for the Digest's moving-window target
 * (see digestAiInterpretation.ts's doc comment on
 * getOrCreateDigestAiInterpretationSlot for the full rationale): a
 * PENDING/RUNNING slot is returned as-is without enqueueing a second job
 * (never a duplicate in-flight interpretation); a COMPLETED or FAILED
 * slot is reset to PENDING and a fresh job is enqueued - this endpoint
 * is the Digest's explicit "Interpret"/"Refresh" user action, never an
 * automatic background trigger, so at most ONE provider call happens per
 * POST (Section 18 of the brief).
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const days = parseDays(new URL(request.url).searchParams.get("days"));
    if (days === null) {
      return NextResponse.json({ error: "days must be one of 7, 30, 90" }, { status: 400 });
    }

    // Checked BEFORE the slot is reset to PENDING: a refused request must not leave a job-less PENDING row.
    const limited = await checkLimit(`ai-digest:${session.organizationId}`, readLimits().aiDigestsPerDay, 86_400, "Daily AI digest limit reached for your organization. It resets within 24 hours.");
    if (limited) return limited;

    const slot = await getOrCreateDigestAiInterpretationSlot(session.organizationId, days, DIGEST_PROMPT_VERSION);

    if (slot.status === "RUNNING") {
      // Already in flight - never enqueue a second job for the same slot.
      return NextResponse.json({ interpretation: slot }, { status: 200 });
    }

    // slot.status is PENDING here (either freshly created, or freshly
    // reset from a prior COMPLETED/FAILED terminal state above) -
    // exactly one job is enqueued per POST.
    const queue = createDigestInterpretationQueue();
    try {
      const payload: DigestInterpretationJobPayload = { organizationId: session.organizationId, days, digestAiInterpretationId: slot.id };
      // The previous run's completed/failed job still holds this id in
      // BullMQ; a plain queue.add would drop the Refresh silently.
      await addJobReplacingTerminal(queue, "interpret", payload, slot.id);
      return NextResponse.json({ interpretation: slot }, { status: 202 });
    } catch (enqueueErr) {
      // Same lesson as the ChangeEvent analysis route (Phase 2.1
      // hardening Bug #1, reapplied here): never leave a PENDING row
      // that nothing will ever pick up.
      const message = enqueueErr instanceof Error ? enqueueErr.message : "Failed to enqueue digest interpretation job";
      await markDigestAiInterpretationFailed(slot.id, message).catch((markErr: unknown) => {
        console.error(`Failed to mark orphaned DigestAiInterpretation ${slot.id} as FAILED after enqueue error:`, markErr);
      });
      throw enqueueErr;
    } finally {
      await queue.close().catch((closeErr: unknown) => {
        console.error("Failed to close digest interpretation queue connection:", closeErr);
      });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
