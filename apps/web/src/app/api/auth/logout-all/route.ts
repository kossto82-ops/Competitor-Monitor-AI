import { NextResponse } from "next/server";
import { revokeAllUserSessions } from "@cma/db";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

/**
 * Phase 29 D5c (E16): "sign out everywhere else". Ends every other session of the signed-in user and keeps the
 * one making the request, so somebody who suspects a lost device or a leaked cookie can cut it off.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const ended = await revokeAllUserSessions(session.userId, { exceptSessionId: session.sessionId });
    return NextResponse.json({ ok: true, ended });
  } catch (err) {
    return toErrorResponse(err);
  }
}
