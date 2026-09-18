import { describe, expect, it, vi } from "vitest";
import { enqueueDueMonitoringJobs, type EnqueueAllDeps } from "./enqueueAll.js";

function makeDeps(overrides: Partial<EnqueueAllDeps> = {}): EnqueueAllDeps {
  const add = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    listDueMonitoredUrls: vi.fn().mockResolvedValue([]),
    createMonitoringQueue: () => ({ add, close }),
    ...overrides,
  };
}

describe("enqueueDueMonitoringJobs", () => {
  it("enqueues one job per due URL and closes the queue", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      listDueMonitoredUrls: vi.fn().mockResolvedValue([
        { id: "url-1", organizationId: "org-1" },
        { id: "url-2", organizationId: "org-1" },
      ]),
      createMonitoringQueue: () => ({ add, close }),
    });

    const result = await enqueueDueMonitoringJobs(deps);

    expect(result).toEqual({ candidateCount: 2, enqueuedCount: 2 });
    expect(add).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports zero enqueued when nothing is due, without touching the queue", async () => {
    const deps = makeDeps();
    const result = await enqueueDueMonitoringJobs(deps);
    expect(result).toEqual({ candidateCount: 0, enqueuedCount: 0 });
  });

  it("closes the queue even if an add() call throws", async () => {
    const add = vi.fn().mockRejectedValue(new Error("boom"));
    const close = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      listDueMonitoredUrls: vi.fn().mockResolvedValue([{ id: "url-1", organizationId: "org-1" }]),
      createMonitoringQueue: () => ({ add, close }),
    });

    await expect(enqueueDueMonitoringJobs(deps)).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
