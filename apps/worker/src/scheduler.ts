import { listDueMonitoredUrls, listOrganizationsForDailyReportScheduling } from "@cma/db";
import { createMonitoringQueue, createDailyReportQueue, createRedisConnection } from "@cma/queue";
import { enqueueDueMonitoringJobs, type EnqueueAllDeps } from "./enqueueAll.js";
import { enqueueDailyReportJobs, type EnqueueDailyReportsDeps } from "./enqueueDailyReports.js";
import { pathToFileURL } from "node:url";

/**
 * Phase 26 - "real monitoring continuity at controlled cost."
 *
 * DevRunbook.md and Phase 4/Phase 25 are explicit and repeated: this
 * project deliberately does NOT build a cron-expression scheduler or
 * per-organization schedule customization (Phase 4 Section 11). The
 * intended production trigger for `enqueueDueMonitoringJobs` /
 * `enqueueDailyReportJobs` is a plain OS cron entry or a K8s CronJob
 * calling `npm run worker:enqueue` / `npm run worker:enqueue-reports`
 * (DevRunbook.md Section 4) - infrastructure this repo has never
 * needed to contain, because most deployment targets already have one.
 *
 * This file is NOT a replacement for that. It is the smallest possible
 * in-process substitute for environments where no external cron/K8s is
 * available (local development, and this repo's own dogfood
 * environment) so that recurring observation can actually run
 * continuously instead of only when a human remembers to run
 * `npm run worker:enqueue` by hand. It contains no cron-expression
 * parsing and no per-organization schedule configuration - it is a
 * fixed-interval loop over the exact same enqueue functions the
 * documented cron/K8s path already calls, nothing more.
 *
 * COST GUARANTEE: this scheduler only ever calls
 * `enqueueDueMonitoringJobs` (adds to the monitoring queue) and
 * `enqueueDailyReportJobs` (adds to the daily-report queue). Neither
 * queue's processor (apps/worker/src/pipeline.ts,
 * apps/worker/src/reportPipeline.ts) calls an AI provider anywhere in
 * its code path - AI analysis and Digest AI interpretation are only
 * ever enqueued by an explicit, user-initiated POST from apps/web (see
 * apps/web/src/app/api/change-events/[changeEventId]/analysis/route.ts
 * and apps/web/src/app/api/digest/interpretation/route.ts). This
 * scheduler process therefore cannot cause a single OpenAI call, no
 * matter how long it runs or how many competitors are monitored.
 */

const DEFAULT_MONITORING_INTERVAL_MS = 15 * 60_000; // 15 minutes - matches DevRunbook.md's own example cadence
const DEFAULT_DAILY_REPORT_INTERVAL_MS = 60 * 60_000; // 1 hour - cheap to re-check; jobId dedup makes re-checks a safe no-op

