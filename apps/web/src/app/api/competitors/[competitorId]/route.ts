import { NextResponse } from "next/server";
import { getCompetitorForOrg, listMonitoredUrlsWithStatusForOrg } from "@cma/db";
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
