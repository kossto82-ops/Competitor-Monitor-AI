import type { MonitoredUrlInput } from "@cma/core";
import { prisma } from "../client.js";
import { getCompetitorForOrg } from "./competitors.js";
import { NotFoundError } from "./errors.js";

export async function createMonitoredUrl(organizationId: string, competitorId: string, input: MonitoredUrlInput) {
  // Throws NotFoundError if `competitorId` isn't this organization's -
  // this is what stops one tenant from attaching a URL to another
  // tenant's competitor by guessing/enumerating IDs.
  await getCompetitorForOrg(organizationId, competitorId);

  return prisma.monitoredUrl.create({
    data: {
      organizationId,
      competitorId,
      url: input.url,
      label: input.label ?? null,
      category: input.category,
    },
  });
}

export async function listMonitoredUrlsForOrg(organizationId: string, competitorId?: string) {
  return prisma.monitoredUrl.findMany({
    where: { organizationId, ...(competitorId ? { competitorId } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

export async function getMonitoredUrlForOrg(organizationId: string, monitoredUrlId: string) {
  const url = await prisma.monitoredUrl.findFirst({
    where: { id: monitoredUrlId, organizationId },
  });
  if (!url) throw new NotFoundError("MonitoredUrl");
  return url;
}

/**
 * Deliberately NOT tenant-scoped. This is the worker/scheduler's
 * cross-tenant entry point (Phase 1's manual "enqueue every active
 * URL" CLI) - it must never be reachable from a per-tenant API route.
 */
export async function listAllActiveMonitoredUrls() {
  return prisma.monitoredUrl.findMany({ where: { isActive: true } });
}

/**
 * URLs plus their latest MonitoringJob (for status: idle/queued/
 * scanning/completed/failed) and latest ChangeEvent, for the
 * competitor-detail and dashboard views. Fetches jobs/change-events for
 * all URLs in two queries total and matches them in memory (Map
 * lookup) rather than querying per URL - avoids an N+1 query pattern
 * for a competitor with many monitored URLs.
 */
export async function listMonitoredUrlsWithStatusForOrg(organizationId: string, competitorId?: string) {
  const urls = await prisma.monitoredUrl.findMany({
    where: { organizationId, ...(competitorId ? { competitorId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  if (urls.length === 0) return [];

  const urlIds = urls.map((u) => u.id);
  const [jobs, changeEvents, snapshots] = await Promise.all([
    prisma.monitoringJob.findMany({ where: { monitoredUrlId: { in: urlIds } }, orderBy: { createdAt: "desc" } }),
    prisma.changeEvent.findMany({ where: { monitoredUrlId: { in: urlIds } }, orderBy: { detectedAt: "desc" } }),
    prisma.snapshot.findMany({ where: { monitoredUrlId: { in: urlIds } }, orderBy: { fetchedAt: "desc" } }),
  ]);

  const latestJobByUrl = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (!latestJobByUrl.has(job.monitoredUrlId)) latestJobByUrl.set(job.monitoredUrlId, job);
  }
  const latestChangeByUrl = new Map<string, (typeof changeEvents)[number]>();
  for (const event of changeEvents) {
    if (!latestChangeByUrl.has(event.monitoredUrlId)) latestChangeByUrl.set(event.monitoredUrlId, event);
  }
  // The most recent snapshot regardless of verification state - this is
  // what lets the UI show "Could not verify this page" distinctly from
  // "No changes detected" (Section 6 of the Phase 2 brief: these must
  // never be conflated). Deliberately NOT the same as
  // getLatestVerifiedSnapshot, which skips FAILED_TO_VERIFY rows.
  const latestSnapshotByUrl = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    if (!latestSnapshotByUrl.has(snapshot.monitoredUrlId)) latestSnapshotByUrl.set(snapshot.monitoredUrlId, snapshot);
  }

  return urls.map((url) => ({
    ...url,
    latestJob: latestJobByUrl.get(url.id) ?? null,
    latestChangeEvent: latestChangeByUrl.get(url.id) ?? null,
    latestSnapshot: latestSnapshotByUrl.get(url.id) ?? null,
  }));
}

/**
 * Single-URL version of the above, used by the monitored-URL detail
 * view and by the dashboard's scan-status polling.
 */
export async function getMonitoredUrlDetailForOrg(organizationId: string, monitoredUrlId: string) {
  const url = await getMonitoredUrlForOrg(organizationId, monitoredUrlId);
  const [latestJob, latestChangeEvent] = await Promise.all([
    prisma.monitoringJob.findFirst({ where: { monitoredUrlId }, orderBy: { createdAt: "desc" } }),
    prisma.changeEvent.findFirst({ where: { monitoredUrlId }, orderBy: { detectedAt: "desc" } }),
  ]);
  return { ...url, latestJob, latestChangeEvent };
}
