import { describe, expect, it, vi } from "vitest";
import { startScheduler, type SchedulerDeps } from "./scheduler.js";
import type { EnqueueAllDeps } from "./enqueueAll.js";
import type { EnqueueDailyReportsDeps } from "./enqueueDailyReports.js";

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeMonitoringDeps(due: { id: string; organizationId: string }[] = []): EnqueueAllDeps {
  const add = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    listDueMonitoredUrls: vi.fn().mockResolvedValue(due),
    createMonitoringQueue: () => ({ add, close }),
  };
}

function makeDailyReportDeps(orgs: { id: string; timezone: string }[] = []): EnqueueDailyReportsDeps {
  const add = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    listOrganizationsForDailyReportScheduling: vi.fn().mockResolvedValue(orgs),
    createDailyReportQueue: () => ({ add, close }),
  };
}

/** Captures the callbacks scheduler.ts registers, so tests can fire "ticks" deterministically without real timers. */
function makeFakeTimers() {
  const callbacks: (() => void)[] = [];
  const setInterval = vi.fn((fn: () => void) => {
    callbacks.push(fn);
    return callbacks.length as unknown as NodeJS.Timeout;
  });
  const clearInterval = vi.fn();
  return { setInterval: setInterval as unknown as typeof globalThis.setInterval, clearInterval: clearInterval as unknown as typeof globalThis.clearInterval, callbacks };
}

function makeSchedulerDeps(overrides: Partial<SchedulerDeps> = {}): { deps: SchedulerDeps; timers: ReturnType<typeof makeFakeTimers> } {
  const timers = makeFakeTimers();
  const deps: SchedulerDeps = {
    monitoring: makeMonitoringDeps(),
    dailyReports: makeDailyReportDeps(),
    monitoringIntervalMs: 1000,
    dailyReportIntervalMs: 2000,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ...overrides,
  };
  return { deps, timers };
}

describe("startScheduler", () => {
  it("runs an initial monitoring tick immediately on start (no daily-report tick until the first interval)", async () => {
    const monitoring = makeMonitoringDeps([{ id: "url-1", organizationId: "org-1" }]);
    const { deps } = makeSchedulerDeps({ monitoring });

    startScheduler(deps);
    await flush();

    expect(monitoring.listDueMonitoredUrls).toHaveBeenCalledTimes(1);
  });

  it("never enqueues to any AI queue - only monitoring and daily-report deps are reachable from the scheduler", () => {
    const { deps } = makeSchedulerDeps();
    // SchedulerDeps has exactly two dependency groups: monitoring and dailyReports.
    // Neither exposes any AI queue or AI provider - this is a structural guarantee,
    // not just a runtime observation: there is no code path in scheduler.ts that
    // could reach @cma/ai or createAiAnalysisQueue/createDigestInterpretationQueue.
    expect(Object.keys(deps).sort()).toEqual(
      ["clearInterval", "dailyReportIntervalMs", "dailyReports", "monitoring", "monitoringIntervalMs", "setInterval"].sort(),
    );
  });

  it("registers two independent interval loops with their own configured intervals", () => {
    const { deps, timers } = makeSchedulerDeps({ monitoringIntervalMs: 5000, dailyReportIntervalMs: 9000 });
    startScheduler(deps);

    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 9000);
  });

  it("skips a tick that fires while the previous tick of the same kind is still running", async () => {
    let resolveFirst: (() => void) | undefined;
    const listDueMonitoredUrls = vi.fn().mockImplementation(
      () =>
        new Promise<{ id: string; organizationId: string }[]>((resolve) => {
          resolveFirst = () => resolve([]);
        }),
    );
    const monitoring: EnqueueAllDeps = {
      listDueMonitoredUrls,
      createMonitoringQueue: () => ({ add: vi.fn(), close: vi.fn() }),
    };
    const { deps, timers } = makeSchedulerDeps({ monitoring });

    startScheduler(deps); // fires the immediate first tick, which never resolves yet
    await flush();
    expect(listDueMonitoredUrls).toHaveBeenCalledTimes(1);

    // Simulate the interval firing again while the first tick is still in flight.
    const monitoringTickCallback = timers.callbacks[0]!;
    monitoringTickCallback();
    await flush();
    expect(listDueMonitoredUrls).toHaveBeenCalledTimes(1); // still 1 - the overlapping tick was skipped

    resolveFirst?.();
    await flush();

    // Now that the first tick finished, a subsequent interval fire runs normally.
    monitoringTickCallback();
    await flush();
    expect(listDueMonitoredUrls).toHaveBeenCalledTimes(2);
  });

  it("stop() clears both interval handles", () => {
    const { deps, timers } = makeSchedulerDeps();
    const handle = startScheduler(deps);
    handle.stop();
    expect(timers.clearInterval).toHaveBeenCalledTimes(2);
  });

  it("runMonitoringTickNow/runDailyReportTickNow expose the same logic for manual/on-demand ticks", async () => {
    const monitoring = makeMonitoringDeps([{ id: "url-1", organizationId: "org-1" }]);
    const dailyReports = makeDailyReportDeps([{ id: "org-1", timezone: "Europe/Berlin" }]);
    const { deps } = makeSchedulerDeps({ monitoring, dailyReports });

    const handle = startScheduler(deps);
    await flush();

    await handle.runDailyReportTickNow();
    expect(dailyReports.listOrganizationsForDailyReportScheduling).toHaveBeenCalledTimes(1);
  });

  it("sweeps stuck jobs on each monitoring tick and keeps monitoring if the sweep fails", async () => {
    const sweep = vi.fn().mockResolvedValue({ monitoringJobs: 1, aiAnalyses: 2, digestInterpretations: 0 });
    const monitoring = makeMonitoringDeps([{ id: "url-1", organizationId: "org-1" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps } = makeSchedulerDeps({ monitoring, sweepStuckJobs: sweep });
    const handle = startScheduler(deps);
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("3 stuck job"));
    handle.stop();

    const failing = vi.fn().mockRejectedValue(new Error("db down"));
    const second = makeMonitoringDeps([{ id: "url-2", organizationId: "org-1" }]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps: deps2 } = makeSchedulerDeps({ monitoring: second, sweepStuckJobs: failing });
    const handle2 = startScheduler(deps2);
    await flush();
    expect(second.listDueMonitoredUrls).toHaveBeenCalled();
    handle2.stop();
    warn.mockRestore();
    errors.mockRestore();
  });

  it("stops unreachable sources before enqueueing, and keeps monitoring if that pass fails", async () => {
    const disable = vi.fn().mockResolvedValue([{ id: "url-9", url: "https://dead.test" }]);
    const monitoring = makeMonitoringDeps([{ id: "url-1", organizationId: "org-1" }]);
    const { deps } = makeSchedulerDeps({ monitoring, disableUnreachableSources: disable });
    const handle = startScheduler(deps);
    await flush();
    expect(disable).toHaveBeenCalledTimes(1);
    expect(monitoring.listDueMonitoredUrls).toHaveBeenCalled();

    const failing = vi.fn().mockRejectedValue(new Error("db down"));
    const second = makeMonitoringDeps([{ id: "url-2", organizationId: "org-1" }]);
    const { deps: deps2 } = makeSchedulerDeps({ monitoring: second, disableUnreachableSources: failing });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle2 = startScheduler(deps2);
    await flush();
    expect(second.listDueMonitoredUrls).toHaveBeenCalled();
    errors.mockRestore();
    handle.stop();
    handle2.stop();
  });
});
