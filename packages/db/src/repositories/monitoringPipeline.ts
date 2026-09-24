import type { ComparisonResult, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";

export async function createRunningMonitoringJob(organizationId: string, monitoredUrlId: string) {
  return prisma.monitoringJob.create({
    data: { organizationId, monitoredUrlId, status: "RUNNING", startedAt: new Date() },
  });
}

/**
 * Phase 2 addition: creates the MonitoringJob row as PENDING at the
 * moment the API enqueues a scan, before the worker ever picks it up -
 * without this, there is a real window (the time a job sits in the
 * BullMQ queue) where no DB row exists yet, and the dashboard has
 * nothing stable to poll to show a "Queued" state. The row's id is
 * threaded through the BullMQ payload so the worker updates this same
 * row (see markMonitoringJobRunning) instead of creating a second one.
 */
export async function createPendingMonitoringJob(organizationId: string, monitoredUrlId: string) {
  return prisma.monitoringJob.create({
    data: { organizationId, monitoredUrlId, status: "PENDING" },
  });
}

export async function markMonitoringJobRunning(jobId: string) {
  return prisma.monitoringJob.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: new Date() },
  });
}

/**
 * Phase 2.1 addition: the terminal state for a job that never reached
 * `persistMonitoringResult` at all - either the enqueue itself failed
 * (see the scan route, which pre-creates a PENDING row before calling
 * queue.add()) or the worker threw an exception it did not itself turn
 * into an ExtractionResult (a genuine bug, a DB outage mid-pipeline,
 * etc). This is deliberately distinct from `persistMonitoringResult`
 * setting status "FAILED": that path means the job RAN and recorded a
 * FAILED_TO_VERIFY snapshot (a fetch/verification failure, which is
 * still a successful job execution); this path means the job's
 * execution itself never completed, so there is no Snapshot to point
 * to. Both surface as MonitoringJob.status === "FAILED" to any caller
 * only interested in "is this job in a terminal, non-retryable-by-the-
 * dashboard state", but callers that need to tell them apart can check
 * whether a Snapshot row exists for the job.
 */
export async function markMonitoringJobFailed(jobId: string, errorMessage: string) {
  return prisma.monitoringJob.update({
    where: { id: jobId },
    data: { status: "FAILED", finishedAt: new Date(), errorMessage },
  });
}

export async function getMonitoringJobForOrg(organizationId: string, jobId: string) {
  return prisma.monitoringJob.findFirst({
    where: { id: jobId, organizationId },
    include: { monitoredUrl: { select: { url: true, label: true, competitorId: true } } },
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
        ? { lastSuccessfulScanAt: new Date(), consecutiveFailureCount: 0, lastAttemptAt: new Date() }
        : { consecutiveFailureCount: { increment: 1 }, lastAttemptAt: new Date() },
    });

    return snapshot;
  });
}
