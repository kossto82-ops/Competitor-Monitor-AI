import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { checkApiRequestOrigin, factsFromRequest } from "@/lib/originCheck";

const PUBLIC_PATHS = ["/login", "/signup"];

/**
 * UX-only redirect layer (send an unauthenticated visitor to /login,
 * send an authenticated one away from /login). This is NOT the
 * security boundary - every API route independently calls
 * requireSession() and re-derives organizationId from the verified
 * session, never from anything the browser sends. Middleware runs on
 * the Edge runtime, which is why this verifies the JWT itself rather
 * than importing the Node-only Prisma-backed session helpers.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Phase 29 D5c (E16): every state-changing API request must come from this site and, if it has a body, be JSON.
  // Only the check lives here: the API still authenticates and authorizes each request itself.
  if (pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    // Behind a reverse proxy the public origin can differ from the one this server sees: list it here.
    const extra = (process.env["CMA_ALLOWED_ORIGINS"] ?? "").split(",").map((o) => o.trim()).filter(Boolean);
    const requestOrigin = origin !== null && extra.includes(origin) ? origin : request.nextUrl.origin;
    const verdict = checkApiRequestOrigin(factsFromRequest(request, requestOrigin));
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!session && !isPublicPath && pathname !== "/") {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (session && isPublicPath) {
    return NextResponse.redirect(new URL("/today", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
