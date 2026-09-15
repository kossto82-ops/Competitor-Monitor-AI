import { NextResponse } from "next/server";
import { listChangeEventsForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { searchParams } = new URL(request.url);
    const monitoredUrlId = searchParams.get("monitoredUrlId") ?? undefined;

    const changeEvents = await listChangeEventsForOrg(session.organizationId, { monitoredUrlId });
    return NextResponse.json({ changeEvents });
  } catch (err) {
    return toErrorResponse(err);
  }
}
