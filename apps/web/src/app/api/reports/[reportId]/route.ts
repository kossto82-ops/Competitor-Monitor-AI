import { NextResponse } from "next/server";
import { getReportWithItemsForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteContext {
  params: Promise<{ reportId: string }>;
}

export async function GET(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { reportId } = await params;
    const report = await getReportWithItemsForOrg(session.organizationId, reportId);
    return NextResponse.json({ report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
