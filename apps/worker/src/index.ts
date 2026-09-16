import {
  createMonitoringWorker,
  createAiAnalysisWorker,
  createDailyReportWorker,
  createDigestInterpretationWorker,
  type MonitoringJobPayload,
  type AiAnalysisJobPayload,
  type DailyReportJobPayload,
  type DigestInterpretationJobPayload,
} from "@cma/queue";
import {
  getMonitoringJobForOrg,
  markMonitoringJobFailed,
  getAiAnalysisForOrg,
  markAiAnalysisFailed,
  markReportFailed,
  getOrCreateReportPeriod,
  getDigestAiInterpretationForOrgOrThrow,
  markDigestAiInterpretationFailed,
} from "@cma/db";
import type { Job } from "bullmq";
import { runMonitoringJob } from "./pipeline.js";
import { runAiAnalysisJob } from "./aiPipeline.js";
import { generateDailyReportJob } from "./reportPipeline.js";
import { runDigestInterpretationJob } from "./digestInterpretationPipeline.js";

const worker = createMonitoringWorker(async (job: Job<MonitoringJobPayload>) => {
  const result = await runMonitoringJob(job.data);
  console.log(
    `[worker] job=${job.id} monitoredUrlId=${job.data.monitoredUrlId} ` +
      `state=${result.verificationState} changeEvents=${result.changeEventCount}`,
  );
  return result;
});

worker.on("failed", (job, err) => {
  console.error(`[worker] job=${job?.id} FAILED:`, err.message);

  /**
   * Phase 2.1 hardening (Section 6): defense-in-depth beyond
   * runMonitoringJob's own try/catch (apps/worker/src/pipeline.ts),
   * which only runs if the pipeline gets a chance to throw. A worker
   * process crash mid-job, or BullMQ's own "stalled job" detection
   * exhausting its retry budget (the worker died, its lock expired, and
   * no processor invocation ever ran to completion or threw), reaches
   * this event WITHOUT ever running that try/catch - so the
   * MonitoringJob row could otherwise stay RUNNING forever. Only
   * possible for the manual-scan path, which threads a stable
   * monitoringJobId through the payload; the cron-style enqueueAll path
   * has no pre-created row to identify here (see Phase 2.1 hardening
   * report's "Remaining risks").
   */
  const monitoringJobId = job?.data?.monitoringJobId;
  const organizationId = job?.data?.organizationId;
  if (!monitoringJobId || !organizationId) return;

  getMonitoringJobForOrg(organizationId, monitoringJobId)
    .then((current) => {
      if (current && current.status !== "COMPLETED" && current.status !== "FAILED") {
        return markMonitoringJobFailed(monitoringJobId, err.message);
      }
      return undefined;
    })
    .catch((markErr: unknown) => {
      console.error(`[worker] failed to mark MonitoringJob ${monitoringJobId} as FAILED after job failure:`, markErr);
    });
});

const aiWorker = createAiAnalysisWorker(async (job: Job<AiAnalysisJobPayload>) => {
  const result = await runAiAnalysisJob(job.data);
  console.log(`[ai-worker] job=${job.id} changeEventId=${job.data.changeEventId} status=${result.status}`);
  return result;
});

/**
 * Same defense-in-depth as the monitoring worker's 'failed' handler
 * above: a worker crash mid-job or a BullMQ stalled-job timeout can
 * reach here without runAiAnalysisJob's own try/catch ever running,
 * which would otherwise leave the AiAnalysis row stuck RUNNING
 * forever (Section 9's "do not leave analyses indefinitely stuck").
 */
aiWorker.on("failed", (job, err) => {
  console.error(`[ai-worker] job=${job?.id} FAILED:`, err.message);

  const aiAnalysisId = job?.data?.aiAnalysisId;
  const organizationId = job?.data?.organizationId;
  if (!aiAnalysisId || !organizationId) return;

  getAiAnalysisForOrg(organizationId, aiAnalysisId)
    .then((current) => {
      if (current.status !== "COMPLETED" && current.status !== "FAILED") {
        return markAiAnalysisFailed(aiAnalysisId, err.message);
      }
      return undefined;
    })
    .catch((markErr: unknown) => {
      console.error(`[ai-worker] failed to mark AiAnalysis ${aiAnalysisId} as FAILED after job failure:`, markErr);
    });
});

