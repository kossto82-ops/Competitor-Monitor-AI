import { NextResponse } from "next/server";
import { upsertSmtpConnectionInputSchema } from "@cma/core";
import { deleteSmtpConnectionForOrg, getSmtpConnectionForOrg, upsertSmtpConnectionForOrg } from "@cma/db";
import { createEmailProviderFromEnv, isEmailProviderConfigured } from "@cma/notifications";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

/**
 * Phase 29 / A2b: the organization's own outgoing-email (SMTP) account.
 * Every response is the "safe" DTO - `hasPassword`, never the password
 * (plain or encrypted). The organization id always comes from the
 * session, never from the request.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const connection = await getSmtpConnectionForOrg(session.organizationId);
    return NextResponse.json({
      connection,
      // Whether the operator configured a default SMTP account that is used when the organization has none.
      serverDefaultConfigured: isEmailProviderConfigured(createEmailProviderFromEnv()),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = upsertSmtpConnectionInputSchema.parse(await request.json());
    const connection = await upsertSmtpConnectionForOrg(session.organizationId, body);
    return NextResponse.json({ connection });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    await deleteSmtpConnectionForOrg(session.organizationId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
