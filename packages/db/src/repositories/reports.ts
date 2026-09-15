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
 * AiAnalysis has no organizationId column of its own (it hangs off
 * ChangeEvent, which does) - tenant scoping here goes through that
 * relation rather than a direct column, unlike every other repository
 * function in this package.
 */
export async function getAiAnalysisForOrg(organizationId: string, aiAnalysisId: string) {
  const analysis = await prisma.aiAnalysis.findFirst({
    where: { id: aiAnalysisId, changeEvent: { organizationId } },
  });
  if (!analysis) throw new NotFoundError("AiAnalysis");
  return analysis;
}
