import { NextResponse } from "next/server";
import { getDashboardSummaryForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const summary = await getDashboardSummaryForOrg(session.organizationId);
    return NextResponse.json({ summary });
  } catch (err) {
    return toErrorResponse(err);
  }
}
