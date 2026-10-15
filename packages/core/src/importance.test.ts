import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPORTANCE_CONFIG,
  IMPORTANCE_FACTORS,
  prioritizeSignals,
  scoreSignal,
  validateImportanceConfig,
  type ScoringContext,
  type SignalForScoring,
} from "./importance.js";

const now = new Date("2026-10-15T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

function signal(overrides: Partial<SignalForScoring> = {}): SignalForScoring {
  return {
    id: "s1",
    kind: "PRICE_INCREASE",
    entityKey: "plan:pro",
    percentageChange: 30,
    confidence: 0.9,
    occurredAt: daysAgo(0.5),
    monitoredUrlId: "u1",
    competitorId: "c1",
    ...overrides,
  };
}
function context(overrides: Partial<ScoringContext> = {}, signals: SignalForScoring[] = [signal()]): ScoringContext {
  return { now, competitorRelevance: new Map(), recentSignals: signals, priorChangesByEntity: new Map(), ...overrides };
}

describe("scoreSignal (Phase 29 D3)", () => {
  it("explains every point: one factor per name, weights that sum to 1, points that add up to the importance", () => {
    const scored = scoreSignal(signal(), context());
    expect(scored.factors.map((f) => f.factor)).toEqual([...IMPORTANCE_FACTORS]);
    expect(scored.factors.reduce((s, f) => s + f.weight, 0)).toBeCloseTo(1, 2);
    expect(scored.factors.reduce((s, f) => s + f.points, 0)).toBeCloseTo(scored.importance, 0);
    expect(scored.factors.every((f) => f.explanation.length > 0)).toBe(true);
    expect(scored.configVersion).toBe(DEFAULT_IMPORTANCE_CONFIG.version);
  });

  it("ranks a large, fresh price change on a first-ever change above everything else, and keeps confidence separate", () => {
    const big = scoreSignal(signal({ percentageChange: 45, confidence: 0.55 }), context());
    expect(big.tier).toBe("HIGH");
    expect(big.confidence).toBe(0.55); // untouched: importance does not absorb it
    const text = scoreSignal(signal({ id: "t", kind: "CONTENT_UPDATE", entityKey: null, percentageChange: null, confidence: 0.95 }), context());
    expect(text.tier).toBe("LOW");
    expect(text.confidence).toBe(0.95); // certain but unimportant
    expect(big.importance).toBeGreaterThan(text.importance + 30);
  });

  it("scales magnitude with the size of the price change and caps it at 50%", () => {
    const m = (pct: number | null) => scoreSignal(signal({ percentageChange: pct }), context()).factors.find((f) => f.factor === "magnitude")!.value;
    expect(m(5)).toBeLessThan(m(25));
    expect(m(25)).toBeLessThan(m(50));
    expect(m(200)).toBe(1);
    expect(m(-50)).toBe(1);
    expect(m(null)).toBe(0.4);
  });

  it("halves recency every half-life", () => {
    const r = (days: number) => scoreSignal(signal({ occurredAt: daysAgo(days) }), context()).factors.find((f) => f.factor === "recency")!.value;
    expect(r(0)).toBeCloseTo(1, 2);
    expect(r(7)).toBeCloseTo(0.5, 2);
    expect(r(14)).toBeCloseTo(0.25, 2);
  });

  it("weights the competitor's relevance, defaulting to normal", () => {
    const rel = (value?: 1 | 2 | 3) => scoreSignal(signal(), context({ competitorRelevance: value ? new Map([["c1", value]]) : new Map() })).factors.find((f) => f.factor === "relevance")!.value;
    expect(rel(3)).toBe(1);
    expect(rel()).toBeCloseTo(2 / 3, 2);
    expect(rel(1)).toBeCloseTo(1 / 3, 2);
  });

  it("raises importance when other competitors show the same kind of change, and lowers it for a page that keeps repeating itself", () => {
    const base = signal();
    const alone = scoreSignal(base, context({}, [base]));
    const market = scoreSignal(base, context({}, [base, signal({ id: "o1", competitorId: "c2", monitoredUrlId: "u2" }), signal({ id: "o2", competitorId: "c3", monitoredUrlId: "u3" })]));
    expect(market.importance).toBeGreaterThan(alone.importance);
    expect(market.factors.find((f) => f.factor === "corroboration")!.explanation).toContain("3 competitors");

    const repeats = [base, signal({ id: "r1", occurredAt: daysAgo(3) }), signal({ id: "r2", occurredAt: daysAgo(6) }), signal({ id: "r3", occurredAt: daysAgo(9) })];
    const noisy = scoreSignal(base, context({}, repeats));
    expect(noisy.importance).toBeLessThan(alone.importance);
    expect(noisy.factors.find((f) => f.factor === "repetition")!.explanation).toContain("3 similar signals");
  });

  it("treats a price's first change as more significant than its tenth", () => {
    const first = scoreSignal(signal(), context());
    const tenth = scoreSignal(signal(), context({ priorChangesByEntity: new Map([["u1|plan:pro", 9]]) }));
    expect(first.factors.find((f) => f.factor === "history")!.explanation).toContain("first change ever");
    expect(tenth.importance).toBeLessThan(first.importance);
  });

  it("follows the configuration: emphasis, weights and tiers, and says which version it used", () => {
    const customised = { ...DEFAULT_IMPORTANCE_CONFIG, version: 4, kindEmphasis: { ...DEFAULT_IMPORTANCE_CONFIG.kindEmphasis, PRICE_INCREASE: 0 } };
    const a = scoreSignal(signal(), context());
    const b = scoreSignal(signal(), context(), customised);
    expect(b.importance).toBeLessThan(a.importance);
    expect(b.configVersion).toBe(4);
    const strict = { ...DEFAULT_IMPORTANCE_CONFIG, tiers: { high: 99, medium: 98 } };
    expect(scoreSignal(signal(), context(), strict).tier).toBe("LOW");
    // only the proportions of the weights matter
    const doubled = { ...DEFAULT_IMPORTANCE_CONFIG, weights: Object.fromEntries(IMPORTANCE_FACTORS.map((f) => [f, DEFAULT_IMPORTANCE_CONFIG.weights[f] * 10])) as typeof DEFAULT_IMPORTANCE_CONFIG.weights };
    expect(scoreSignal(signal(), context(), doubled).importance).toBe(a.importance);
  });

  it("orders signals by importance, then by recency", () => {
    const list = [
      signal({ id: "text", kind: "CONTENT_UPDATE", entityKey: null, percentageChange: null }),
      signal({ id: "small", percentageChange: 3 }),
      signal({ id: "big", percentageChange: 40 }),
      signal({ id: "bigOlder", percentageChange: 40, occurredAt: daysAgo(10) }),
    ];
    const order = prioritizeSignals(list, context({}, list)).map((s) => s.signalId);
    expect(order[0]).toBe("big");
    expect(order.indexOf("big")).toBeLessThan(order.indexOf("bigOlder"));
    expect(order.indexOf("small")).toBeLessThan(order.indexOf("text"));
  });
});

describe("validateImportanceConfig", () => {
  const ok = DEFAULT_IMPORTANCE_CONFIG;
  it("accepts the default and rejects values that cannot be used", () => {
    expect(validateImportanceConfig(ok)).toBeNull();
    expect(validateImportanceConfig({ ...ok, weights: { ...ok.weights, magnitude: -1 } })).toContain("magnitude");
    expect(validateImportanceConfig({ ...ok, weights: Object.fromEntries(IMPORTANCE_FACTORS.map((f) => [f, 0])) as typeof ok.weights })).toContain("At least one weight");
    expect(validateImportanceConfig({ ...ok, kindEmphasis: { ...ok.kindEmphasis, PLAN_ADDED: 1.5 } })).toContain("PLAN_ADDED");
    expect(validateImportanceConfig({ ...ok, tiers: { high: 40, medium: 60 } })).toContain("Tier thresholds");
    expect(validateImportanceConfig({ ...ok, recencyHalfLifeDays: 0 })).toContain("half-life");
  });
});
