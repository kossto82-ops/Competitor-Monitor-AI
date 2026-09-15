import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";

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
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!session && !isPublicPath && pathname !== "/") {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (session && isPublicPath) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
