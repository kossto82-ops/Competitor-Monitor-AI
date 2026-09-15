import { NextResponse } from "next/server";
import { getOrganizationById } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const organization = await getOrganizationById(session.organizationId);
    return NextResponse.json({ userId: session.userId, organization });
  } catch (err) {
    return toErrorResponse(err);
  }
}
