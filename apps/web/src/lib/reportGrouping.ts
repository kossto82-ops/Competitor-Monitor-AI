import { groupChangesByCompetitor, type ReportChangeSummary } from "@cma/core";
import type { ReportItemWithChangeEvent } from "@cma/db";

/**
 * Phase 4 (Section 13/20): maps the report-detail query's Prisma shape
 * into the generic `ReportChangeSummary` contract so the same
 * deterministic ordering used by the report email (packages/notifications)
 * is used here too - see @cma/core's groupChangesByCompetitor doc
 * comment for why this lives in one shared, DB-agnostic place.
 */
export interface ReportChangeForDisplay extends ReportChangeSummary {
  reportItemId: string;
  changeEventId: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  monitoredUrlLabel: string | null;
  monitoredUrlUrl: string;
  evidenceExcerpt: string;
  /** null when there is no AiAnalysis row at all, distinct from a FAILED one (Section 7/8). */
  aiStatus: string | null;
  /** Only ever set when aiStatus === "COMPLETED" (Section 7: AI is enrichment, never authoritative). */
  aiSummary: string | null;
  aiConfidence: string | null;
}

export function groupReportItemsForDisplay(items: ReportItemWithChangeEvent[]) {
  const changes: ReportChangeForDisplay[] = items.map((item) => ({
    reportItemId: item.id,
    changeEventId: item.changeEvent.id,
    competitorId: item.changeEvent.monitoredUrl.competitorId,
    competitorName: item.changeEvent.monitoredUrl.competitor.name,
    changeType: item.changeEvent.changeType,
    detectedAt: item.changeEvent.detectedAt,
    oldValue: item.changeEvent.oldValue,
    newValue: item.changeEvent.newValue,
    currency: item.changeEvent.currency,
    percentageChange: item.changeEvent.percentageChange,
    monitoredUrlLabel: item.changeEvent.monitoredUrl.label,
    monitoredUrlUrl: item.changeEvent.monitoredUrl.url,
    evidenceExcerpt: item.changeEvent.evidenceExcerpt,
    aiStatus: item.changeEvent.aiAnalysis?.status ?? null,
    aiSummary: item.changeEvent.aiAnalysis?.status === "COMPLETED" ? (item.changeEvent.aiAnalysis.summary ?? null) : null,
    aiConfidence: item.changeEvent.aiAnalysis?.status === "COMPLETED" ? (item.changeEvent.aiAnalysis.confidence ?? null) : null,
  }));

  return groupChangesByCompetitor(changes);
}
