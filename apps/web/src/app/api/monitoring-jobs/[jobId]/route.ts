import { NextResponse } from "next/server";
import { getMonitoringJobForOrg, NotFoundError } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/**
 * Polled by the dashboard after "Scan now" to drive the
 * Idle -> Queued -> Scanning -> Completed/Failed transition in the UI.
 */
export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { jobId } = await params;
    const job = await getMonitoringJobForOrg(session.organizationId, jobId);
    if (!job) throw new NotFoundError("MonitoringJob");
    return NextResponse.json({ job });
  } catch (err) {
    return toErrorResponse(err);
  }
}
