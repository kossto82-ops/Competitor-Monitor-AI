import { describe, expect, it } from "vitest";
import { ALERT_LEVELS, MARKET_PATTERN_KINDS, SIGNAL_KINDS } from "@cma/core";
import { ALERT_LEVEL_DISPLAY, confidenceLabel, patternKindLabel, pointsBarPercent, quietDaySummary, signalKindLabel, TIER_DISPLAY } from "./alertDisplay";

describe("alert and signal display (Phase 29 D5)", () => {
  it("has a label, a colour and a meaning for every alert level and tier", () => {
    for (const level of ALERT_LEVELS) {
      expect(ALERT_LEVEL_DISPLAY[level].label.length).toBeGreaterThan(0);
      expect(ALERT_LEVEL_DISPLAY[level].meaning.length).toBeGreaterThan(0);
    }
    expect(Object.keys(TIER_DISPLAY).sort()).toEqual(["HIGH", "LOW", "MEDIUM"]);
    expect(ALERT_LEVEL_DISPLAY.URGENT.tone).toBe("red");
  });

  it("names every kind of signal in words, and passes an unknown one through", () => {
    for (const kind of SIGNAL_KINDS) expect(signalKindLabel(kind)).not.toBe(kind);
    expect(signalKindLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("states confidence in words as well as a percentage", () => {
    expect(confidenceLabel(0.95)).toBe("High confidence (95%)");
    expect(confidenceLabel(0.7)).toBe("Moderate confidence (70%)");
    expect(confidenceLabel(0.45)).toBe("Low confidence (45%)");
  });

  it("scales factor bars between 0 and 100", () => {
    expect(pointsBarPercent(0)).toBe(0);
    expect(pointsBarPercent(-3)).toBe(0);
    expect(pointsBarPercent(15)).toBe(50);
    expect(pointsBarPercent(500)).toBe(100);
    expect(pointsBarPercent(Number.NaN)).toBe(0);
  });

  it("says something useful on a quiet day", () => {
    expect(quietDaySummary(0, 0)).toBe("No pages are monitored yet.");
    expect(quietDaySummary(1, 0)).toBe("1 page is being watched and nothing noteworthy changed.");
    expect(quietDaySummary(10, 0)).toBe("10 pages are being watched and nothing noteworthy changed.");
    expect(quietDaySummary(10, 3)).toContain("changes below are minor");
  });

  it("names every kind of market pattern in words", () => {
    for (const kind of MARKET_PATTERN_KINDS) expect(patternKindLabel(kind)).not.toBe(kind);
    expect(patternKindLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
