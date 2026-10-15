import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/session";

/**
 * Phase 29 D5c: where the app sends a visitor whose cookie no longer names an active session (logged out
 * elsewhere, revoked, expired). It clears the cookie and goes to the login page, so the two cannot bounce
 * between each other. Clearing a cookie is harmless to trigger, which is why this is a plain redirect.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(0), expires: new Date(0) });
  return response;
}
