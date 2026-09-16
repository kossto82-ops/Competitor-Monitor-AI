import { prisma } from "../client.js";

/**
 * Phase 5 (Section 19/20): a customer-facing "how much am I using this
 * product for" summary. Deliberately computed ON READ from tables that
 * already exist (Competitor, MonitoredUrl, ChangeEvent, AiAnalysis,
 * Report, NotificationLog) rather than a new write-time usage ledger -
 * Section 28 (no duplication): every one of these counts is already
 * exactly what its own table records, so introducing a second,
 * separately-written "usage event" table would only create a second
 * source of truth that could drift from the first. This is NOT a
 * billing computation (Section 19: "the objective is NOT billing yet")
 * - it exists purely to make usage visible and trustworthy for future
 * entitlement design.
 */
export interface ProductUsageSummary {
  competitors: number;
  monitoredUrls: number;
  changesThisMonth: number;
  aiAnalysesThisMonth: number;
  reports: number;
  emailsSent: number;
}

export async function getProductUsageSummaryForOrg(organizationId: string, since: Date): Promise<ProductUsageSummary> {
  const [competitors, monitoredUrls, changesThisMonth, aiAnalysesThisMonth, reports, emailsSent] = await Promise.all([
    prisma.competitor.count({ where: { organizationId } }),
    prisma.monitoredUrl.count({ where: { organizationId } }),
    prisma.changeEvent.count({ where: { organizationId, detectedAt: { gte: since } } }),
    prisma.aiAnalysis.count({ where: { organizationId, status: "COMPLETED", completedAt: { gte: since } } }),
    prisma.report.count({ where: { organizationId } }),
    prisma.notificationLog.count({ where: { organizationId, channel: "EMAIL", status: "SENT" } }),
  ]);

  return { competitors, monitoredUrls, changesThisMonth, aiAnalysesThisMonth, reports, emailsSent };
}

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
