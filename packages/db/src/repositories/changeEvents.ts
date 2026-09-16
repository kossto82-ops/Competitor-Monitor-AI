import type { ChangeType } from "../../generated/client/index.js";
import { prisma } from "../client.js";

export interface ListChangeEventsOptions {
  monitoredUrlId?: string;
  /** Phase 5 (Section 16): basic filtering - competitor, change type, date range. Every filter is optional and independent. */
  competitorId?: string;
  changeType?: string;
  detectedAfter?: Date;
  detectedBefore?: Date;
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
      ...(options.competitorId ? { monitoredUrl: { competitorId: options.competitorId } } : {}),
      ...(options.changeType ? { changeType: options.changeType as ChangeType } : {}),
      ...(options.detectedAfter || options.detectedBefore
        ? {
            detectedAt: {
              ...(options.detectedAfter ? { gte: options.detectedAfter } : {}),
              ...(options.detectedBefore ? { lte: options.detectedBefore } : {}),
            },
          }
        : {}),
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

/**
 * Phase 5 (Section 15): a single competitor's full change history
 * across ALL of its monitored URLs, oldest-first-within-day but
 * overall descending (newest first) for the timeline view - reuses the
 * same query shape as listChangeEventsForOrg rather than a parallel
 * implementation (Section 28: no duplication).
 */
export async function listChangeEventsForCompetitor(organizationId: string, competitorId: string, limit = 100) {
  return listChangeEventsForOrg(organizationId, { competitorId, limit });
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
