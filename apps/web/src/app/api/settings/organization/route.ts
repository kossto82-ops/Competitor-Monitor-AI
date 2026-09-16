import { NextResponse } from "next/server";
import { updateOrganizationSettingsInputSchema } from "@cma/core";
import { getOrganizationById, updateOrganizationSettings } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

/** Section 18: daily report enabled/disabled, recipient override, timezone - nothing else yet. */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const organization = await getOrganizationById(session.organizationId);
    return NextResponse.json({ organization });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = updateOrganizationSettingsInputSchema.parse(await request.json());
    const organization = await updateOrganizationSettings(session.organizationId, body);
    return NextResponse.json({ organization });
  } catch (err) {
    return toErrorResponse(err);
  }
}
