import type { MonitoredUrlInput, UpdateMonitoredUrlInput } from "@cma/core";
import { prisma } from "../client.js";
import { getCompetitorForOrg } from "./competitors.js";
import { ConflictError, NotFoundError } from "./errors.js";

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
 * Phase 5 (Section 5): the minimum real backend support for
 * `scanFrequencyMinutes` the brief asks for INSTEAD of a fake UI control -
 * a URL is "due" when it has never been successfully scanned, or its
 * last successful scan is older than its own configured frequency.
 * Also excludes URLs whose competitor was deactivated (Section 3:
 * deactivating a competitor stops future scheduling without deleting
 * history). Deliberately NOT tenant-scoped, same reason as
 * listAllActiveMonitoredUrls above - this is the scheduler's entry
 * point (apps/worker/src/enqueueAll.ts), never a per-tenant API route.
 */
export async function listDueMonitoredUrls(now: Date = new Date()) {
  const urls = await prisma.monitoredUrl.findMany({
    where: { isActive: true, competitor: { isActive: true } },
  });
  return urls.filter((url) => {
    if (!url.lastSuccessfulScanAt) return true;
    const dueAt = new Date(url.lastSuccessfulScanAt.getTime() + url.scanFrequencyMinutes * 60_000);
    return dueAt <= now;
  });
}

/** Phase 5 (Section 4): editing an existing monitored URL - label, category, frequency, and pause/resume (`isActive`). */
export async function updateMonitoredUrl(organizationId: string, monitoredUrlId: string, input: UpdateMonitoredUrlInput) {
  await getMonitoredUrlForOrg(organizationId, monitoredUrlId);

  return prisma.monitoredUrl.update({
    where: { id: monitoredUrlId },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.scanFrequencyMinutes !== undefined ? { scanFrequencyMinutes: input.scanFrequencyMinutes } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

/**
 * "Delete where safe" (Section 4), same principle as
 * deleteCompetitorIfSafe: a URL with any recorded Snapshot/ChangeEvent
 * history must be paused (isActive=false), not deleted - deleting it
 * would cascade-delete that auditable history.
 */
export async function deleteMonitoredUrlIfSafe(organizationId: string, monitoredUrlId: string): Promise<void> {
  await getMonitoredUrlForOrg(organizationId, monitoredUrlId);

  const snapshotCount = await prisma.snapshot.count({ where: { monitoredUrlId } });
  if (snapshotCount > 0) {
    throw new ConflictError("This URL has monitoring history - pause it instead of deleting it.");
  }

  await prisma.monitoredUrl.delete({ where: { id: monitoredUrlId } });
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
