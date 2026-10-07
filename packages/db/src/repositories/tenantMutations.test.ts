import { afterAll, describe, expect, it } from "vitest";
import type { ComparisonResult, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor, deleteCompetitorIfSafe, updateCompetitor } from "./competitors.js";
import { createMonitoredUrl, deleteMonitoredUrlIfSafe, updateMonitoredUrl } from "./monitoredUrls.js";
import { createRunningMonitoringJob, persistMonitoringResult } from "./monitoringPipeline.js";
import { createAiConnection, deleteAiConnection, updateAiConnection } from "./aiConnections.js";
import { ConflictError, NotFoundError } from "./errors.js";

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

/**
 * Phase 29 C5: mutations carry the organization in the write itself (updateMany / deleteMany), so an id
 * from another tenant can never be modified or deleted - not even by a race between a check and a write.
 */
describe.skipIf(!reachable)("tenant-scoped atomic mutations (Phase 29 C5)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Tenant mutations ${label} ${runId}-${counter}`,
      email: `tenant-mutations-${label}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  describe("competitors", () => {
    it("updates the owner's row and returns it", async () => {
      const org = await makeOrg("comp-update");
      const competitor = await createCompetitor(org.id, { name: "Before" });
      const updated = await updateCompetitor(org.id, competitor.id, { name: "After", isActive: false });
      expect(updated).toMatchObject({ id: competitor.id, name: "After", isActive: false });
    });

    it("cannot update or delete another organization's competitor, and leaves it untouched", async () => {
      const owner = await makeOrg("comp-owner");
      const other = await makeOrg("comp-other");
      const competitor = await createCompetitor(owner.id, { name: "Mine" });

      await expect(updateCompetitor(other.id, competitor.id, { name: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteCompetitorIfSafe(other.id, competitor.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await prisma.competitor.findUniqueOrThrow({ where: { id: competitor.id } })).name).toBe("Mine");
    });

    it("deletes an empty competitor, refuses one with URLs (Conflict), and reports a missing one as NotFound", async () => {
      const org = await makeOrg("comp-delete");
      const empty = await createCompetitor(org.id, { name: "Empty" });
      await deleteCompetitorIfSafe(org.id, empty.id);
      expect(await prisma.competitor.findUnique({ where: { id: empty.id } })).toBeNull();

      const withUrl = await createCompetitor(org.id, { name: "Busy" });
      await createMonitoredUrl(org.id, withUrl.id, { url: "https://busy.example.test", category: "GENERAL" });
      await expect(deleteCompetitorIfSafe(org.id, withUrl.id)).rejects.toBeInstanceOf(ConflictError);
      expect(await prisma.competitor.findUnique({ where: { id: withUrl.id } })).not.toBeNull();

      await expect(deleteCompetitorIfSafe(org.id, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("monitored URLs", () => {
    it("cannot update or delete another organization's URL", async () => {
      const owner = await makeOrg("url-owner");
      const other = await makeOrg("url-other");
      const competitor = await createCompetitor(owner.id, { name: "C" });
      const url = await createMonitoredUrl(owner.id, competitor.id, { url: "https://mine.example.test", category: "GENERAL" });

      await expect(updateMonitoredUrl(other.id, url.id, { label: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteMonitoredUrlIfSafe(other.id, url.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await prisma.monitoredUrl.findUniqueOrThrow({ where: { id: url.id } })).label).toBeNull();
    });

    it("refuses to delete a URL that has a snapshot, deletes one that has none", async () => {
      const org = await makeOrg("url-delete");
      const competitor = await createCompetitor(org.id, { name: "C" });
      const clean = await createMonitoredUrl(org.id, competitor.id, { url: "https://clean.example.test", category: "GENERAL" });
      await deleteMonitoredUrlIfSafe(org.id, clean.id);
      expect(await prisma.monitoredUrl.findUnique({ where: { id: clean.id } })).toBeNull();

      const used = await createMonitoredUrl(org.id, competitor.id, { url: "https://used.example.test", category: "GENERAL" });
      const job = await createRunningMonitoringJob(org.id, used.id);
      await prisma.snapshot.create({
        data: { organizationId: org.id, monitoredUrlId: used.id, monitoringJobId: job.id, extractionMethod: "CHEERIO", verificationState: "NO_CHANGE", normalizedContent: "x", confidence: 1 },
      });
      await expect(deleteMonitoredUrlIfSafe(org.id, used.id)).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe("AI connections", () => {
    it("cannot update or delete another organization's connection", async () => {
      const owner = await makeOrg("ai-owner");
      const other = await makeOrg("ai-other");
      const connection = await createAiConnection(owner.id, { provider: "openai", model: "m", apiKey: "sk-test-key-value-1234567890" });

      await expect(updateAiConnection(other.id, connection.id, { model: "hijacked" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteAiConnection(other.id, connection.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await prisma.aiConnection.findUniqueOrThrow({ where: { id: connection.id } })).model).toBe("m");

      const updated = await updateAiConnection(owner.id, connection.id, { model: "better" });
      expect(updated.model).toBe("better");
      await deleteAiConnection(owner.id, connection.id);
      expect(await prisma.aiConnection.findUnique({ where: { id: connection.id } })).toBeNull();
    });
  });

  describe("snapshots and events", () => {
    const extraction = (overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({
      method: "CHEERIO",
      requestedUrl: "https://x.example.test",
      finalUrl: "https://x.example.test",
      httpStatus: 200,
      errorMessage: null,
      normalizedContent: "Pro 10 USD",
      contentHash: "h",
      structuredDataHash: "s",
      extractedEntities: [
        { type: "PRICE", key: "plan:pro:month", label: "Pro (per month)", value: "10.00", currency: "USD", raw: "$10" },
        { type: "PRICE", key: "plan:team:month", label: "Team (per month)", value: "30.00", currency: "USD", raw: "$30" },
      ],
      confidence: 1,
      warnings: [],
      durationMs: 1,
      ...overrides,
    });
    const comparison = (changeEvents: ComparisonResult["changeEvents"]): ComparisonResult => ({ verificationState: "CHANGED", reason: "r", changeEvents });
    const event = (fieldPath: string, changeType: "PRICE_CHANGE" | "PRODUCT_ADDED" = "PRICE_CHANGE") => ({
      changeType,
      severity: "MEDIUM" as const,
      confidence: 0.9,
      entityKey: fieldPath,
      fieldPath,
      oldValue: "1",
      newValue: "2",
      currency: "USD",
      percentageChange: 100,
      evidenceExcerpt: "e",
    });

    it("stores the organization on every extracted entity, so tenant-scoped reads need no join", async () => {
      const org = await makeOrg("entities");
      const competitor = await createCompetitor(org.id, { name: "C" });
      const url = await createMonitoredUrl(org.id, competitor.id, { url: "https://entities.example.test", category: "GENERAL" });
      const job = await createRunningMonitoringJob(org.id, url.id);
      await persistMonitoringResult(job.id, { organizationId: org.id, monitoredUrlId: url.id, previousSnapshotId: null, extraction: extraction(), comparison: comparison([]), usage: { browserEscalated: false, aiCallMade: false } });

      const rows = await prisma.extractedEntity.findMany({ where: { organizationId: org.id } });
      expect(rows.map((r) => r.key).sort()).toEqual(["plan:pro:month", "plan:team:month"]);
    });

    it("rejects two events of the same type and field in one snapshot (the database is the last guard)", async () => {
      const org = await makeOrg("unique-events");
      const competitor = await createCompetitor(org.id, { name: "C" });
      const url = await createMonitoredUrl(org.id, competitor.id, { url: "https://unique.example.test", category: "GENERAL" });
      const job = await createRunningMonitoringJob(org.id, url.id);

      await expect(
        persistMonitoringResult(job.id, {
          organizationId: org.id,
          monitoredUrlId: url.id,
          previousSnapshotId: null,
          extraction: extraction(),
          comparison: comparison([event("plan:pro:month"), event("plan:pro:month")]),
          usage: { browserEscalated: false, aiCallMade: false },
        }),
      ).rejects.toThrow();
      // The whole write is one transaction: nothing of the failed attempt remains.
      expect(await prisma.snapshot.count({ where: { monitoredUrlId: url.id } })).toBe(0);

      // Different type, or different field, is fine.
      const job2 = await createRunningMonitoringJob(org.id, url.id);
      await persistMonitoringResult(job2.id, {
        organizationId: org.id,
        monitoredUrlId: url.id,
        previousSnapshotId: null,
        extraction: extraction(),
        comparison: comparison([event("plan:pro:month"), event("plan:pro:month", "PRODUCT_ADDED"), event("plan:team:month")]),
        usage: { browserEscalated: false, aiCallMade: false },
      });
      expect(await prisma.changeEvent.count({ where: { monitoredUrlId: url.id } })).toBe(3);
    });
  });
});
