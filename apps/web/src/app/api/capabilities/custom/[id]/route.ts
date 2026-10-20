import { NextResponse } from "next/server";
import { customCapabilityInputSchema } from "@cma/core";
import { deleteCustomCapability, updateCustomCapability } from "@cma/db";
import { assertPermission, requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    assertPermission(session, "manage_org_settings");
    const { id } = await params;
    const body = customCapabilityInputSchema.parse(await request.json());
    return NextResponse.json({ capability: await updateCustomCapability(session.organizationId, id, body) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    assertPermission(session, "manage_org_settings");
    const { id } = await params;
    await deleteCustomCapability(session.organizationId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
