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

  it("delays the second and later jobs for the same host, but not other hosts", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      listDueMonitoredUrls: vi.fn().mockResolvedValue([
        { id: "u1", organizationId: "o", url: "https://rival.test/pricing" },
        { id: "u2", organizationId: "o", url: "https://rival.test/plans" },
        { id: "u3", organizationId: "o", url: "https://other.test/pricing" },
      ]),
      createMonitoringQueue: () => ({ add, close: vi.fn().mockResolvedValue(undefined) }),
      hostSpacing: { spacingMs: 30_000, jitterMs: 0 },
    });

    await enqueueDueMonitoringJobs(deps);

    expect(add.mock.calls[0]?.[2]).not.toHaveProperty("delay");
    expect(add.mock.calls[1]?.[2]).toMatchObject({ delay: 30_000 });
    expect(add.mock.calls[2]?.[2]).not.toHaveProperty("delay");
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
