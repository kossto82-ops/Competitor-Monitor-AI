import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "cma_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  userId: string;
  organizationId: string;
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
  return new SignJWT({ userId: payload.userId, organizationId: payload.organizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload["userId"] !== "string" || typeof payload["organizationId"] !== "string") {
      return null;
    }
    return { userId: payload["userId"], organizationId: payload["organizationId"] };
  } catch {
    // Expired, tampered, or malformed - all treated identically as "no session".
    return null;
  }
}
