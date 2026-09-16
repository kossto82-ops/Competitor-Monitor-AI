import { NextResponse } from "next/server";
import { updateCompetitorInputSchema } from "@cma/core";
import { deleteCompetitorIfSafe, getCompetitorForOrg, listMonitoredUrlsWithStatusForOrg, updateCompetitor } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ competitorId: string }>;
}

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { competitorId } = await params;

    const competitor = await getCompetitorForOrg(session.organizationId, competitorId);
    const monitoredUrls = await listMonitoredUrlsWithStatusForOrg(session.organizationId, competitorId);

    return NextResponse.json({ competitor, monitoredUrls });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Section 3: edit, and deactivate/reactivate via `{ "isActive": false|true }`. */
export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { competitorId } = await params;
    const body = updateCompetitorInputSchema.parse(await request.json());
    const competitor = await updateCompetitor(session.organizationId, competitorId, body);
    return NextResponse.json({ competitor });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Section 3: "delete where safe" - 409s (via ConflictError) if this competitor has monitored URLs/history; deactivate instead. */
export async function DELETE(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { competitorId } = await params;
    await deleteCompetitorIfSafe(session.organizationId, competitorId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
