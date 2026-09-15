import type { ComparisonResult, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";

export async function createRunningMonitoringJob(organizationId: string, monitoredUrlId: string) {
  return prisma.monitoringJob.create({
    data: { organizationId, monitoredUrlId, status: "RUNNING", startedAt: new Date() },
  });
}

export interface PersistMonitoringResultInput {
  organizationId: string;
  monitoredUrlId: string;
  previousSnapshotId: string | null;
  extraction: ExtractionResult;
  comparison: ComparisonResult;
  usage: { browserEscalated: boolean; aiCallMade: boolean };
}

/**
 * Writes the whole outcome of one MonitoringJob - Snapshot, its
 * ExtractedEntity rows, every ChangeEvent draft, the job's final
 * status, and the UsageRecord - in a single transaction. A usage
 * record is written for every job regardless of success/failure
 * (Section 8: cost must be tracked even on failure).
 */
export async function persistMonitoringResult(jobId: string, input: PersistMonitoringResultInput) {
  const { organizationId, monitoredUrlId, previousSnapshotId, extraction, comparison, usage } = input;
  const fetchSucceeded = extraction.errorMessage === null;

  return prisma.$transaction(async (tx) => {
    const snapshot = await tx.snapshot.create({
      data: {
        organizationId,
        monitoredUrlId,
        monitoringJobId: jobId,
        extractionMethod: extraction.method,
        httpStatus: extraction.httpStatus,
        finalUrl: extraction.finalUrl,
        verificationState: comparison.verificationState,
        errorMessage: extraction.errorMessage,
        normalizedContent: extraction.normalizedContent,
        contentHash: extraction.contentHash,
        structuredDataHash: extraction.structuredDataHash,
        confidence: extraction.confidence,
        warnings: extraction.warnings,
        extractedEntities: {
          create: extraction.extractedEntities.map((entity) => ({
            type: entity.type,
            key: entity.key,
            label: entity.label,
            value: entity.value,
            currency: entity.currency,
            raw: entity.raw,
          })),
        },
      },
    });

    for (const draft of comparison.changeEvents) {
      await tx.changeEvent.create({
        data: {
          organizationId,
          monitoredUrlId,
          currentSnapshotId: snapshot.id,
          previousSnapshotId,
          changeType: draft.changeType,
          severity: draft.severity,
          confidence: draft.confidence,
          entityKey: draft.entityKey,
          fieldPath: draft.fieldPath,
          oldValue: draft.oldValue,
          newValue: draft.newValue,
          currency: draft.currency,
          percentageChange: draft.percentageChange,
          evidenceExcerpt: draft.evidenceExcerpt,
        },
      });
    }

    await tx.monitoringJob.update({
      where: { id: jobId },
      data: {
        status: fetchSucceeded ? "COMPLETED" : "FAILED",
        finishedAt: new Date(),
        errorMessage: extraction.errorMessage,
      },
    });

    await tx.usageRecord.create({
      data: {
        organizationId,
        monitoringJobId: jobId,
        extractionMethod: extraction.method,
        browserEscalated: usage.browserEscalated,
        aiCallMade: usage.aiCallMade,
        fetchSucceeded,
        processingTimeMs: extraction.durationMs,
      },
    });

    await tx.monitoredUrl.update({
      where: { id: monitoredUrlId },
      data: fetchSucceeded
        ? { lastSuccessfulScanAt: new Date(), consecutiveFailureCount: 0 }
        : { consecutiveFailureCount: { increment: 1 } },
    });

    return snapshot;
  });
}
