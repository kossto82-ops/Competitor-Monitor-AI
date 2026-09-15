import { NextResponse } from "next/server";
import { competitorInputSchema } from "@cma/core";
import { createCompetitor, listCompetitorsForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const competitors = await listCompetitorsForOrg(session.organizationId);
    return NextResponse.json({ competitors });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = competitorInputSchema.parse(await request.json());
    const competitor = await createCompetitor(session.organizationId, body);
    return NextResponse.json({ competitor }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
