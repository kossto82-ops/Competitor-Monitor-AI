import { cookies } from "next/headers";
import { can, type Permission } from "@cma/core";
import { getUserSessionAccess } from "@cma/db";
import { SESSION_COOKIE_NAME, verifySessionToken, type SessionPayload } from "./session";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
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
  const access = await getUserSessionAccess(payload.sessionId, payload.userId, payload.organizationId);
  return access ? { ...payload, role: access.role } : null;
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

/**
 * Phase 29 D5d (E33): throws ForbiddenError (403, distinct from 401 "not signed in") unless the session's role
 * holds `permission`. Pure on purpose: routes call `assertPermission(await requireSession(), "...")`, so the rule
 * lives in `@cma/core` and not in the route.
 */
export function assertPermission(session: SessionPayload, permission: Permission): void {
  if (!can(session.role, permission)) throw new ForbiddenError(permission);
}

/** The session of somebody who may do `permission`. */
export async function requirePermission(permission: Permission): Promise<SessionPayload> {
  const session = await requireSession();
  assertPermission(session, permission);
  return session;
}
