import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { listSourceHealthForOrg, listSourcesNeedingAttention, sweepStuckJobs } from "./sourceHealth.js";

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
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60_000);

describe.skipIf(!reachable)("source health and stuck-job sweeper (Phase 29 B4)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `SourceHealth ${label} ${runId}-${counter}`,
      email: `source-health-${label}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  async function addUrl(orgId: string, competitorId: string, slug: string, data: Record<string, unknown> = {}) {
    const url = await createMonitoredUrl(orgId, competitorId, { url: `https://${slug}-${runId}.example.test/pricing`, category: "GENERAL" });
    return prisma.monitoredUrl.update({ where: { id: url.id }, data });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  describe("listSourceHealthForOrg / listSourcesNeedingAttention", () => {
    it("derives each source's state and only alerts on stopped or stale sources of active competitors, stopped first", async () => {
      const org = await makeOrg("alerts");
      const rival = await createCompetitor(org.id, { name: "Rival" });
      const inactive = await createCompetitor(org.id, { name: "Dormant" });
      await prisma.competitor.update({ where: { id: inactive.id }, data: { isActive: false } });

      const healthy = await addUrl(org.id, rival.id, "healthy", { lastSuccessfulScanAt: minutesAgo(30), lastAttemptAt: minutesAgo(30) });
      const failing = await addUrl(org.id, rival.id, "failing", {
        lastSuccessfulScanAt: minutesAgo(60),
        lastAttemptAt: minutesAgo(10),
        consecutiveFailureCount: 2,
      });
      const stale = await addUrl(org.id, rival.id, "stale", { lastSuccessfulScanAt: daysAgo(10), lastAttemptAt: daysAgo(1), consecutiveFailureCount: 4 });
      const stopped = await addUrl(org.id, rival.id, "stopped", { isActive: false, disabledAt: daysAgo(1), disabledReason: "AUTO_SUSTAINED_FAILURE" });
      await addUrl(org.id, inactive.id, "dormant", { lastSuccessfulScanAt: daysAgo(30), lastAttemptAt: daysAgo(30) });

      const rows = await listSourceHealthForOrg(org.id);
      const stateOf = (id: string) => rows.find((r) => r.id === id)?.health.state;
      expect(stateOf(healthy.id)).toBe("HEALTHY");
      expect(stateOf(failing.id)).toBe("DEGRADED");
      expect(stateOf(stale.id)).toBe("STALE");
      expect(stateOf(stopped.id)).toBe("DISABLED");

      const alerts = await listSourcesNeedingAttention(org.id);
      expect(alerts.map((a) => [a.sourceId, a.state])).toEqual([
        [stopped.id, "DISABLED"],
        [stale.id, "STALE"],
      ]);
      expect(alerts[0]?.competitorName).toBe("Rival");
    });

    it("is tenant-scoped", async () => {
      const a = await makeOrg("iso-a");
      const b = await makeOrg("iso-b");
      const compA = await createCompetitor(a.id, { name: "A rival" });
      await addUrl(a.id, compA.id, "iso", { isActive: false, disabledAt: new Date() });
      expect(await listSourceHealthForOrg(b.id)).toEqual([]);
      expect(await listSourcesNeedingAttention(b.id)).toEqual([]);
    });
  });

  describe("sweepStuckJobs", () => {
    async function makeChangeEvent(orgId: string, slug: string) {
      const competitor = await createCompetitor(orgId, { name: `C-${slug}` });
      const url = await addUrl(orgId, competitor.id, slug);
      const job = await prisma.monitoringJob.create({ data: { organizationId: orgId, monitoredUrlId: url.id, status: "COMPLETED" } });
      const snapshot = await prisma.snapshot.create({
        data: {
          organizationId: orgId,
          monitoredUrlId: url.id,
          monitoringJobId: job.id,
          extractionMethod: "CHEERIO",
          verificationState: "CHANGED",
          normalizedContent: "x",
          confidence: 1,
        },
      });
      return prisma.changeEvent.create({
        data: {
          organizationId: orgId,
          monitoredUrlId: url.id,
          currentSnapshotId: snapshot.id,
          changeType: "PRICE_CHANGE",
          severity: "HIGH",
          confidence: 0.9,
          fieldPath: "product.price",
          oldValue: "49.00",
          newValue: "39.00",
          currency: "EUR",
          percentageChange: -20.41,
          evidenceExcerpt: "Pro Plan now 39.00 EUR",
        },
      });
    }

    it("fails AI analyses and digest interpretations whose worker died, but not fresh or finished ones", async () => {
      const org = await makeOrg("sweep-ai");
      const stuck = await makeChangeEvent(org.id, "sweep-stuck");
      const fresh = await makeChangeEvent(org.id, "sweep-fresh");
      const done = await makeChangeEvent(org.id, "sweep-done");

      const stuckRow = await prisma.aiAnalysis.create({
        data: { organizationId: org.id, changeEventId: stuck.id, promptVersion: "v", status: "RUNNING", startedAt: minutesAgo(40) },
      });
      const freshRow = await prisma.aiAnalysis.create({
        data: { organizationId: org.id, changeEventId: fresh.id, promptVersion: "v", status: "RUNNING", startedAt: minutesAgo(2) },
      });
      const doneRow = await prisma.aiAnalysis.create({
        data: { organizationId: org.id, changeEventId: done.id, promptVersion: "v", status: "COMPLETED", startedAt: minutesAgo(500) },
      });
      const digest = await prisma.digestAiInterpretation.create({
        data: { organizationId: org.id, days: 7, promptVersion: "v", status: "RUNNING", startedAt: minutesAgo(60) },
      });

      const result = await sweepStuckJobs();
      expect(result.aiAnalyses).toBeGreaterThanOrEqual(1);
      expect(result.digestInterpretations).toBeGreaterThanOrEqual(1);

      const after = async (id: string) => prisma.aiAnalysis.findUniqueOrThrow({ where: { id } });
      expect((await after(stuckRow.id)).status).toBe("FAILED");
      expect((await after(stuckRow.id)).errorMessage).toMatch(/Timed out/);
      expect((await after(freshRow.id)).status).toBe("RUNNING");
      expect((await after(doneRow.id)).status).toBe("COMPLETED");
      expect((await prisma.digestAiInterpretation.findUniqueOrThrow({ where: { id: digest.id } })).status).toBe("FAILED");
    });

    it("ages a re-used AI row's PENDING state from updatedAt, so a fresh refresh of an old row survives", async () => {
      const org = await makeOrg("sweep-refresh");
      const event = await makeChangeEvent(org.id, "sweep-refresh");
      // Created long ago, reset to PENDING just now (a refresh): updatedAt is fresh, createdAt is old.
      const row = await prisma.aiAnalysis.create({
        data: { organizationId: org.id, changeEventId: event.id, promptVersion: "v", status: "PENDING", createdAt: daysAgo(5) },
      });
      await sweepStuckJobs();
      expect((await prisma.aiAnalysis.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING");

      // The same row left untouched for longer than the PENDING limit is swept.
      const swept = await sweepStuckJobs(new Date(Date.now() + 3 * 60 * 60_000));
      expect(swept.aiAnalyses).toBeGreaterThanOrEqual(1);
      expect((await prisma.aiAnalysis.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("FAILED");
    });

    it("fails monitoring jobs stuck RUNNING or PENDING so the dashboard poller can stop", async () => {
      const org = await makeOrg("sweep-mj");
      const competitor = await createCompetitor(org.id, { name: "Rival" });
      const url = await addUrl(org.id, competitor.id, "sweep-mj");
      const running = await prisma.monitoringJob.create({
        data: { organizationId: org.id, monitoredUrlId: url.id, status: "RUNNING", startedAt: minutesAgo(45) },
      });
      const pending = await prisma.monitoringJob.create({
        data: { organizationId: org.id, monitoredUrlId: url.id, status: "PENDING", createdAt: minutesAgo(180) },
      });
      const recent = await prisma.monitoringJob.create({
        data: { organizationId: org.id, monitoredUrlId: url.id, status: "PENDING", createdAt: minutesAgo(5) },
      });

      await sweepStuckJobs();
      const status = async (id: string) => (await prisma.monitoringJob.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(running.id)).toBe("FAILED");
      expect(await status(pending.id)).toBe("FAILED");
      expect(await status(recent.id)).toBe("PENDING");
      expect((await prisma.monitoringJob.findUniqueOrThrow({ where: { id: running.id } })).finishedAt).not.toBeNull();
    });
  });
});
