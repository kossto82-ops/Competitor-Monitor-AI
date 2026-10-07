import type { ExtractedEntity, ExtractionResult, ComparisonResult } from "@cma/core";
import { CheerioExtractor, createRobotsCheckerFromEnv, defaultFetch, EXTRACTOR_VERSION, type Extractor } from "@cma/extraction";
import { compareSnapshots, type PriorSnapshotData } from "@cma/detection";
import * as db from "@cma/db";
import type { MonitoringJobPayload } from "@cma/queue";

function toCoreEntities(
  rows: { type: string; key: string; label: string; value: string | null; currency: string | null; raw: string }[],
): ExtractedEntity[] {
  return rows.map((row) => ({
    type: row.type as ExtractedEntity["type"],
    key: row.key,
    label: row.label,
    value: row.value,
    currency: row.currency,
    raw: row.raw,
  }));
}

export interface RunMonitoringJobResult {
  monitoringJobId: string;
  verificationState: string;
  changeEventCount: number;
}

interface MonitoredUrlLike {
  id: string;
  organizationId: string;
  url: string;
  etag?: string | null;
  lastModifiedHeader?: string | null;
  validatorsSetAt?: Date | null;
}

/** CMA_CONDITIONAL_MAX_AGE_HOURS (default 168 = 7 days): after this a full fetch is forced regardless of validators. */
export function conditionalMaxAgeMs(): number {
  const n = Number(process.env.CMA_CONDITIONAL_MAX_AGE_HOURS);
  return (Number.isFinite(n) && n >= 0 ? n : 168) * 3_600_000;
}

interface PriorSnapshotLike {
  id: string;
  /** Missing on rows from before Phase 29 C2; those were produced by version 1. */
  extractorVersion?: number;
  contentHash: string | null;
  structuredDataHash: string | null;
  normalizedContent: string;
  extractedEntities: {
    type: string;
    key: string;
    label: string;
    value: string | null;
    currency: string | null;
    raw: string;
  }[];
}

/**
 * The pipeline's real collaborators, injectable so `runMonitoringJob`
 * can be unit tested (fake db + fake extractor) without a live Postgres
 * or a real network call. Production code never overrides these -
 * `runMonitoringJob`'s default parameter wires the real @cma/db and
 * @cma/extraction implementations.
 */
export interface PipelineDeps {
  persistNotModifiedResult: (
    jobId: string,
    input: {
      organizationId: string;
      monitoredUrlId: string;
      extraction: ExtractionResult;
      usage: { browserEscalated: boolean; aiCallMade: boolean };
    },
  ) => Promise<unknown>;
  extractor: Pick<Extractor, "extract">;
  getMonitoredUrlForOrg: (organizationId: string, monitoredUrlId: string) => Promise<MonitoredUrlLike>;
  getLatestVerifiedSnapshot: (monitoredUrlId: string) => Promise<PriorSnapshotLike | null>;
  createRunningMonitoringJob: (organizationId: string, monitoredUrlId: string) => Promise<{ id: string }>;
  markMonitoringJobRunning: (jobId: string) => Promise<{ id: string }>;
  markMonitoringJobFailed: (jobId: string, errorMessage: string) => Promise<unknown>;
  persistMonitoringResult: (
    jobId: string,
    input: {
      organizationId: string;
      monitoredUrlId: string;
      previousSnapshotId: string | null;
      extraction: ExtractionResult;
      comparison: ComparisonResult;
      usage: { browserEscalated: boolean; aiCallMade: boolean };
    },
  ) => Promise<unknown>;
}

export function createDefaultPipelineDeps(): PipelineDeps {
  return {
    extractor: new CheerioExtractor(defaultFetch, createRobotsCheckerFromEnv()),
    getMonitoredUrlForOrg: db.getMonitoredUrlForOrg,
    getLatestVerifiedSnapshot: db.getLatestVerifiedSnapshot,
    createRunningMonitoringJob: db.createRunningMonitoringJob,
    markMonitoringJobRunning: db.markMonitoringJobRunning,
    markMonitoringJobFailed: db.markMonitoringJobFailed,
    persistMonitoringResult: db.persistMonitoringResult,
    persistNotModifiedResult: db.persistNotModifiedResult,
  };
}

/**
 * The Phase 1 pipeline in one place: Fetch -> Extract -> Normalize ->
 * Snapshot -> Compare -> ChangeEvent (Section 1's ordering). AI
 * interpretation and notification dispatch are intentionally not
 * called from here yet - a ChangeEvent row is the end state for now.
 *
 * `organizationId` is re-validated against the MonitoredUrl's actual
 * owner even though the caller (the BullMQ payload) already claims it,
 * because this function is the last line of defense before any data
 * gets written - never trust a tenant id carried on a job payload
 * without checking it against the row it's about to touch.
 */
