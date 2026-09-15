import { prisma } from "../client.js";

export interface ListChangeEventsOptions {
  monitoredUrlId?: string;
  limit?: number;
}

/**
 * Includes both snapshots so the evidence UI (Section 4/18 of the
 * brief) has everything it needs to show "previous vs. current" without
 * a second round-trip.
 */
export async function listChangeEventsForOrg(organizationId: string, options: ListChangeEventsOptions = {}) {
  return prisma.changeEvent.findMany({
    where: {
      organizationId,
      ...(options.monitoredUrlId ? { monitoredUrlId: options.monitoredUrlId } : {}),
    },
    orderBy: { detectedAt: "desc" },
    take: options.limit ?? 50,
    include: {
      monitoredUrl: { select: { url: true, label: true, competitorId: true, competitor: { select: { name: true } } } },
      currentSnapshot: true,
      previousSnapshot: true,
    },
  });
}

export async function getChangeEventForOrg(organizationId: string, changeEventId: string) {
  return prisma.changeEvent.findFirst({
    where: { id: changeEventId, organizationId },
    include: {
      monitoredUrl: { select: { url: true, label: true, competitorId: true, competitor: { select: { name: true } } } },
      currentSnapshot: { include: { extractedEntities: true } },
      previousSnapshot: { include: { extractedEntities: true } },
    },
  });
}
