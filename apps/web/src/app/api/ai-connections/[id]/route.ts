import { NextResponse } from "next/server";
import { updateAiConnectionInputSchema } from "@cma/core";
import { deleteAiConnection, getAiConnectionForOrg, updateAiConnection } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = await params;
    const connection = await getAiConnectionForOrg(session.organizationId, id);
    return NextResponse.json({ connection });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Also how a connection is enabled/disabled (Section 6): `{ "enabled": false }`. */
export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = await params;
    const body = updateAiConnectionInputSchema.parse(await request.json());
    const connection = await updateAiConnection(session.organizationId, id, body);
    return NextResponse.json({ connection });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = await params;
    await deleteAiConnection(session.organizationId, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
