import { NextResponse } from "next/server";
import { getMonitoredUrlForOrg, createPendingMonitoringJob, markMonitoringJobFailed } from "@cma/db";
import { createMonitoringQueue } from "@cma/queue";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ urlId: string }>;
}

/**
 * Phase 1's "manual scan trigger" (MVP scope: "Basic/manual
 * scheduling"). Confirms the URL belongs to the caller's organization
 * before enqueuing anything - a tenant can only ever trigger scans for
 * its own MonitoredUrl rows.
 *
 * Phase 2 addition: creates the MonitoringJob row as PENDING *before*
 * enqueueing, and returns its id as `monitoringJobId`. The dashboard
 * polls GET /api/monitoring-jobs/{monitoringJobId} for this exact row
 * to drive Queued -> Scanning -> Completed/Failed - without a row that
 * exists from the moment of the click, there'd be nothing stable to
 * poll while the job still sits in the queue.
 *
 * The BullMQ jobId is the pendingJob's own id, NOT the time-bucketed
 * `monitoringJobId()` helper used by enqueueAll.ts's cron-style path.
 * That helper intentionally de-dupes near-simultaneous enqueues of the
 * same URL within a 60s bucket, which is correct for the "enqueue every
 * active URL" sweep - but here every click already produces a genuinely
 * new PENDING row, so bucketed dedup would make BullMQ silently return
 * the *previous* (already-completed) job for any re-scan within the
 * same bucket, leaving the freshly created row stuck in PENDING forever
 * with nothing ever updating it. Using the row's own id keeps every
 * manual "scan now" click a real, independent job.
 *
 * Phase 2.1 addition: `queue.add()` runs *after* the PENDING row already
 * exists in Postgres. If it throws (Redis unreachable, connection reset,
 * etc.) the row would otherwise be a permanent orphan - nothing will ever
 * pick it up, so it stays PENDING forever and the dashboard's poller
 * spins until its own timeout. On an enqueue failure the row is instead
 * marked FAILED (best-effort - if even that update fails, the original
 * enqueue error is still what gets returned to the caller) before the
 * error response is returned, so a failed "scan now" always ends in a
 * terminal, non-misleading state.
 */
export async function POST(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { urlId } = await params;
    const monitoredUrl = await getMonitoredUrlForOrg(session.organizationId, urlId);

    const pendingJob = await createPendingMonitoringJob(monitoredUrl.organizationId, monitoredUrl.id);

    const queue = createMonitoringQueue();
    try {
      const queuedJob = await queue.add(
        "monitor",
        { organizationId: monitoredUrl.organizationId, monitoredUrlId: monitoredUrl.id, monitoringJobId: pendingJob.id },
        { jobId: pendingJob.id },
      );
      return NextResponse.json({ monitoringJobId: pendingJob.id, queuedJobId: queuedJob.id }, { status: 202 });
    } catch (enqueueErr) {
      const message = enqueueErr instanceof Error ? enqueueErr.message : "Failed to enqueue monitoring job";
      await markMonitoringJobFailed(pendingJob.id, message).catch((markErr: unknown) => {
        console.error(`Failed to mark orphaned MonitoringJob ${pendingJob.id} as FAILED after enqueue error:`, markErr);
      });
      throw enqueueErr;
    } finally {
      await queue.close().catch((closeErr: unknown) => {
        console.error("Failed to close monitoring queue connection:", closeErr);
      });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
