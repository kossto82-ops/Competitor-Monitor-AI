import { describe, expect, it, vi } from "vitest";
import { enqueueDailyReportJobs, type EnqueueDailyReportsDeps } from "./enqueueDailyReports.js";

function makeDeps(overrides: Partial<EnqueueDailyReportsDeps> = {}): EnqueueDailyReportsDeps {
  const add = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    listOrganizationsForDailyReportScheduling: vi.fn().mockResolvedValue([]),
    createDailyReportQueue: () => ({ add, close }),
    ...overrides,
  };
}

describe("enqueueDailyReportJobs", () => {
  it("enqueues one job per scheduled organization and closes the queue", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      listOrganizationsForDailyReportScheduling: vi.fn().mockResolvedValue([
        { id: "org-1", timezone: "Europe/Berlin" },
        { id: "org-2", timezone: "America/New_York" },
      ]),
      createDailyReportQueue: () => ({ add, close }),
    });

    const result = await enqueueDailyReportJobs(deps);

    expect(result).toEqual({ organizationCount: 2, enqueuedCount: 2 });
    expect(add).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports zero enqueued when no organization has daily reports enabled", async () => {
    const result = await enqueueDailyReportJobs(makeDeps());
    expect(result).toEqual({ organizationCount: 0, enqueuedCount: 0 });
  });
});
