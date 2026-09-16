import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import {
  getDigestAiInterpretationForOrg,
  getOrCreateDigestAiInterpretationSlot,
  markDigestAiInterpretationCompleted,
  markDigestAiInterpretationFailed,
  markDigestAiInterpretationRunning,
} from "./digestAiInterpretation.js";

/** Same real-Postgres convention as aiAnalysis.test.ts / dashboard.test.ts: skipped, not failed, when unreachable. */
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

describe.skipIf(!reachable)("DigestAiInterpretation repository (Phase 11)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `DigestAi ${label} ${runId}-${counter}`,
      email: `digest-ai-${label.toLowerCase()}-${runId}-${counter}@example.test`,
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

  it("creates a PENDING slot on first request for an (organization, days) pair", async () => {
    const org = await makeOrg("fresh");
    const slot = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "digest-interpretation-v1");
    expect(slot.status).toBe("PENDING");
    expect(slot.organizationId).toBe(org.id);
    expect(slot.days).toBe(30);
  });

  it("is idempotent for a PENDING slot - a second call returns the SAME row, never a duplicate", async () => {
    const org = await makeOrg("idempotent");
    const first = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    const second = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    expect(second.id).toBe(first.id);

    const count = await prisma.digestAiInterpretation.count({ where: { organizationId: org.id, days: 30 } });
    expect(count).toBe(1);
  });

  it("a RUNNING slot is returned unchanged - never reset/duplicated by a second near-simultaneous request", async () => {
    const org = await makeOrg("running-guard");
    const pending = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    const running = await markDigestAiInterpretationRunning(pending.id);
    expect(running.status).toBe("RUNNING");

    const secondCall = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    expect(secondCall.id).toBe(running.id);
    expect(secondCall.status).toBe("RUNNING");
  });

  it("different `days` selectors for the same organization get independent slots", async () => {
    const org = await makeOrg("multi-days");
    const slot7 = await getOrCreateDigestAiInterpretationSlot(org.id, 7, "v1");
    const slot30 = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    expect(slot7.id).not.toBe(slot30.id);
  });

  it("runs through PENDING -> RUNNING -> COMPLETED and persists the structured output, window, and provider metadata", async () => {
    const org = await makeOrg("lifecycle");
    const pending = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "digest-interpretation-v1");
    const running = await markDigestAiInterpretationRunning(pending.id);
    expect(running.startedAt).not.toBeNull();

    const windowStart = new Date("2026-08-01T00:00:00Z");
    const windowEnd = new Date("2026-08-31T00:00:00Z");
    const completed = await markDigestAiInterpretationCompleted(pending.id, {
      provider: "fake",
      model: "fake-v1",
      windowStart,
      windowEnd,
      summary: "One competitor is above its own baseline.",
      observations: [{ text: "Competitor A recorded 4 price changes.", evidenceChangeEventIds: ["ce-1"] }],
      interpretations: [],
      hypotheses: [],
      inputTokens: 300,
      outputTokens: 90,
      durationMs: 900,
    });

    expect(completed.status).toBe("COMPLETED");
    expect(completed.provider).toBe("fake");
    expect(completed.windowStart?.toISOString()).toBe(windowStart.toISOString());
    expect(completed.windowEnd?.toISOString()).toBe(windowEnd.toISOString());
    expect(completed.summary).toBe("One competitor is above its own baseline.");
    expect(completed.observations).toEqual([{ text: "Competitor A recorded 4 price changes.", evidenceChangeEventIds: ["ce-1"] }]);
    expect(completed.completedAt).not.toBeNull();
  });

  it("marks FAILED on provider failure without ever touching any deterministic Digest data", async () => {
    const org = await makeOrg("failure");
    const pending = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    await markDigestAiInterpretationRunning(pending.id);
    const failed = await markDigestAiInterpretationFailed(pending.id, "provider timed out");

    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toBe("provider timed out");
  });

  it("never overwrites an already-COMPLETED row on a duplicate delivery", async () => {
    const org = await makeOrg("duplicate-delivery");
    const pending = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    await markDigestAiInterpretationRunning(pending.id);
    await markDigestAiInterpretationCompleted(pending.id, {
      provider: "fake",
      model: "fake-v1",
      windowStart: new Date(),
      windowEnd: new Date(),
      summary: "first summary",
      observations: [],
      interpretations: [],
      hypotheses: [],
      durationMs: 10,
    });

    await markDigestAiInterpretationRunning(pending.id);
    const secondAttempt = await markDigestAiInterpretationCompleted(pending.id, {
      provider: "fake",
      model: "fake-v1",
      windowStart: new Date(),
      windowEnd: new Date(),
      summary: "second summary - should never be persisted",
      observations: [],
      interpretations: [],
      hypotheses: [],
      durationMs: 10,
    });

    expect(secondAttempt.summary).toBe("first summary");
  });

  it("a COMPLETED slot is reset back to PENDING (and every terminal field cleared) on an explicit re-trigger", async () => {
    const org = await makeOrg("regenerate");
    const pending = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    await markDigestAiInterpretationRunning(pending.id);
    const completed = await markDigestAiInterpretationCompleted(pending.id, {
      provider: "fake",
      model: "fake-v1",
      windowStart: new Date(),
      windowEnd: new Date(),
      summary: "stale summary",
      observations: [{ text: "x", evidenceChangeEventIds: ["ce-1"] }],
      interpretations: [],
      hypotheses: [],
      durationMs: 10,
    });
    expect(completed.status).toBe("COMPLETED");

    const reset = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    expect(reset.id).toBe(completed.id);
    expect(reset.status).toBe("PENDING");
    expect(reset.summary).toBeNull();
    expect(reset.observations).toEqual([]);
    expect(reset.windowStart).toBeNull();
    expect(reset.errorMessage).toBeNull();

    const rowCount = await prisma.digestAiInterpretation.count({ where: { organizationId: org.id, days: 30 } });
    expect(rowCount).toBe(1);
  });

  it("a FAILED slot is likewise reset back to PENDING on an explicit re-trigger", async () => {
    const org = await makeOrg("retry-failed");
    const pending = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    await markDigestAiInterpretationRunning(pending.id);
    await markDigestAiInterpretationFailed(pending.id, "boom");

    const reset = await getOrCreateDigestAiInterpretationSlot(org.id, 30, "v1");
    expect(reset.status).toBe("PENDING");
    expect(reset.errorMessage).toBeNull();
  });

  it("scopes lookups by organizationId - one org can never read another org's DigestAiInterpretation", async () => {
    const a = await makeOrg("tenant-a");
    const b = await makeOrg("tenant-b");
    await getOrCreateDigestAiInterpretationSlot(a.id, 30, "v1");

    const crossTenantRead = await getDigestAiInterpretationForOrg(b.id, 30);
    expect(crossTenantRead).toBeNull();

    const ownRead = await getDigestAiInterpretationForOrg(a.id, 30);
    expect(ownRead).not.toBeNull();
  });
});
