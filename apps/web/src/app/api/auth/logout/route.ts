import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { revokeUserSession } from "@cma/db";
import { SESSION_COOKIE_NAME, sessionCookieOptions, verifySessionToken } from "@/lib/session";

/**
 * Phase 29 D5c (E16): logging out ends the session on the SERVER, so a copy of the cookie (a stolen one, one left
 * on another device) stops working at once; and the cookie is cleared with the attributes it was set with.
 * It always answers 200: logging out twice, or with an already expired cookie, is not an error.
 */
export async function POST(): Promise<NextResponse> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    const payload = await verifySessionToken(token);
    if (payload) await revokeUserSession(payload.sessionId).catch(() => undefined);
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(0), expires: new Date(0) });
  return response;
}
