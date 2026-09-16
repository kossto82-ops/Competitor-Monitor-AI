import { NextResponse } from "next/server";
import { listReportsForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

/** Section 14: minimal report history - just enough to make reports usable, no advanced analytics. */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const reports = await listReportsForOrg(session.organizationId);
    return NextResponse.json({ reports });
  } catch (err) {
    return toErrorResponse(err);
  }
}
