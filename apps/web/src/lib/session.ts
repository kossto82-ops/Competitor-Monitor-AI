import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "cma_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  userId: string;
  organizationId: string;
  /** The server-side session row this token names (Phase 29 D5c): the row, not the token, decides if it is still valid. */
  sessionId: string;
}

/**
 * The one set of cookie attributes, used to set the cookie and to clear it: a browser only removes a cookie
 * when the clearing one has the same attributes.
 */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

function getSecretKey(): Uint8Array {
  const secret = process.env["AUTH_SECRET"];
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET must be set to a random string of at least 32 characters (see .env.example).",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ userId: payload.userId, organizationId: payload.organizationId, sid: payload.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    // A token without a session id (issued before sessions were kept on the server) is no longer accepted.
    if (typeof payload["userId"] !== "string" || typeof payload["organizationId"] !== "string" || typeof payload["sid"] !== "string") {
      return null;
    }
    return { userId: payload["userId"], organizationId: payload["organizationId"], sessionId: payload["sid"] };
  } catch {
    // Expired, tampered, or malformed - all treated identically as "no session".
    return null;
  }
}
