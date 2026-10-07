import { deriveSourceHealth, type SourceHealth } from "@cma/core";
import { prisma } from "../client.js";

export interface SourceHealthRow {
  id: string;
  url: string;
  label: string | null;
  competitorId: string;
  competitorName: string;
  competitorIsActive: boolean;
  scanFrequencyMinutes: number;
  lastSuccessfulScanAt: Date | null;
  lastAttemptAt: Date | null;
  consecutiveFailureCount: number;
  disabledAt: Date | null;
  health: SourceHealth;
}

/** Phase 29 B4: every monitored source of the organization with its derived health (tenant-scoped). */
export async function listSourceHealthForOrg(organizationId: string, now: Date = new Date()): Promise<SourceHealthRow[]> {
  const urls = await prisma.monitoredUrl.findMany({
    where: { organizationId },
    include: { competitor: { select: { id: true, name: true, isActive: true } } },
    orderBy: { createdAt: "asc" },
  });
  return urls.map((u) => ({
    id: u.id,
    url: u.url,
    label: u.label,
    competitorId: u.competitor.id,
    competitorName: u.competitor.name,
    competitorIsActive: u.competitor.isActive,
    scanFrequencyMinutes: u.scanFrequencyMinutes,
    lastSuccessfulScanAt: u.lastSuccessfulScanAt,
    lastAttemptAt: u.lastAttemptAt,
    consecutiveFailureCount: u.consecutiveFailureCount,
    disabledAt: u.disabledAt,
    health: deriveSourceHealth(u, now),
  }));
}

export interface SourceAlert {
  sourceId: string;
  competitorName: string;
  label: string | null;
  url: string;
  state: "STALE" | "DISABLED";
  reason: string;
}

/**
 * The sources that need the customer's attention: stopped automatically, or stale. A merely
 * failing source (DEGRADED) is not an alert - it is usually transient and would be noise - and a
 * source the customer paused, or whose competitor is deactivated, is deliberate.
 */
export async function listSourcesNeedingAttention(organizationId: string, now: Date = new Date()): Promise<SourceAlert[]> {
  const rows = await listSourceHealthForOrg(organizationId, now);
  const alerts: SourceAlert[] = [];
  for (const row of rows) {
    if (!row.competitorIsActive) continue;
    if (row.health.state !== "STALE" && row.health.state !== "DISABLED") continue;
    alerts.push({
      sourceId: row.id,
      competitorName: row.competitorName,
      label: row.label,
      url: row.url,
      state: row.health.state,
      reason: row.health.reason,
    });
  }
  // Stopped sources first: they are not being monitored at all.
  return alerts.sort((a, b) => (a.state === b.state ? 0 : a.state === "DISABLED" ? -1 : 1));
}

export interface SweepOptions {
  /** A job RUNNING for longer than this lost its worker. */
  runningMaxMs: number;
  /** A job still PENDING after this never reached a worker (enqueue lost, Redis flushed). */
  pendingMaxMs: number;
}

export const DEFAULT_SWEEP: SweepOptions = { runningMaxMs: 15 * 60_000, pendingMaxMs: 2 * 60 * 60_000 };

export interface SweepResult {
  monitoringJobs: number;
  aiAnalyses: number;
  digestInterpretations: number;
}

/**
 * Phase 29 B4 (E24): marks jobs whose worker died as FAILED. Without this a row stuck in RUNNING
 * (the process was killed before BullMQ's 'failed' handler ran) blocks the Refresh button and the
 * dashboard poller forever. Deliberately NOT tenant-scoped (scheduler entry point). It only touches
 * rows still in PENDING/RUNNING, and the AI "mark running/completed" helpers only act on rows that
 * are not yet terminal, so a straggler job arriving later cannot overwrite the FAILED state. AI rows
 * are re-used (a refresh resets them to PENDING), so their PENDING age is measured from updatedAt,
 * not createdAt - otherwise a fresh refresh of an old row would be swept immediately.
 */
export async function sweepStuckJobs(now: Date = new Date(), options: SweepOptions = DEFAULT_SWEEP): Promise<SweepResult> {
  const runningCutoff = new Date(now.getTime() - options.runningMaxMs);
  const pendingCutoff = new Date(now.getTime() - options.pendingMaxMs);
  const finished = (message: string) => ({ status: "FAILED" as const, errorMessage: message });
  const runningMessage = "Timed out: the worker stopped before this job finished.";
  const pendingMessage = "Timed out: the job was never picked up by a worker.";

  const [mjRunning, mjPending, aiRunning, aiPending, diRunning, diPending] = await Promise.all([
    prisma.monitoringJob.updateMany({
      where: { status: "RUNNING", startedAt: { lt: runningCutoff } },
      data: { ...finished(runningMessage), finishedAt: now },
    }),
    prisma.monitoringJob.updateMany({
      where: { status: "PENDING", createdAt: { lt: pendingCutoff } },
      data: { ...finished(pendingMessage), finishedAt: now },
    }),
    prisma.aiAnalysis.updateMany({ where: { status: "RUNNING", startedAt: { lt: runningCutoff } }, data: finished(runningMessage) }),
    prisma.aiAnalysis.updateMany({ where: { status: "PENDING", updatedAt: { lt: pendingCutoff } }, data: finished(pendingMessage) }),
    prisma.digestAiInterpretation.updateMany({ where: { status: "RUNNING", startedAt: { lt: runningCutoff } }, data: finished(runningMessage) }),
    prisma.digestAiInterpretation.updateMany({ where: { status: "PENDING", updatedAt: { lt: pendingCutoff } }, data: finished(pendingMessage) }),
  ]);

  return {
    monitoringJobs: mjRunning.count + mjPending.count,
    aiAnalyses: aiRunning.count + aiPending.count,
    digestInterpretations: diRunning.count + diPending.count,
  };
}
