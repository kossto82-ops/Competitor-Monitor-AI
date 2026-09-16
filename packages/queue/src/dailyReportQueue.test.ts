import { describe, expect, it } from "vitest";
import { dailyReportJobId } from "./dailyReportQueue.js";

describe("dailyReportJobId", () => {
  it("is deterministic for the same (organization, reportDate, timezone)", () => {
    expect(dailyReportJobId("org-1", "2026-09-16", "UTC")).toBe(dailyReportJobId("org-1", "2026-09-16", "UTC"));
  });

  it("differs across organizations", () => {
    expect(dailyReportJobId("org-1", "2026-09-16", "UTC")).not.toBe(dailyReportJobId("org-2", "2026-09-16", "UTC"));
  });

  it("differs across report dates - so a duplicate scheduler tick for the SAME day dedupes, but a new day always gets a fresh job", () => {
    expect(dailyReportJobId("org-1", "2026-09-16", "UTC")).not.toBe(dailyReportJobId("org-1", "2026-09-17", "UTC"));
  });

  it("differs across timezones", () => {
    expect(dailyReportJobId("org-1", "2026-09-16", "UTC")).not.toBe(dailyReportJobId("org-1", "2026-09-16", "Europe/Berlin"));
  });

  it("never contains ':' - BullMQ rejects custom job ids containing it", () => {
    expect(dailyReportJobId("org-1", "2026-09-16", "Europe/Berlin")).not.toContain(":");
  });
});
