import { NextResponse } from "next/server";
import { getChangeEventForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";
import { NotFoundError } from "@cma/db";

interface RouteParams {
  params: Promise<{ changeEventId: string }>;
}

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { changeEventId } = await params;
    const changeEvent = await getChangeEventForOrg(session.organizationId, changeEventId);
    if (!changeEvent) throw new NotFoundError("ChangeEvent");
    return NextResponse.json({ changeEvent });
  } catch (err) {
    return toErrorResponse(err);
  }
}
