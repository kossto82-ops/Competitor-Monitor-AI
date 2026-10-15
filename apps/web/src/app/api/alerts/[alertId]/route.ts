import { NextResponse } from "next/server";
import { updateAlertInputSchema } from "@cma/core";
import { setAlertStatus } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ alertId: string }>;
}

/** Phase 29 D5: mark an alert as seen (`ACKNOWLEDGED`) or dismiss it. The alert must belong to the session's organization. */
export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { alertId } = await params;
    const body = updateAlertInputSchema.parse(await request.json());
    await setAlertStatus(session.organizationId, alertId, body.status);
    return NextResponse.json({ ok: true, status: body.status });
  } catch (err) {
    return toErrorResponse(err);
  }
}