export async function runMonitoringJob(
  payload: MonitoringJobPayload,
  deps: PipelineDeps = createDefaultPipelineDeps(),
): Promise<RunMonitoringJobResult> {
  const monitoredUrl = await deps.getMonitoredUrlForOrg(payload.organizationId, payload.monitoredUrlId);

  const job = payload.monitoringJobId
    ? await deps.markMonitoringJobRunning(payload.monitoringJobId)
    : await deps.createRunningMonitoringJob(monitoredUrl.organizationId, monitoredUrl.id);

  /**
   * Phase 2.1 addition: once the job row is RUNNING, everything below
   * must end in a terminal state - COMPLETED or FAILED - or the row
   * (and the dashboard's poller watching it) is stuck forever.
   *
   * This is deliberately NOT how a fetch/verification failure is
   * handled: the extractor never throws for an HTTP error, a 403, a
   * timeout, or malformed content - it always resolves with an
   * ExtractionResult whose `errorMessage` field carries that failure,
   * and `persistMonitoringResult` turns that into a COMPLETED job with
   * a FAILED_TO_VERIFY snapshot attached (a successful job execution
   * that could not establish reliable page state). Reaching this catch
   * means the job's own execution broke unexpectedly - an extractor bug,
   * a Postgres error mid-transaction, an out-of-memory error, etc - so
   * there is no Snapshot for this attempt. Marking the job FAILED here
   * (rather than leaving it RUNNING) and rethrowing keeps that
   * distinction intact while still letting BullMQ's own retry/backoff
   * and 'failed' event see the real error.
   */
  try {
    const priorSnapshot = await deps.getLatestVerifiedSnapshot(monitoredUrl.id);
    const prior: PriorSnapshotData | null = priorSnapshot
      ? {
          extractorVersion: priorSnapshot.extractorVersion ?? 1,
          contentHash: priorSnapshot.contentHash,
          structuredDataHash: priorSnapshot.structuredDataHash,
          normalizedContent: priorSnapshot.normalizedContent,
          entities: toCoreEntities(priorSnapshot.extractedEntities),
        }
      : null;

    // Conditional request (Phase 29 B3b): only when there is a verified snapshot to fall back on,
    // the validators are fresh enough, and this is a scheduled scan - a customer who clicks "Scan
    // now" (the payload carries the job id the API created) always gets a full fetch.
    const validatorsFresh =
      monitoredUrl.validatorsSetAt != null && Date.now() - monitoredUrl.validatorsSetAt.getTime() < conditionalMaxAgeMs();
    const useConditional =
      !payload.monitoringJobId &&
      priorSnapshot != null &&
      // A 304 writes no snapshot, so it must never answer for a snapshot from an older extractor: the
      // new baseline has to be taken with a full fetch first.
      (priorSnapshot.extractorVersion ?? 1) === EXTRACTOR_VERSION &&
      validatorsFresh && Boolean(monitoredUrl.etag || monitoredUrl.lastModifiedHeader);

    const extraction = await deps.extractor.extract({
      url: monitoredUrl.url,
      ...(useConditional ? { conditional: { etag: monitoredUrl.etag ?? null, lastModified: monitoredUrl.lastModifiedHeader ?? null } } : {}),
    });

    if (extraction.notModified) {
      await deps.persistNotModifiedResult(job.id, {
        organizationId: monitoredUrl.organizationId,
        monitoredUrlId: monitoredUrl.id,
        extraction,
        usage: { browserEscalated: false, aiCallMade: false },
      });
      return { monitoringJobId: job.id, verificationState: "NO_CHANGE", changeEventCount: 0 };
    }

    const comparison = compareSnapshots(prior, {
      extractorVersion: extraction.extractorVersion,
      httpStatus: extraction.httpStatus,
      errorMessage: extraction.errorMessage,
      contentHash: extraction.contentHash,
      structuredDataHash: extraction.structuredDataHash,
      normalizedContent: extraction.normalizedContent,
      entities: extraction.extractedEntities,
    });

    await deps.persistMonitoringResult(job.id, {
      organizationId: monitoredUrl.organizationId,
      monitoredUrlId: monitoredUrl.id,
      previousSnapshotId: priorSnapshot?.id ?? null,
      extraction,
      comparison,
      // Phase 1 never escalates to a browser or calls the AI layer.
      usage: { browserEscalated: false, aiCallMade: false },
    });

    return {
      monitoringJobId: job.id,
      verificationState: comparison.verificationState,
      changeEventCount: comparison.changeEvents.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: if even this update fails (e.g. Postgres just went
    // down), the original error is still what's thrown below and is
    // what BullMQ's retry/backoff and 'failed' event act on.
    await deps.markMonitoringJobFailed(job.id, message).catch(() => undefined);
    throw err;
  }
}
