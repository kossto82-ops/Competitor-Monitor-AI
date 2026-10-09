import { describe, expect, it } from "vitest";
import { deriveSourceHealth, staleAfterMs, type SourceHealthInput } from "./sourceHealth.js";

const now = new Date("2026-10-07T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

function source(overrides: Partial<SourceHealthInput> = {}): SourceHealthInput {
  return {
    isActive: true,
    disabledAt: null,
    consecutiveFailureCount: 0,
    lastSuccessfulScanAt: hoursAgo(2),
    lastAttemptAt: hoursAgo(2),
    scanFrequencyMinutes: 1440,
    createdAt: hoursAgo(24 * 30),
    ...overrides,
  };
}

describe("deriveSourceHealth: partly verifiable sources", () => {
  it("is PARTIAL when most of the recent scans could not be verified, and says how many", () => {
    const health = deriveSourceHealth(source({ recentScans: { total: 10, unverified: 8 } }), now);
    expect(health.state).toBe("PARTIAL");
    expect(health.reason).toContain("8 of the last 10");
  });

  it("is HEALTHY with a minority of unverified scans, with too few scans to judge, or when not told", () => {
    expect(deriveSourceHealth(source({ recentScans: { total: 10, unverified: 4 } }), now).state).toBe("HEALTHY");
    expect(deriveSourceHealth(source({ recentScans: { total: 3, unverified: 3 } }), now).state).toBe("HEALTHY");
    expect(deriveSourceHealth(source(), now).state).toBe("HEALTHY");
  });

  it("is PARTIAL from exactly half, and never hides a stronger state", () => {
    expect(deriveSourceHealth(source({ recentScans: { total: 10, unverified: 5 } }), now).state).toBe("PARTIAL");
    expect(deriveSourceHealth(source({ recentScans: { total: 10, unverified: 9 }, consecutiveFailureCount: 2 }), now).state).toBe("DEGRADED");
    expect(deriveSourceHealth(source({ recentScans: { total: 10, unverified: 9 }, lastSuccessfulScanAt: hoursAgo(200) }), now).state).toBe("STALE");
  });
});

describe("deriveSourceHealth", () => {
  it("is HEALTHY after a recent successful scan", () => {
    expect(deriveSourceHealth(source(), now).state).toBe("HEALTHY");
  });

  it("is PENDING before the first attempt", () => {
    expect(deriveSourceHealth(source({ lastAttemptAt: null, lastSuccessfulScanAt: null }), now).state).toBe("PENDING");
  });

  it("is DEGRADED when recent attempts failed but the last good scan is still fresh", () => {
    const health = deriveSourceHealth(source({ consecutiveFailureCount: 3, lastAttemptAt: hoursAgo(1), lastSuccessfulScanAt: hoursAgo(30) }), now);
    expect(health.state).toBe("DEGRADED");
    expect(health.reason).toContain("3");
  });

  it("is STALE when the last good scan is older than 3x the cadence (and at least 48h)", () => {
    // daily cadence -> 72h threshold
    expect(deriveSourceHealth(source({ lastSuccessfulScanAt: hoursAgo(71) }), now).state).toBe("HEALTHY");
    expect(deriveSourceHealth(source({ lastSuccessfulScanAt: hoursAgo(73) }), now).state).toBe("STALE");
  });

  it("never treats a short cadence as stale before 48h", () => {
    expect(staleAfterMs(60)).toBe(48 * 3_600_000);
    expect(deriveSourceHealth(source({ scanFrequencyMinutes: 60, lastSuccessfulScanAt: hoursAgo(47) }), now).state).toBe("HEALTHY");
  });

  it("STALE wins over DEGRADED: failing AND old data is reported as stale", () => {
    const health = deriveSourceHealth(source({ consecutiveFailureCount: 9, lastSuccessfulScanAt: hoursAgo(200) }), now);
    expect(health.state).toBe("STALE");
  });

  it("ages a source that never succeeded from its creation date", () => {
    const fresh = source({ lastSuccessfulScanAt: null, consecutiveFailureCount: 2, createdAt: hoursAgo(5) });
    expect(deriveSourceHealth(fresh, now).state).toBe("DEGRADED");
    const old = source({ lastSuccessfulScanAt: null, consecutiveFailureCount: 20, createdAt: hoursAgo(24 * 10) });
    const health = deriveSourceHealth(old, now);
    expect(health.state).toBe("STALE");
    expect(health.reason).toContain("No scan has succeeded");
  });

  it("is PAUSED when the customer paused it, and DISABLED (taking precedence) after an automatic stop", () => {
    expect(deriveSourceHealth(source({ isActive: false }), now).state).toBe("PAUSED");
    expect(deriveSourceHealth(source({ isActive: false, disabledAt: hoursAgo(1) }), now).state).toBe("DISABLED");
  });
});
