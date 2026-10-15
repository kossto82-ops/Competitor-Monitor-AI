import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_PATTERN_CONFIG, detectMarketPatterns, type ObservedCompetitor, type SignalForPattern } from "./marketPatterns.js";

const now = new Date("2026-11-20T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const competitor = (id: string, history = 30): ObservedCompetitor => ({ id, name: id.toUpperCase(), observedSince: daysAgo(history) });
const signal = (id: string, competitorId: string, kind: SignalForPattern["kind"], ago = 3, pct: number | null = null): SignalForPattern => ({ id, kind, competitorId, occurredAt: daysAgo(ago), percentageChange: pct });
const five = ["a", "b", "c", "d", "e"].map((id) => competitor(id));

describe("detectMarketPatterns (Phase 29 E1)", () => {
  it("finds several competitors raising prices, names each with its move, and keeps every signal as evidence", () => {
    const result = detectMarketPatterns(
      [signal("s1", "a", "PRICE_INCREASE", 3, 12.4), signal("s2", "b", "PRICE_INCREASE", 5, 8), signal("s3", "b", "PRICE_INCREASE", 9, 20), signal("s4", "c", "PRICE_INCREASE", 2, 10)],
      five,
      now,
    );
    expect(result.status).toBe("EVALUATED");
    expect(result.patterns).toHaveLength(1);
    const [pattern] = result.patterns;
    expect(pattern).toMatchObject({ kind: "MARKET_PRICES_UP", epistemicLevel: "INTERPRETATION", affectedCount: 3, observedCount: 5, share: 0.6 });
    expect(pattern!.summary).toBe("3 of 5 competitors raised prices in the last 30 days: C (+10%), A (+12.4%), B (+20%).");
    const b = pattern!.affected.find((a) => a.competitorId === "b")!;
    expect(b.signalIds).toEqual(["s2", "s3"]); // all the evidence, not only the latest
    expect(b.largestPercentageChange).toBe(20);
  });

  it("never mixes a rise with a fall: they are different patterns, each judged on its own", () => {
    const result = detectMarketPatterns(
      [signal("s1", "a", "PRICE_INCREASE"), signal("s2", "b", "PRICE_DECREASE"), signal("s3", "c", "PRICE_INCREASE"), signal("s4", "d", "PRICE_DECREASE")],
      five,
      now,
    );
    expect(result.patterns.map((p) => [p.kind, p.affectedCount])).toEqual([["MARKET_PRICES_DOWN", 2], ["MARKET_PRICES_UP", 2]]);
    const one = detectMarketPatterns([signal("s1", "a", "PRICE_INCREASE"), signal("s2", "b", "PRICE_DECREASE")], five, now);
    expect(one.patterns).toEqual([]); // one of each is no pattern in either direction
  });

  it("claims nothing when the sample is too small, and says why: too few competitors or too little history", () => {
    const few = detectMarketPatterns([signal("s1", "a", "PRICE_INCREASE"), signal("s2", "b", "PRICE_INCREASE")], [competitor("a"), competitor("b")], now);
    expect(few.status).toBe("INSUFFICIENT_SAMPLE");
    expect(few.status === "INSUFFICIENT_SAMPLE" && few.reason).toContain("at least 3 competitors");
    const young = detectMarketPatterns([signal("s1", "a", "PRICE_INCREASE"), signal("s2", "b", "PRICE_INCREASE")], ["a", "b", "c", "d"].map((id) => competitor(id, 6)), now);
    expect(young.status).toBe("INSUFFICIENT_SAMPLE");
    expect(young.status === "INSUFFICIENT_SAMPLE" && young.reason).toMatch(/0 of 4 qualify \(the longest history is 6 days\)/);
    expect(young.patterns).toEqual([]);
  });

  it("counts only competitors with enough history: a newly added one is neither evidence nor part of the denominator", () => {
    const mixed = [competitor("a"), competitor("b"), competitor("c"), competitor("new", 2)];
    const result = detectMarketPatterns([signal("s1", "a", "PRICE_INCREASE"), signal("s2", "b", "PRICE_INCREASE"), signal("s3", "new", "PRICE_INCREASE")], mixed, now);
    expect(result.patterns[0]).toMatchObject({ affectedCount: 2, observedCount: 3 });
    expect(result.patterns[0]!.affected.map((a) => a.competitorId).sort()).toEqual(["a", "b"]);
  });

  it("needs both a minimum number and a minimum share of the competitors observed", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => competitor(`c${i}`));
    const twoOfTwelve = detectMarketPatterns([signal("s1", "c0", "PRICE_INCREASE"), signal("s2", "c1", "PRICE_INCREASE")], twelve, now);
    expect(twoOfTwelve.patterns).toEqual([]); // 17% is not a market movement
    const fiveOfTwelve = detectMarketPatterns(["c0", "c1", "c2", "c3", "c4"].map((c, i) => signal(`s${i}`, c, "PRICE_INCREASE")), twelve, now);
    expect(fiveOfTwelve.patterns).toHaveLength(1);
    const oneOfThree = detectMarketPatterns([signal("s1", "a", "PRICE_INCREASE")], [competitor("a"), competitor("b"), competitor("c")], now);
    expect(oneOfThree.patterns).toEqual([]);
  });

  it("ignores signals outside the window and kinds that make no market pattern", () => {
    const result = detectMarketPatterns(
      [signal("old1", "a", "PRICE_INCREASE", 45), signal("old2", "b", "PRICE_INCREASE", 31), signal("text1", "a", "CONTENT_UPDATE"), signal("text2", "b", "CONTENT_UPDATE"), signal("ended", "c", "PROMOTION_ENDED"), signal("ended2", "d", "PROMOTION_ENDED")],
      five,
      now,
    );
    expect(result.status).toBe("EVALUATED");
    expect(result.patterns).toEqual([]);
  });

  it("finds plan and promotion patterns by their own kind, and names the competitors without a percentage", () => {
    const result = detectMarketPatterns(
      [signal("p1", "a", "PLAN_ADDED"), signal("p2", "b", "PLAN_ADDED"), signal("q1", "c", "PROMOTION_STARTED"), signal("q2", "d", "PROMOTION_STARTED"), signal("q3", "e", "PROMOTION_STARTED")],
      five,
      now,
    );
    const byKind = Object.fromEntries(result.patterns.map((p) => [p.kind, p]));
    expect(byKind["MARKET_PLANS_ADDED"]!.summary).toBe("2 of 5 competitors added a plan in the last 30 days: A, B.");
    expect(byKind["MARKET_PROMOTIONS"]).toMatchObject({ affectedCount: 3, share: 0.6 });
    expect(result.patterns[0]!.kind).toBe("MARKET_PROMOTIONS"); // the broader pattern first
  });

  it("follows the configuration", () => {
    const strict = { ...DEFAULT_MARKET_PATTERN_CONFIG, minAffected: 4 };
    const three = ["a", "b", "c"].map((c, i) => signal(`s${i}`, c, "PRICE_INCREASE"));
    expect(detectMarketPatterns(three, five, now).patterns).toHaveLength(1);
    expect(detectMarketPatterns(three, five, now, strict).patterns).toEqual([]);
    expect(detectMarketPatterns(three, five, now, { ...DEFAULT_MARKET_PATTERN_CONFIG, windowDays: 1 }).patterns).toEqual([]);
  });
});
