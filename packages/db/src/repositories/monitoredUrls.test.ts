import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { ConflictError, NotFoundError } from "./errors.js";
import {
  createMonitoredUrl,
  deleteMonitoredUrlIfSafe,
  getMonitoredUrlForOrg,
  listDueMonitoredUrls,
  monitoringBackoffMs,
  updateMonitoredUrl,
} from "./monitoredUrls.js";

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

describe.skipIf(!reachable)("monitoredUrls repository (Phase 5)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrgWithCompetitor(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `MonitoredUrl CRUD ${label} ${runId}-${counter}`,
      email: `monitored-url-crud-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: `Competitor ${label}` });
    return { organization, competitor };
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("updates label/category/scanFrequencyMinutes", async () => {
    const { organization, competitor } = await makeOrgWithCompetitor("update");
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://update.example.test/pricing", category: "GENERAL" });

    const updated = await updateMonitoredUrl(organization.id, url.id, { label: "Pricing", category: "PRICING_PAGE", scanFrequencyMinutes: 60 });
    expect(updated.label).toBe("Pricing");
    expect(updated.category).toBe("PRICING_PAGE");
    expect(updated.scanFrequencyMinutes).toBe(60);
  });

  it("pauses and resumes a URL via isActive", async () => {
    const { organization, competitor } = await makeOrgWithCompetitor("pause");
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://pause.example.test/pricing", category: "GENERAL" });

    const paused = await updateMonitoredUrl(organization.id, url.id, { isActive: false });
    expect(paused.isActive).toBe(false);
    const resumed = await updateMonitoredUrl(organization.id, url.id, { isActive: true });
    expect(resumed.isActive).toBe(true);
  });

  it("tenant isolation: organization B cannot update organization A's URL", async () => {
    const a = await makeOrgWithCompetitor("update-tenant-a");
    const b = await makeOrgWithCompetitor("update-tenant-b");
    const url = await createMonitoredUrl(a.organization.id, a.competitor.id, { url: "https://tenant-a.example.test/pricing", category: "GENERAL" });

    await expect(updateMonitoredUrl(b.organization.id, url.id, { label: "hacked" })).rejects.toThrow(NotFoundError);
  });

  it("deletes a URL with zero snapshots", async () => {
    const { organization, competitor } = await makeOrgWithCompetitor("delete-safe");
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://delete-safe.example.test/pricing", category: "GENERAL" });

    await deleteMonitoredUrlIfSafe(organization.id, url.id);
    await expect(getMonitoredUrlForOrg(organization.id, url.id)).rejects.toThrow(NotFoundError);
  });

  it("refuses to delete a URL with monitoring history - ConflictError", async () => {
    const { organization, competitor } = await makeOrgWithCompetitor("delete-unsafe");
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://delete-unsafe.example.test/pricing", category: "GENERAL" });
    const job = await prisma.monitoringJob.create({ data: { organizationId: organization.id, monitoredUrlId: url.id, status: "COMPLETED" } });
    await prisma.snapshot.create({
      data: {
        organizationId: organization.id,
        monitoredUrlId: url.id,
        monitoringJobId: job.id,
        extractionMethod: "CHEERIO",
        verificationState: "NO_CHANGE",
        normalizedContent: "content",
        confidence: 1,
      },
    });

    await expect(deleteMonitoredUrlIfSafe(organization.id, url.id)).rejects.toThrow(ConflictError);
    await expect(getMonitoredUrlForOrg(organization.id, url.id)).resolves.toMatchObject({ id: url.id });
  });

  describe("listDueMonitoredUrls", () => {
    it("includes a URL that has never been successfully scanned", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-never");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-never.example.test/pricing", category: "GENERAL" });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).toContain(url.id);
    });

    it("excludes a URL scanned more recently than its own scanFrequencyMinutes", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-recent");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-recent.example.test/pricing", category: "GENERAL" });
      await updateMonitoredUrl(organization.id, url.id, { scanFrequencyMinutes: 1440 });
      await prisma.monitoredUrl.update({ where: { id: url.id }, data: { lastSuccessfulScanAt: new Date() } });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).not.toContain(url.id);
    });

    it("includes a URL whose last successful scan is older than its scanFrequencyMinutes", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-stale");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-stale.example.test/pricing", category: "GENERAL" });
      await updateMonitoredUrl(organization.id, url.id, { scanFrequencyMinutes: 15 });
      await prisma.monitoredUrl.update({ where: { id: url.id }, data: { lastSuccessfulScanAt: new Date(Date.now() - 30 * 60_000) } });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).toContain(url.id);
    });

    it("excludes a URL belonging to a deactivated competitor, even if otherwise due", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-inactive-competitor");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-inactive.example.test/pricing", category: "GENERAL" });
      await prisma.competitor.update({ where: { id: competitor.id }, data: { isActive: false } });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).not.toContain(url.id);
    });

    it("excludes a paused (isActive=false) URL", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-paused");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-paused.example.test/pricing", category: "GENERAL" });
      await updateMonitoredUrl(organization.id, url.id, { isActive: false });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).not.toContain(url.id);
    });

    it("excludes a URL whose last attempt is inside its backoff window (repeatedly failing)", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-backoff-recent");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-backoff.example.test/pricing", category: "GENERAL" });
      // Two consecutive failures 10 minutes ago -> backoff 30m -> NOT due yet.
      await prisma.monitoredUrl.update({
        where: { id: url.id },
        data: { lastAttemptAt: new Date(Date.now() - 10 * 60_000), consecutiveFailureCount: 2 },
      });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).not.toContain(url.id);
    });

    it("includes a URL whose last attempt is older than its backoff window", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-backoff-mature");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-backoff-mature.example.test/pricing", category: "GENERAL" });
      // Two consecutive failures 40 minutes ago -> backoff 30m -> due again.
      await prisma.monitoredUrl.update({
        where: { id: url.id },
        data: { lastAttemptAt: new Date(Date.now() - 40 * 60_000), consecutiveFailureCount: 2 },
      });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).toContain(url.id);
    });

    it("caps backoff at 24 hours for a permanently-failing URL (high consecutiveFailureCount)", async () => {
      const { organization, competitor } = await makeOrgWithCompetitor("due-backoff-capped");
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: "https://due-backoff-capped.example.test/pricing", category: "GENERAL" });
      // 41 consecutive failures (observed live for a bot-blocked URL),
      // last attempt 23 hours ago -> still inside the capped 24h window.
      await prisma.monitoredUrl.update({
        where: { id: url.id },
        data: { lastAttemptAt: new Date(Date.now() - 23 * 60 * 60_000), consecutiveFailureCount: 41 },
      });

      const due = await listDueMonitoredUrls();
      expect(due.map((u) => u.id)).not.toContain(url.id);

      // Move past the cap -> due again.
      await prisma.monitoredUrl.update({
        where: { id: url.id },
        data: { lastAttemptAt: new Date(Date.now() - 25 * 60 * 60_000) },
      });
      const dueAfter = await listDueMonitoredUrls();
      expect(dueAfter.map((u) => u.id)).toContain(url.id);
    });
  });

  describe("monitoringBackoffMs", () => {
    it("returns 0 for a healthy URL (no failures)", async () => {
      expect(monitoringBackoffMs(0)).toBe(0);
    });

    it("grows exponentially with the failure count", async () => {
      expect(monitoringBackoffMs(1)).toBe(15 * 60_000);
      expect(monitoringBackoffMs(2)).toBe(30 * 60_000);
      expect(monitoringBackoffMs(4)).toBe(2 * 60 * 60_000);
    });

    it("caps at 24 hours", async () => {
      expect(monitoringBackoffMs(41)).toBe(24 * 60 * 60_000);
    });
  });
});
