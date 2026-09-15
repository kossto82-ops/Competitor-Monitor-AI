import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";

export async function listReportsForOrg(organizationId: string) {
  return prisma.report.findMany({ where: { organizationId }, orderBy: { reportDate: "desc" } });
}

export async function getReportForOrg(organizationId: string, reportId: string) {
  const report = await prisma.report.findFirst({ where: { id: reportId, organizationId } });
  if (!report) throw new NotFoundError("Report");
  return report;
}

/**
 * Looks up an AiAnalysis by its own id. Phase 3 added a direct
 * `organizationId` column to AiAnalysis (see the schema comment on
 * that model) so this scopes the same way every other repository
 * function does - a single `WHERE organizationId = ?`, not a join
 * through ChangeEvent.
 */
export async function getAiAnalysisForOrg(organizationId: string, aiAnalysisId: string) {
  const analysis = await prisma.aiAnalysis.findFirst({
    where: { id: aiAnalysisId, organizationId },
  });
  if (!analysis) throw new NotFoundError("AiAnalysis");
  return analysis;
}
