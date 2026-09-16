import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { NotFoundError } from "./errors.js";
import {
  createAiConnection,
  deleteAiConnection,
  getAiConnectionForOrg,
  getDecryptedAiConnectionForOrg,
  getEnabledAiConnectionConfigForOrg,
  listAiConnectionsForOrg,
  updateAiConnection,
} from "./aiConnections.js";

/**
 * Phase 3.1 (Section 19): real multi-tenant integration test, through
 * actual database repositories - not mocked function calls. Same
 * real-Postgres convention as aiAnalysis.test.ts: skipped, not failed,
 * when unreachable.
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

describe.skipIf(!reachable)("AiConnection repository", () => {
  const runId = Date.now();
  let counter = 0;

  beforeEach(() => {
    process.env["CMA_AI_ENCRYPTION_KEY"] = "test-suite-encryption-key-do-not-use-in-prod";
  });

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `AiConnection ${label} ${runId}-${counter}`,
      email: `ai-connection-${label.toLowerCase()}-${runId}-${counter}@example.test`,
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

  it("creates a connection and never returns the plaintext or encrypted key (Section 6)", async () => {
    const org = await makeOrg("create");
    const connection = await createAiConnection(org.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-real-secret-value" });

    expect(connection.hasApiKey).toBe(true);
    expect(JSON.stringify(connection)).not.toContain("sk-real-secret-value");
    expect(connection).not.toHaveProperty("encryptedApiKey");
    expect(connection).not.toHaveProperty("apiKey");
  });

  it("stores the API key encrypted at rest - the raw DB row never contains the plaintext (Section 5)", async () => {
    const org = await makeOrg("encrypted-at-rest");
    const connection = await createAiConnection(org.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-plaintext-marker" });

    const rawRow = await prisma.aiConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(rawRow.encryptedApiKey).not.toContain("sk-plaintext-marker");
  });

  it("lists only the calling organization's connections", async () => {
    const a = await makeOrg("list-a");
    const b = await makeOrg("list-b");
    await createAiConnection(a.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-a" });
    await createAiConnection(b.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-b" });

    const aList = await listAiConnectionsForOrg(a.id);
    expect(aList).toHaveLength(1);
    expect(aList.every((c) => c.organizationId === a.id)).toBe(true);
  });

  it("tenant isolation: organization B cannot read organization A's connection by id (Section 19)", async () => {
    const a = await makeOrg("tenant-a");
    const b = await makeOrg("tenant-b");
    const connection = await createAiConnection(a.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-a-secret" });

    await expect(getAiConnectionForOrg(b.id, connection.id)).rejects.toThrow(NotFoundError);
    await expect(getAiConnectionForOrg(a.id, connection.id)).resolves.toMatchObject({ id: connection.id });
  });

  it("tenant isolation: organization B cannot update or delete organization A's connection", async () => {
    const a = await makeOrg("tenant-update-a");
    const b = await makeOrg("tenant-update-b");
    const connection = await createAiConnection(a.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-a" });

    await expect(updateAiConnection(b.id, connection.id, { enabled: false })).rejects.toThrow(NotFoundError);
    await expect(deleteAiConnection(b.id, connection.id)).rejects.toThrow(NotFoundError);

    // Unaffected by organization B's attempts.
    const stillA = await getAiConnectionForOrg(a.id, connection.id);
    expect(stillA.enabled).toBe(true);
  });

  it("updating without a new apiKey leaves the stored credential unchanged", async () => {
    const org = await makeOrg("update-no-key");
    const connection = await createAiConnection(org.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-original" });
    const before = await prisma.aiConnection.findUniqueOrThrow({ where: { id: connection.id } });

    await updateAiConnection(org.id, connection.id, { model: "gpt-4o-mini" });

    const after = await prisma.aiConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.encryptedApiKey).toBe(before.encryptedApiKey);
    expect(after.model).toBe("gpt-4o-mini");
  });

  it("updating with a new apiKey re-encrypts it", async () => {
    const org = await makeOrg("update-new-key");
    const connection = await createAiConnection(org.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-original" });
    const before = await prisma.aiConnection.findUniqueOrThrow({ where: { id: connection.id } });

    await updateAiConnection(org.id, connection.id, { apiKey: "sk-rotated" });

    const after = await prisma.aiConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.encryptedApiKey).not.toBe(before.encryptedApiKey);

    const config = await getEnabledAiConnectionConfigForOrg(org.id);
    expect(config?.apiKey).toBe("sk-rotated");
  });

  it("getEnabledAiConnectionConfigForOrg returns the decrypted credential for the worker's internal use only", async () => {
    const org = await makeOrg("decrypt");
    await createAiConnection(org.id, { provider: "openai-compatible", model: "custom-model", baseUrl: "https://provider.example/v1", apiKey: "sk-decrypt-me" });

    const config = await getEnabledAiConnectionConfigForOrg(org.id);
    expect(config).toEqual({ provider: "openai-compatible", model: "custom-model", baseUrl: "https://provider.example/v1", apiKey: "sk-decrypt-me" });
  });

  it("getEnabledAiConnectionConfigForOrg ignores disabled connections and returns null when none are enabled", async () => {
    const org = await makeOrg("disabled");
    const connection = await createAiConnection(org.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-a" });
    await updateAiConnection(org.id, connection.id, { enabled: false });

    expect(await getEnabledAiConnectionConfigForOrg(org.id)).toBeNull();
  });

  it("tenant isolation: an organization with no connection never resolves another organization's connection (Section 4/19)", async () => {
    const a = await makeOrg("no-config-a");
    const b = await makeOrg("no-config-b");
    await createAiConnection(b.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-b" });

    expect(await getEnabledAiConnectionConfigForOrg(a.id)).toBeNull();
  });

  it("getDecryptedAiConnectionForOrg (Section 9) returns the decrypted credential for the caller's own connection only", async () => {
    const org = await makeOrg("decrypt-for-test");
    const connection = await createAiConnection(org.id, { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-connection" });

    const config = await getDecryptedAiConnectionForOrg(org.id, connection.id);
    expect(config).toEqual({ provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: "sk-test-connection" });
  });

  it("getDecryptedAiConnectionForOrg tenant isolation: organization B cannot decrypt organization A's connection", async () => {
    const a = await makeOrg("decrypt-tenant-a");
    const b = await makeOrg("decrypt-tenant-b");
    const connection = await createAiConnection(a.id, { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-a" });

    await expect(getDecryptedAiConnectionForOrg(b.id, connection.id)).rejects.toThrow(NotFoundError);
    await expect(getDecryptedAiConnectionForOrg(a.id, connection.id)).resolves.toMatchObject({ apiKey: "sk-a" });
  });

  it("delete removes the connection", async () => {
    const org = await makeOrg("delete");
    const connection = await createAiConnection(org.id, { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-a" });
    await deleteAiConnection(org.id, connection.id);
    await expect(getAiConnectionForOrg(org.id, connection.id)).rejects.toThrow(NotFoundError);
  });
});
