import { prisma } from "../client.js";

export interface UsageSummary {
  totalJobs: number;
  successfulFetches: number;
  failedFetches: number;
  browserEscalations: number;
  aiCalls: number;
  totalProcessingTimeMs: number;
}

/**
 * Section 8 of the brief: "enough information to understand the cost
 * of monitoring a customer". Deliberately reads from UsageRecord, which
 * is written for every job (success or failure), not derived from
 * ChangeEvent/Snapshot counts.
 */
export async function getUsageSummaryForOrg(organizationId: string, since: Date): Promise<UsageSummary> {
  const records = await prisma.usageRecord.findMany({
    where: { organizationId, createdAt: { gte: since } },
  });

  return {
    totalJobs: records.length,
    successfulFetches: records.filter((r) => r.fetchSucceeded).length,
    failedFetches: records.filter((r) => !r.fetchSucceeded).length,
    browserEscalations: records.filter((r) => r.browserEscalated).length,
    aiCalls: records.filter((r) => r.aiCallMade).length,
    totalProcessingTimeMs: records.reduce((sum, r) => sum + r.processingTimeMs, 0),
  };
}
