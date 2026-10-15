import { cookies } from "next/headers";
import { isUserSessionActive } from "@cma/db";
import { SESSION_COOKIE_NAME, verifySessionToken, type SessionPayload } from "./session";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifySessionToken(token);
  if (!payload) return null;
  // Phase 29 D5c (E16): a valid signature is not enough. The server-side session must still be active: not
  // logged out, not revoked, not past its lifetime or idle limit, and still this user's and this organization's.
  return (await isUserSessionActive(payload.sessionId, payload.userId, payload.organizationId)) ? payload : null;
}

/**
 * Every tenant-scoped route handler calls this first and uses the
 * returned `organizationId` for every subsequent @cma/db call - there
 * is no route that trusts an organizationId from the request body or
 * query string.
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}
