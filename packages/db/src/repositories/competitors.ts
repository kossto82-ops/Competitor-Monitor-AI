import type { CompetitorInput, UpdateCompetitorInput } from "@cma/core";
import { prisma } from "../client.js";
import { ConflictError, NotFoundError } from "./errors.js";

export async function createCompetitor(organizationId: string, input: CompetitorInput) {
  return prisma.competitor.create({
    data: {
      organizationId,
      name: input.name,
      website: input.website ?? null,
      notes: input.notes ?? null,
    },
  });
}

export async function listCompetitorsForOrg(organizationId: string) {
  return prisma.competitor.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The tenant-isolation primitive for competitors: `id` and
 * `organizationId` are both required in the WHERE clause, so a
 * competitor belonging to a different org is indistinguishable from a
 * competitor that doesn't exist at all.
 */
export async function getCompetitorForOrg(organizationId: string, competitorId: string) {
  const competitor = await prisma.competitor.findFirst({
    where: { id: competitorId, organizationId },
  });
  if (!competitor) throw new NotFoundError("Competitor");
  return competitor;
}

/**
 * Phase 5 (Section 3): editing an existing competitor, including
 * deactivate/reactivate (`isActive`). Deliberately never touches
 * MonitoredUrl/ChangeEvent rows - deactivating a competitor stops it
 * from being scheduled going forward (see monitoredUrls.ts's
 * listDueMonitoredUrls, which excludes URLs whose competitor is
 * inactive) but never deletes or hides its historical intelligence.
 */
export async function updateCompetitor(organizationId: string, competitorId: string, input: UpdateCompetitorInput) {
  const existing = await prisma.competitor.findFirst({ where: { id: competitorId, organizationId } });
  if (!existing) throw new NotFoundError("Competitor");

  return prisma.competitor.update({
    where: { id: competitorId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

/**
 * "Delete where safe" (Section 3): a competitor with any monitored URL
 * ever created for it (regardless of that URL's own isActive state)
 * carries monitoring/change history that a customer might reasonably
 * expect to keep - deleting the competitor would cascade-delete that
 * history (see the schema's `onDelete: Cascade` on MonitoredUrl). Such
 * a competitor must be deactivated, not deleted. Only a competitor with
 * zero monitored URLs (nothing to lose) can actually be deleted.
 */
export async function deleteCompetitorIfSafe(organizationId: string, competitorId: string): Promise<void> {
  const existing = await prisma.competitor.findFirst({ where: { id: competitorId, organizationId } });
  if (!existing) throw new NotFoundError("Competitor");

  const urlCount = await prisma.monitoredUrl.count({ where: { competitorId } });
  if (urlCount > 0) {
    throw new ConflictError("This competitor has monitored URLs and history - deactivate it instead of deleting it.");
  }

  await prisma.competitor.delete({ where: { id: competitorId } });
}

/**
 * Competitors plus per-competitor monitored-URL count, latest
 * MonitoringJob, and latest ChangeEvent - what the competitor list page
 * needs. ChangeEvent/MonitoringJob only carry `monitoredUrlId`, not
 * `competitorId`, so this maps URL -> competitor in memory rather than
 * running one query per competitor (avoids an N+1 pattern).
 */
export async function listCompetitorsWithSummaryForOrg(organizationId: string) {
  const competitors = await prisma.competitor.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
  if (competitors.length === 0) return [];

  const urls = await prisma.monitoredUrl.findMany({ where: { organizationId } });
  const urlIdToCompetitorId = new Map(urls.map((u) => [u.id, u.competitorId]));
  const urlCountByCompetitor = new Map<string, number>();
  for (const u of urls) {
    urlCountByCompetitor.set(u.competitorId, (urlCountByCompetitor.get(u.competitorId) ?? 0) + 1);
  }

  const urlIds = urls.map((u) => u.id);
  const [jobs, changeEvents] =
    urlIds.length > 0
      ? await Promise.all([
          prisma.monitoringJob.findMany({ where: { monitoredUrlId: { in: urlIds } }, orderBy: { createdAt: "desc" } }),
          prisma.changeEvent.findMany({ where: { monitoredUrlId: { in: urlIds } }, orderBy: { detectedAt: "desc" } }),
        ])
      : [[], []];

  const latestJobByCompetitor = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const competitorId = urlIdToCompetitorId.get(job.monitoredUrlId);
    if (competitorId && !latestJobByCompetitor.has(competitorId)) latestJobByCompetitor.set(competitorId, job);
  }
  const latestChangeByCompetitor = new Map<string, (typeof changeEvents)[number]>();
  for (const event of changeEvents) {
    const competitorId = urlIdToCompetitorId.get(event.monitoredUrlId);
    if (competitorId && !latestChangeByCompetitor.has(competitorId)) latestChangeByCompetitor.set(competitorId, event);
  }

  return competitors.map((c) => ({
    ...c,
    monitoredUrlCount: urlCountByCompetitor.get(c.id) ?? 0,
    latestJob: latestJobByCompetitor.get(c.id) ?? null,
    latestChangeEvent: latestChangeByCompetitor.get(c.id) ?? null,
  }));
}
