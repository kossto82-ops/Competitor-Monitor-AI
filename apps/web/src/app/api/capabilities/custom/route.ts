import { NextResponse } from "next/server";
import { customCapabilityInputSchema } from "@cma/core";
import { createCustomCapability, listCustomCapabilities } from "@cma/db";
import { assertPermission, requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

/** Phase 29 F3: the capabilities this organization defined itself (Features page, "Your own"). */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    return NextResponse.json({ capabilities: await listCustomCapabilities(session.organizationId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    assertPermission(session, "manage_org_settings");
    const body = customCapabilityInputSchema.parse(await request.json());
    const capability = await createCustomCapability(session.organizationId, body);
    return NextResponse.json({ capability }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
