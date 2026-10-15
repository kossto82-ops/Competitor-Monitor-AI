import type { UserRole } from "../../generated/client/index.js";
import { prisma } from "../client.js";

/**
 * Phase 29 D5c (E16): server-side sessions. A signed token names a row here; the row, not the token, decides
 * whether somebody is still signed in. Absolute lifetime and idle time are both limited.
 */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
export const SESSION_IDLE_MS = 3 * 24 * 60 * 60_000;
/** The last-seen time is only rewritten this often, so a busy page does not write on every request. */
const TOUCH_EVERY_MS = 5 * 60_000;

export interface CreatedUserSession {
  id: string;
  expiresAt: Date;
}

export async function createUserSession(input: { userId: string; organizationId: string; userAgent?: string | null; now?: Date }): Promise<CreatedUserSession> {
  const now = input.now ?? new Date();
  // This user's finished sessions are of no use any more: tidy them while here instead of needing a cleanup job.
  await prisma.userSession.deleteMany({ where: { userId: input.userId, OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } }] } });
  const row = await prisma.userSession.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
    },
  });
  return { id: row.id, expiresAt: row.expiresAt };
}

/**
 * Whether this session may be used right now: it exists, belongs to this user and organization (a user moved
 * or deleted since the token was issued does not count), was not revoked, and has not passed its absolute or
 * idle limit. Records that it was seen.
 */
export async function isUserSessionActive(sessionId: string, userId: string, organizationId: string, now: Date = new Date()): Promise<boolean> {
  return (await getUserSessionAccess(sessionId, userId, organizationId, now)) !== null;
}

/**
 * Like `isUserSessionActive`, and also says which role the user holds in the database at this moment. The role
 * is read here on every request and never carried in the token, so demoting somebody takes effect at once.
 */
export async function getUserSessionAccess(sessionId: string, userId: string, organizationId: string, now: Date = new Date()): Promise<{ role: UserRole } | null> {
  const row = await prisma.userSession.findUnique({ where: { id: sessionId }, include: { user: { select: { id: true, organizationId: true, role: true } } } });
  if (!row || row.userId !== userId || row.organizationId !== organizationId) return null;
  if (row.user.id !== userId || row.user.organizationId !== organizationId) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (now.getTime() - row.lastSeenAt.getTime() > SESSION_IDLE_MS) return null;
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await prisma.userSession.update({ where: { id: sessionId }, data: { lastSeenAt: now } }).catch(() => undefined);
  }
  return { role: row.user.role };
}

/** Ends one session (logout). Idempotent: ending an unknown or already ended one is not an error. */
export async function revokeUserSession(sessionId: string, now: Date = new Date()): Promise<void> {
  await prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}

/** Ends every session of a user, optionally keeping the one making the request ("sign out everywhere else"). Returns how many ended. */
export async function revokeAllUserSessions(userId: string, options: { exceptSessionId?: string; now?: Date } = {}): Promise<number> {
  const result = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null, ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}) },
    data: { revokedAt: options.now ?? new Date() },
  });
  return result.count;
}

export interface UserSessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
}

/** The user's sessions that are still usable (tenant-safe: scoped by the user). */
export async function listActiveUserSessions(userId: string, now: Date = new Date()): Promise<UserSessionSummary[]> {
  const rows = await prisma.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { gte: new Date(now.getTime() - SESSION_IDLE_MS) } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, createdAt: true, lastSeenAt: true, userAgent: true },
  });
  return rows;
}
