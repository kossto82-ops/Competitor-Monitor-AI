import { describe, expect, it } from "vitest";
import { currentReportDateInTimezone, normalizeOrgTimezone, parseReportDate, resolveOrgLocalDayWindow } from "./reportWindow.js";

describe("normalizeOrgTimezone", () => {
  it("returns UTC for null/undefined/blank", () => {
    expect(normalizeOrgTimezone(null)).toBe("UTC");
    expect(normalizeOrgTimezone(undefined)).toBe("UTC");
    expect(normalizeOrgTimezone("   ")).toBe("UTC");
  });

  it("returns UTC for an unrecognized IANA name rather than throwing (Section 3: safe explicit default)", () => {
    expect(normalizeOrgTimezone("Not/A_Real_Zone")).toBe("UTC");
  });

  it("passes through a valid IANA zone unchanged", () => {
    expect(normalizeOrgTimezone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(normalizeOrgTimezone("America/New_York")).toBe("America/New_York");
  });
});

describe("parseReportDate", () => {
  it("parses a well-formed date", () => {
    expect(parseReportDate("2026-09-16")).toEqual({ year: 2026, month: 9, day: 16 });
  });

  it("rejects a malformed date", () => {
    expect(() => parseReportDate("16-09-2026")).toThrow(/Invalid reportDate/);
    expect(() => parseReportDate("2026-9-16")).toThrow(/Invalid reportDate/);
    expect(() => parseReportDate("not-a-date")).toThrow(/Invalid reportDate/);
  });
});

describe("resolveOrgLocalDayWindow", () => {
  it("for UTC, the window is exactly the UTC calendar day", () => {
    const window = resolveOrgLocalDayWindow("2026-09-16", "UTC");
    expect(window.startUtc.toISOString()).toBe("2026-09-16T00:00:00.000Z");
    expect(window.endUtc.toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });

  it("for a positive-offset zone (CEST, UTC+2 in September), local midnight is the previous UTC day", () => {
    const window = resolveOrgLocalDayWindow("2026-09-16", "Europe/Berlin");
    expect(window.startUtc.toISOString()).toBe("2026-09-15T22:00:00.000Z");
    expect(window.endUtc.toISOString()).toBe("2026-09-16T22:00:00.000Z");
  });

  it("for a negative-offset zone (EDT, UTC-4 in September), local midnight is later the same UTC day", () => {
    const window = resolveOrgLocalDayWindow("2026-09-16", "America/New_York");
    expect(window.startUtc.toISOString()).toBe("2026-09-16T04:00:00.000Z");
    expect(window.endUtc.toISOString()).toBe("2026-09-17T04:00:00.000Z");
  });

  it("handles a month rollover correctly (last day of the month)", () => {
    const window = resolveOrgLocalDayWindow("2026-09-30", "Europe/Berlin");
    expect(window.startUtc.toISOString()).toBe("2026-09-29T22:00:00.000Z");
    expect(window.endUtc.toISOString()).toBe("2026-09-30T22:00:00.000Z");
  });

  it("handles a year rollover correctly (Dec 31 -> Jan 1)", () => {
    const window = resolveOrgLocalDayWindow("2026-12-31", "UTC");
    expect(window.startUtc.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(window.endUtc.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("spans a DST transition correctly - Europe/Berlin's fall-back on 2026-10-25 makes that local day 25 hours long", () => {
    // 2026-10-25 02:00 CEST -> 03:00 CEST becomes 02:00 CET (clocks go back 1h at 03:00 CEST).
    const window = resolveOrgLocalDayWindow("2026-10-25", "Europe/Berlin");
    const spanHours = (window.endUtc.getTime() - window.startUtc.getTime()) / (60 * 60 * 1000);
    expect(spanHours).toBe(25);
  });

  it("normalizes an invalid/missing timezone to UTC instead of throwing", () => {
    const window = resolveOrgLocalDayWindow("2026-09-16", null);
    expect(window.timezone).toBe("UTC");
    expect(window.startUtc.toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  it("rejects a malformed reportDate", () => {
    expect(() => resolveOrgLocalDayWindow("garbage", "UTC")).toThrow(/Invalid reportDate/);
  });
});

describe("currentReportDateInTimezone", () => {
  it("formats as YYYY-MM-DD in the given timezone", () => {
    // 2026-09-16T23:30:00Z is already 2026-09-17 in Europe/Berlin (UTC+2).
    const now = new Date("2026-09-16T23:30:00.000Z");
    expect(currentReportDateInTimezone("UTC", now)).toBe("2026-09-16");
    expect(currentReportDateInTimezone("Europe/Berlin", now)).toBe("2026-09-17");
  });
});