const reportWorker = createDailyReportWorker(async (job: Job<DailyReportJobPayload>) => {
  const result = await generateDailyReportJob(job.data);
  console.log(
    `[report-worker] job=${job.id} organizationId=${job.data.organizationId} reportDate=${job.data.reportDate} ` +
      `status=${result.status} changes=${result.changeCount} email=${result.emailOutcome}`,
  );
  return result;
});

/**
 * Same defense-in-depth as the other two workers' 'failed' handlers: a
 * worker crash mid-job or a BullMQ stalled-job timeout can reach here
 * without generateDailyReportJob's own try/catch (in
 * reportPipeline.ts's ensureReportGenerated) ever running, which would
 * otherwise leave the Report row stuck GENERATING forever - the
 * dashboard/history views would then show a report that never finishes.
 * Deliberately reads the Report's CURRENT status first rather than
 * blindly marking it FAILED - it may have already reached COMPLETED (the
 * generation step succeeded and only the email step, or the event-loop
 * teardown itself, is what crashed).
 */
reportWorker.on("failed", (job, err) => {
  console.error(`[report-worker] job=${job?.id} FAILED:`, err.message);

  const organizationId = job?.data?.organizationId;
  const reportDate = job?.data?.reportDate;
  const timezone = job?.data?.timezone;
  if (!organizationId || !reportDate || !timezone) return;

  getOrCreateReportPeriod(organizationId, reportDate, timezone)
    .then((current) => {
      if (current.status !== "COMPLETED" && current.status !== "FAILED") {
        return markReportFailed(current.id, err.message);
      }
      return undefined;
    })
    .catch((markErr: unknown) => {
      console.error(`[report-worker] failed to mark report FAILED after job failure (org=${organizationId}):`, markErr);
    });
});

const digestInterpretationWorker = createDigestInterpretationWorker(async (job: Job<DigestInterpretationJobPayload>) => {
  const result = await runDigestInterpretationJob(job.data);
  console.log(
    `[digest-interpretation-worker] job=${job.id} organizationId=${job.data.organizationId} days=${job.data.days} status=${result.status}`,
  );
  return result;
});

/**
 * Same defense-in-depth as the other three workers' 'failed' handlers: a
 * worker crash mid-job or a BullMQ stalled-job timeout can reach here
 * without runDigestInterpretationJob's own try/catch ever running, which
 * would otherwise leave the DigestAiInterpretation row stuck RUNNING
 * forever - the /digest UI would then poll indefinitely for a result
 * that will never arrive.
 */
digestInterpretationWorker.on("failed", (job, err) => {
  console.error(`[digest-interpretation-worker] job=${job?.id} FAILED:`, err.message);

  const digestAiInterpretationId = job?.data?.digestAiInterpretationId;
  const organizationId = job?.data?.organizationId;
  if (!digestAiInterpretationId || !organizationId) return;

  getDigestAiInterpretationForOrgOrThrow(organizationId, digestAiInterpretationId)
    .then((current) => {
      if (current.status !== "COMPLETED" && current.status !== "FAILED") {
        return markDigestAiInterpretationFailed(digestAiInterpretationId, err.message);
      }
      return undefined;
    })
    .catch((markErr: unknown) => {
      console.error(
        `[digest-interpretation-worker] failed to mark DigestAiInterpretation ${digestAiInterpretationId} as FAILED after job failure:`,
        markErr,
      );
    });
});

console.log("[worker] listening for monitoring jobs...");
console.log("[ai-worker] listening for AI analysis jobs...");
console.log("[report-worker] listening for daily report jobs...");
console.log("[digest-interpretation-worker] listening for digest interpretation jobs...");

process.on("SIGTERM", async () => {
  await Promise.all([worker.close(), aiWorker.close(), reportWorker.close(), digestInterpretationWorker.close()]);
  process.exit(0);
});
