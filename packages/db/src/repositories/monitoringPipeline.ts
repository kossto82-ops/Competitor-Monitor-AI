import type { ComparisonResult, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { recordEntityObservations } from "./entityHistory.js";
import { promoteSignals } from "./signals.js";
import { recordCapabilityObservations } from "./capabilities.js";

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
        extractorVersion: extraction.extractorVersion ?? 1,
        requestedLocale: extraction.requestedLocale ?? null,
        pageLanguage: extraction.pageLanguage ?? null,
        extractedEntities: {
          create: extraction.extractedEntities.map((entity) => ({
            organizationId,
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

    const createdEvents: Awaited<ReturnType<typeof tx.changeEvent.create>>[] = [];
    let capabilityEventCount = 0;
    for (const draft of comparison.changeEvents) {
      const event = await tx.changeEvent.create({
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
      createdEvents.push(event);
    }

    // Phase 29 D1: only a scan we can trust feeds the history of the page's plans and prices.
    if (fetchSucceeded && comparison.verificationState !== "FAILED_TO_VERIFY") {
      await recordEntityObservations(tx, {
        organizationId,
        monitoredUrlId,
        snapshotId: snapshot.id,
        observedAt: snapshot.fetchedAt,
        entities: extraction.extractedEntities,
        events: createdEvents,
      });
      // Phase 29 F1: what the page says the service can do, from the same verified text.
      const capabilitySource = await tx.monitoredUrl.findUniqueOrThrow({ where: { id: monitoredUrlId }, select: { competitorId: true } });
      const capabilityResult = await recordCapabilityObservations(tx, {
        organizationId,
        competitorId: capabilitySource.competitorId,
        monitoredUrlId,
        observedAt: snapshot.fetchedAt,
        text: extraction.normalizedContent,
        // The first verified scan, or one that is a new baseline (extractor, market or layout changed), only sets the starting point.
        change: { snapshotId: snapshot.id, previousSnapshotId, baseline: previousSnapshotId === null || /new baseline/i.test(comparison.reason ?? "") },
      });
      capabilityEventCount = capabilityResult.events.length;
      createdEvents.push(...capabilityResult.events);
      // Phase 29 D2: verified events are promoted to signals in the same transaction, by deterministic rules.
      if (createdEvents.length > 0) {
        const source = await tx.monitoredUrl.findUniqueOrThrow({ where: { id: monitoredUrlId }, select: { competitorId: true } });
        await promoteSignals(tx, {
          organizationId,
          competitorId: source.competitorId,
          events: createdEvents,
          labels: new Map(extraction.extractedEntities.map((e) => [e.key, e.label])),
        });
      }
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

    // Validators are only kept from a verified full fetch; every other outcome clears them so the
    // next scan is unconditional and produces a fresh snapshot (a 304 must never be answered for a
    // page whose latest snapshot is not the verified one the validators came from).
    const keepValidators = fetchSucceeded && comparison.verificationState !== "FAILED_TO_VERIFY" && extraction.validators;
    const validatorData = keepValidators
      ? { etag: extraction.validators!.etag, lastModifiedHeader: extraction.validators!.lastModified, validatorsSetAt: new Date() }
      : { etag: null, lastModifiedHeader: null, validatorsSetAt: null };

    await tx.monitoredUrl.update({
      where: { id: monitoredUrlId },
      data: {
        ...(fetchSucceeded
          ? { lastSuccessfulScanAt: new Date(), consecutiveFailureCount: 0, lastAttemptAt: new Date() }
          : { consecutiveFailureCount: { increment: 1 }, lastAttemptAt: new Date() }),
        ...validatorData,
      },
    });

    return { ...snapshot, capabilityEventCount };
  });
}

export interface PersistNotModifiedInput {
  organizationId: string;
  monitoredUrlId: string;
  extraction: ExtractionResult;
  usage: { browserEscalated: boolean; aiCallMade: boolean };
}

/**
 * Phase 29 B3b: the server answered 304 Not Modified, so the page equals the latest verified
 * snapshot. The scan counts as a success (job COMPLETED, usage recorded, lastSuccessfulScanAt and
 * the failure streak updated) but NO snapshot is written - that is the storage the conditional
 * request exists to save. The validators stay as they were.
 */
export async function persistNotModifiedResult(jobId: string, input: PersistNotModifiedInput) {
  const { organizationId, monitoredUrlId, extraction, usage } = input;
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.monitoringJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", finishedAt: now, errorMessage: null },
    });
    await tx.usageRecord.create({
      data: {
        organizationId,
        monitoringJobId: jobId,
        extractionMethod: extraction.method,
        browserEscalated: usage.browserEscalated,
        aiCallMade: usage.aiCallMade,
        fetchSucceeded: true,
        processingTimeMs: extraction.durationMs,
      },
    });
    await tx.monitoredUrl.update({
      where: { id: monitoredUrlId },
      data: { lastSuccessfulScanAt: now, consecutiveFailureCount: 0, lastAttemptAt: now },
    });
  });
}