function readIntervalMs(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface SchedulerDeps {
  monitoring: EnqueueAllDeps;
  dailyReports: EnqueueDailyReportsDeps;
  monitoringIntervalMs: number;
  dailyReportIntervalMs: number;
  /** Injectable so tests can drive ticks deterministically without waiting on real timers. */
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/**
 * A single shared Redis connection and pair of BullMQ Queue instances
 * for the whole scheduler process lifetime - NOT re-created every tick
 * (creating a fresh Redis connection every 15 minutes forever would be
 * wasteful and, over enough ticks, exhaust connections for no reason).
 * Call `close()` once, on process shutdown.
 */
export function createDefaultSchedulerDeps(): { deps: SchedulerDeps; close: () => Promise<void> } {
  const connection = createRedisConnection();
  const monitoringQueue = createMonitoringQueue(connection);
  const dailyReportQueue = createDailyReportQueue(connection);

  const deps: SchedulerDeps = {
    monitoring: {
      listDueMonitoredUrls,
      createMonitoringQueue: () => ({ add: monitoringQueue.add.bind(monitoringQueue), close: async () => undefined }),
    },
    dailyReports: {
      listOrganizationsForDailyReportScheduling,
      createDailyReportQueue: () => ({ add: dailyReportQueue.add.bind(dailyReportQueue), close: async () => undefined }),
    },
    monitoringIntervalMs: readIntervalMs("CMA_SCHEDULER_MONITORING_INTERVAL_MS", DEFAULT_MONITORING_INTERVAL_MS),
    dailyReportIntervalMs: readIntervalMs("CMA_SCHEDULER_DAILY_REPORT_INTERVAL_MS", DEFAULT_DAILY_REPORT_INTERVAL_MS),
    setInterval,
    clearInterval,
  };

  return {
    deps,
    close: async () => {
      await Promise.all([monitoringQueue.close(), dailyReportQueue.close()]);
      connection.disconnect();
    },
  };
}

/**
 * Overlap guard: if a tick is still running (e.g. Postgres is slow, or
 * there are many due URLs) when the next interval fires, the new tick
 * is skipped rather than starting a second concurrent enqueue pass -
 * `listDueMonitoredUrls`/BullMQ jobId dedup already make a second pass
 * safe, but skipping is still strictly better (no wasted DB round-trip,
 * no log noise) and keeps tick semantics simple to reason about.
 */
function guardOverlap(label: string, running: { current: boolean }, fn: () => Promise<void>): () => void {
  return () => {
    if (running.current) {
      console.log(`[scheduler] ${label} tick skipped - previous tick still running`);
      return;
    }
    running.current = true;
    fn()
      .catch((err) => {
        console.error(`[scheduler] ${label} tick failed:`, err);
      })
      .finally(() => {
        running.current = false;
      });
  };
}

export interface SchedulerHandle {
  stop: () => void;
  runMonitoringTickNow: () => Promise<void>;
  runDailyReportTickNow: () => Promise<void>;
}

/**
 * Starts two independent interval loops (monitoring enqueue, daily
 * report enqueue) and returns a handle to stop them. Runs one
 * monitoring tick immediately on start (Phase 26's actual goal:
 * accumulate real observations as soon as the scheduler is up, not
 * only after the first interval elapses) - the daily-report tick does
 * NOT run immediately, since re-checking "is a report due today" the
 * instant the process boots (possibly mid-development, many times a
 * day) has no benefit over waiting for the first interval.
 */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const monitoringRunning = { current: false };
  const dailyReportRunning = { current: false };

  const runMonitoringTick = async () => {
    const result = await enqueueDueMonitoringJobs(deps.monitoring);
    console.log(
      `[scheduler] monitoring tick: ${result.enqueuedCount}/${result.candidateCount} due URL(s) enqueued (0 AI calls - monitoring never calls AI)`,
    );
  };

  const runDailyReportTick = async () => {
    const result = await enqueueDailyReportJobs(deps.dailyReports);
    console.log(`[scheduler] daily-report tick: ${result.enqueuedCount}/${result.organizationCount} organization(s) enqueued`);
  };

  const monitoringTickGuarded = guardOverlap("monitoring", monitoringRunning, runMonitoringTick);
  const dailyReportTickGuarded = guardOverlap("daily-report", dailyReportRunning, runDailyReportTick);

  const monitoringHandle = deps.setInterval(monitoringTickGuarded, deps.monitoringIntervalMs);
  const dailyReportHandle = deps.setInterval(dailyReportTickGuarded, deps.dailyReportIntervalMs);

  console.log(
    `[scheduler] started - monitoring every ${deps.monitoringIntervalMs}ms, daily reports every ${deps.dailyReportIntervalMs}ms`,
  );

  // Run the first monitoring tick immediately rather than waiting a full interval.
  monitoringTickGuarded();

  return {
    stop: () => {
      deps.clearInterval(monitoringHandle);
      deps.clearInterval(dailyReportHandle);
    },
    runMonitoringTickNow: runMonitoringTick,
    runDailyReportTickNow: runDailyReportTick,
  };
}

async function main() {
  const { deps, close } = createDefaultSchedulerDeps();
  const handle = startScheduler(deps);

  const shutdown = async () => {
    handle.stop();
    await close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// See enqueueAll.ts's matching guard for why pathToFileURL is required
// here instead of a raw `file://${...}` template (Windows path mismatch).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[scheduler] failed to start:", err);
    process.exit(1);
  });
}
