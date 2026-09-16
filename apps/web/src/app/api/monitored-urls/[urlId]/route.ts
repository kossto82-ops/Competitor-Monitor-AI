import { NextResponse } from "next/server";
import { updateMonitoredUrlInputSchema } from "@cma/core";
import { deleteMonitoredUrlIfSafe, getMonitoredUrlDetailForOrg, updateMonitoredUrl } from "@cma/db";
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

/** Section 4/5: edit label/category/scanFrequencyMinutes, and pause/resume via `{ "isActive": false|true }`. */
export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { urlId } = await params;
    const body = updateMonitoredUrlInputSchema.parse(await request.json());
    const monitoredUrl = await updateMonitoredUrl(session.organizationId, urlId, body);
    return NextResponse.json({ monitoredUrl });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Section 4: "delete where safe" - 409s if this URL has monitoring history; pause instead. */
export async function DELETE(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { urlId } = await params;
    await deleteMonitoredUrlIfSafe(session.organizationId, urlId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
