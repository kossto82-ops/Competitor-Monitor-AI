import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { NotFoundError } from "./errors.js";
import {
  deleteSmtpConnectionForOrg,
  getEnabledSmtpConfigForOrg,
  getSmtpConnectionForOrg,
  upsertSmtpConnectionForOrg,
} from "./smtpConnections.js";

/**
 * Phase 29 / A2b: real-Postgres integration test (skipped, not failed,
 * when unreachable - same convention as aiConnections.test.ts).
 */
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

const BASE = { host: "smtp.example.test", port: 587, security: "starttls" as const, fromAddress: "alerts@example.test" };

describe.skipIf(!reachable)("Organization SMTP connection repository", () => {
  const runId = Date.now();
  let counter = 0;

  beforeEach(() => {
    process.env["CMA_AI_ENCRYPTION_KEY"] = "test-suite-encryption-key-do-not-use-in-prod";
  });

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Smtp ${label} ${runId}-${counter}`,
      email: `smtp-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("returns null when the organization has no connection", async () => {
    const org = await makeOrg("none");
    expect(await getSmtpConnectionForOrg(org.id)).toBeNull();
    expect(await getEnabledSmtpConfigForOrg(org.id)).toBeNull();
  });

  it("never returns the password, plain or encrypted, and stores it encrypted at rest", async () => {
    const org = await makeOrg("secret");
    const saved = await upsertSmtpConnectionForOrg(org.id, { ...BASE, username: "bot@example.test", password: "pw-plaintext-marker" });

    expect(saved.hasPassword).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("pw-plaintext-marker");
    expect(saved).not.toHaveProperty("encryptedPassword");
    expect(saved).not.toHaveProperty("password");

    const raw = await prisma.organizationSmtpConnection.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(raw.encryptedPassword).toBeTruthy();
    expect(raw.encryptedPassword).not.toContain("pw-plaintext-marker");

    expect((await getEnabledSmtpConfigForOrg(org.id))?.password).toBe("pw-plaintext-marker");
  });

  it("upsert updates in place (one row per organization) and keeps / replaces / removes the password as asked", async () => {
    const org = await makeOrg("password-semantics");
    await upsertSmtpConnectionForOrg(org.id, { ...BASE, username: "u", password: "first" });

    await upsertSmtpConnectionForOrg(org.id, { ...BASE, host: "smtp2.example.test", username: "u" }); // password omitted
    expect((await getEnabledSmtpConfigForOrg(org.id))?.password).toBe("first");
    expect((await getEnabledSmtpConfigForOrg(org.id))?.host).toBe("smtp2.example.test");

    await upsertSmtpConnectionForOrg(org.id, { ...BASE, username: "u", password: "second" });
    expect((await getEnabledSmtpConfigForOrg(org.id))?.password).toBe("second");

    const removed = await upsertSmtpConnectionForOrg(org.id, { ...BASE, username: null, password: null });
    expect(removed.hasPassword).toBe(false);
    expect((await getEnabledSmtpConfigForOrg(org.id))?.password).toBeNull();

    expect(await prisma.organizationSmtpConnection.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it("a disabled connection is not used for delivery, but is still shown in settings", async () => {
    const org = await makeOrg("disabled");
    await upsertSmtpConnectionForOrg(org.id, { ...BASE, enabled: false });

    expect(await getEnabledSmtpConfigForOrg(org.id)).toBeNull();
    expect((await getSmtpConnectionForOrg(org.id))?.enabled).toBe(false);
  });

  it("is tenant-isolated: one organization can never read, change or delete another's connection", async () => {
    const a = await makeOrg("tenant-a");
    const b = await makeOrg("tenant-b");
    await upsertSmtpConnectionForOrg(a.id, { ...BASE, host: "a.example.test", username: "ua", password: "pa" });

    expect(await getSmtpConnectionForOrg(b.id)).toBeNull();
    expect(await getEnabledSmtpConfigForOrg(b.id)).toBeNull();
    await expect(deleteSmtpConnectionForOrg(b.id)).rejects.toBeInstanceOf(NotFoundError);

    await upsertSmtpConnectionForOrg(b.id, { ...BASE, host: "b.example.test" });
    expect((await getEnabledSmtpConfigForOrg(a.id))?.host).toBe("a.example.test");
    expect((await getEnabledSmtpConfigForOrg(a.id))?.password).toBe("pa");
    expect((await getEnabledSmtpConfigForOrg(b.id))?.password).toBeNull();
  });

  it("delete removes the connection, and deleting twice reports NotFound", async () => {
    const org = await makeOrg("delete");
    await upsertSmtpConnectionForOrg(org.id, BASE);
    await deleteSmtpConnectionForOrg(org.id);
    expect(await getSmtpConnectionForOrg(org.id)).toBeNull();
    await expect(deleteSmtpConnectionForOrg(org.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
