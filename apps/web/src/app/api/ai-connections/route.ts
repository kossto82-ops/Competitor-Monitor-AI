import { NextResponse } from "next/server";
import { createAiConnectionInputSchema } from "@cma/core";
import { createAiConnection, listAiConnectionsForOrg } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

/**
 * Phase 3.1, Section 6: every response here is the "safe" DTO
 * (packages/db's SafeAiConnection) - no encrypted or plaintext API key
 * ever leaves this route, not even to the organization's own admins.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const connections = await listAiConnectionsForOrg(session.organizationId);
    return NextResponse.json({ connections });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = createAiConnectionInputSchema.parse(await request.json());
    const connection = await createAiConnection(session.organizationId, body);
    return NextResponse.json({ connection }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
