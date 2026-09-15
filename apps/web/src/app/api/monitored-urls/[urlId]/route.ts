import { NextResponse } from "next/server";
import { getMonitoredUrlDetailForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ urlId: string }>;
}

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { urlId } = await params;
    const monitoredUrl = await getMonitoredUrlDetailForOrg(session.organizationId, urlId);
    return NextResponse.json({ monitoredUrl });
  } catch (err) {
    return toErrorResponse(err);
  }
}
