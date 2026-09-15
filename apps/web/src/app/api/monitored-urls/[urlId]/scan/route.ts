import { NextResponse } from "next/server";
import { getMonitoredUrlForOrg } from "@cma/db";
import { createMonitoringQueue, monitoringJobId } from "@cma/queue";
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
 */
export async function POST(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { urlId } = await params;
    const monitoredUrl = await getMonitoredUrlForOrg(session.organizationId, urlId);

    const queue = createMonitoringQueue();
    const job = await queue.add(
      "monitor",
      { organizationId: monitoredUrl.organizationId, monitoredUrlId: monitoredUrl.id },
      { jobId: monitoringJobId(monitoredUrl.id) },
    );
    await queue.close();

    return NextResponse.json({ queuedJobId: job.id }, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
