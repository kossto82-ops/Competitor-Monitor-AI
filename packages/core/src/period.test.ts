import { describe, expect, it } from "vitest";
import { calculatePeriodDelta, resolveComparisonWindow } from "./period.js";

describe("resolveComparisonWindow", () => {
  it("computes a rolling N-day current window ending at `now`", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    const window = resolveComparisonWindow(30, "UTC", now);

    expect(window.currentEnd).toEqual(now);
    expect(window.currentStart.toISOString()).toBe("2026-08-17T12:00:00.000Z");
  });

  it("computes the previous period as the immediately preceding equal-length window, with no gap or overlap", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    const window = resolveComparisonWindow(30, "UTC", now);

    // previousEnd must equal currentStart exactly - a ChangeEvent detected
    // at that exact instant belongs to "current", never counted twice or
    // dropped in the gap between the two windows.
    expect(window.previousEnd).toEqual(window.currentStart);
    expect(window.previousStart.toISOString()).toBe("2026-07-18T12:00:00.000Z");
  });

  it("supports 7 and 90 day windows with the same relationship", () => {
    const now = new Date("2026-09-16T00:00:00.000Z");
    for (const days of [7, 90]) {
      const window = resolveComparisonWindow(days, "UTC", now);
      const spanMs = days * 24 * 60 * 60 * 1000;
      expect(window.currentEnd.getTime() - window.currentStart.getTime()).toBe(spanMs);
      expect(window.previousEnd.getTime() - window.previousStart.getTime()).toBe(spanMs);
      expect(window.previousEnd.getTime()).toBe(window.currentStart.getTime());
    }
  });

  it("rejects a non-positive or non-integer days value", () => {
    expect(() => resolveComparisonWindow(0)).toThrow(/positive integer/);
    expect(() => resolveComparisonWindow(-5)).toThrow(/positive integer/);
    expect(() => resolveComparisonWindow(2.5)).toThrow(/positive integer/);
  });

  it("normalizes an invalid timezone to UTC rather than throwing", () => {
    const window = resolveComparisonWindow(7, "Not/A_Real_Zone");
    expect(window.timezone).toBe("UTC");
  });

  it("defaults to UTC when no timezone is given", () => {
    const window = resolveComparisonWindow(7, null);
    expect(window.timezone).toBe("UTC");
  });

  it("is a rolling window unaffected by DST transitions in the given timezone (it operates on UTC instants)", () => {
    // 2026-10-25 is the day of the DST-end transition for Europe/Berlin
    // (clocks go back at 03:00 -> 02:00 local). A rolling 7-day window
    // must still span exactly 7*24h in UTC instants regardless.
    const now = new Date("2026-10-28T12:00:00.000Z");
    const window = resolveComparisonWindow(7, "Europe/Berlin", now);
    expect(window.currentEnd.getTime() - window.currentStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("calculatePeriodDelta", () => {
  it("computes absolute and percentage change for a normal increase", () => {
    const delta = calculatePeriodDelta(8, 5);
    expect(delta.absoluteChange).toBe(3);
    expect(delta.percentageChange).toBe(60);
  });

  it("computes a negative change", () => {
    const delta = calculatePeriodDelta(2, 8);
    expect(delta.absoluteChange).toBe(-6);
    expect(delta.percentageChange).toBe(-75);
  });

  it("returns null percentageChange (never Infinity) when the previous period was zero", () => {
    const delta = calculatePeriodDelta(4, 0);
    expect(delta.absoluteChange).toBe(4);
    expect(delta.percentageChange).toBeNull();
  });

  it("handles zero vs zero (no activity in either period)", () => {
    const delta = calculatePeriodDelta(0, 0);
    expect(delta.absoluteChange).toBe(0);
    expect(delta.percentageChange).toBeNull();
  });

  it("handles current dropping to zero from a nonzero previous", () => {
    const delta = calculatePeriodDelta(0, 5);
    expect(delta.absoluteChange).toBe(-5);
    expect(delta.percentageChange).toBe(-100);
  });
});
