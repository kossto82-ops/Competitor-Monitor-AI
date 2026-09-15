import type { CompetitorInput } from "@cma/core";
import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";

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
