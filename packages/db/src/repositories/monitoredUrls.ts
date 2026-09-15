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
