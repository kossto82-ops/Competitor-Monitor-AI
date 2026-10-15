import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import {
  createUserSession,
  isUserSessionActive,
  listActiveUserSessions,
  revokeAllUserSessions,
  revokeUserSession,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from "./userSessions.js";

async function databaseIsReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();
const createdOrgIds: string[] = [];

describe.skipIf(!reachable)("server-side sessions (Phase 29 D5c)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeUser() {
    counter += 1;
    const { organization, user } = await createOrganizationWithOwner({
      organizationName: `Sessions ${runId}-${counter}`,
      email: `sessions-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return { organization, user };
  }

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("a new session is usable for its user and organization, and for nobody else", async () => {
    const { organization, user } = await makeUser();
    const other = await makeUser();
    const session = await createUserSession({ userId: user.id, organizationId: organization.id, userAgent: "Mozilla/5.0 test" });
    expect(await isUserSessionActive(session.id, user.id, organization.id)).toBe(true);
    expect(await isUserSessionActive(session.id, other.user.id, organization.id)).toBe(false);
    expect(await isUserSessionActive(session.id, user.id, other.organization.id)).toBe(false);
    expect(await isUserSessionActive("no-such-session", user.id, organization.id)).toBe(false);
  });

  it("logging out ends the session at once, and ending it again is harmless", async () => {
    const { organization, user } = await makeUser();
    const session = await createUserSession({ userId: user.id, organizationId: organization.id });
    await revokeUserSession(session.id);
    expect(await isUserSessionActive(session.id, user.id, organization.id)).toBe(false);
    await expect(revokeUserSession(session.id)).resolves.toBeUndefined();
    await expect(revokeUserSession("no-such-session")).resolves.toBeUndefined();
  });

  it("signing out everywhere ends every session, or every one but the current", async () => {
    const { organization, user } = await makeUser();
    const a = await createUserSession({ userId: user.id, organizationId: organization.id });
    const b = await createUserSession({ userId: user.id, organizationId: organization.id });
    const c = await createUserSession({ userId: user.id, organizationId: organization.id });
    expect(await revokeAllUserSessions(user.id, { exceptSessionId: a.id })).toBe(2);
    expect(await isUserSessionActive(a.id, user.id, organization.id)).toBe(true);
    expect(await isUserSessionActive(b.id, user.id, organization.id)).toBe(false);
    expect(await isUserSessionActive(c.id, user.id, organization.id)).toBe(false);
    expect(await revokeAllUserSessions(user.id)).toBe(1);
    expect(await isUserSessionActive(a.id, user.id, organization.id)).toBe(false);
  });

  it("does not touch another user's sessions", async () => {
    const mine = await makeUser();
    const other = await makeUser();
    const theirs = await createUserSession({ userId: other.user.id, organizationId: other.organization.id });
    await createUserSession({ userId: mine.user.id, organizationId: mine.organization.id });
    await revokeAllUserSessions(mine.user.id);
    expect(await isUserSessionActive(theirs.id, other.user.id, other.organization.id)).toBe(true);
  });

  it("stops at the absolute lifetime and at the idle limit", async () => {
    const { organization, user } = await makeUser();
    const session = await createUserSession({ userId: user.id, organizationId: organization.id });
    const created = Date.now();
    expect(await isUserSessionActive(session.id, user.id, organization.id, new Date(created + SESSION_IDLE_MS - 60_000))).toBe(true);
    // idle: not seen for longer than the idle limit
    await prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(created) } });
    expect(await isUserSessionActive(session.id, user.id, organization.id, new Date(created + SESSION_IDLE_MS + 60_000))).toBe(false);
    // absolute: used every day, still ends at the lifetime
    const busy = await createUserSession({ userId: user.id, organizationId: organization.id });
    const later = new Date(created + SESSION_ABSOLUTE_MS + 60_000);
    await prisma.userSession.update({ where: { id: busy.id }, data: { lastSeenAt: new Date(later.getTime() - 3_600_000) } });
    expect(await isUserSessionActive(busy.id, user.id, organization.id, later)).toBe(false);
  });

  it("records that it was seen, but not on every request", async () => {
    const { organization, user } = await makeUser();
    const session = await createUserSession({ userId: user.id, organizationId: organization.id });
    const before = (await prisma.userSession.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt;
    await isUserSessionActive(session.id, user.id, organization.id, new Date(before.getTime() + 60_000));
    expect((await prisma.userSession.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt.getTime()).toBe(before.getTime());
    const later = new Date(before.getTime() + 10 * 60_000);
    await isUserSessionActive(session.id, user.id, organization.id, later);
    expect((await prisma.userSession.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt.getTime()).toBe(later.getTime());
  });

  it("lists only the sessions still usable, newest activity first, and deleting the user removes them", async () => {
    const { organization, user } = await makeUser();
    const a = await createUserSession({ userId: user.id, organizationId: organization.id, userAgent: "A" });
    const b = await createUserSession({ userId: user.id, organizationId: organization.id, userAgent: "B" });
    await revokeUserSession(a.id);
    const active = await listActiveUserSessions(user.id);
    expect(active.map((s) => s.id)).toEqual([b.id]);
    expect(active[0]!.userAgent).toBe("B");
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(0);
  });

  it("clears this user's old finished sessions when a new one starts", async () => {
    const { organization, user } = await makeUser();
    const old = await createUserSession({ userId: user.id, organizationId: organization.id });
    await prisma.userSession.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await createUserSession({ userId: user.id, organizationId: organization.id });
    expect(await prisma.userSession.findUnique({ where: { id: old.id } })).toBeNull();
  });
});
