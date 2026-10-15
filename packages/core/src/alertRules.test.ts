import { describe, expect, it } from "vitest";
import { alertDedupeKey, buildAlertExplanation, decideAlert, DEFAULT_ALERT_RULES, ruleMatches, validateAlertRules, type AlertRuleSpec, type SignalForAlert } from "./alertRules.js";

function signal(overrides: Partial<SignalForAlert> = {}): SignalForAlert {
  return {
    id: "s1",
    kind: "PRICE_INCREASE",
    title: "Pro: price increased",
    summary: "Price changed from EUR49.00 to EUR59.00 (+20.41%)",
    entityKey: "plan:pro",
    monitoredUrlId: "u1",
    competitorId: "c1",
    competitorName: "Rival",
    confidence: 0.9,
    occurredAt: new Date("2026-10-15T10:00:00Z"),
    evidenceCount: 1,
    importance: 72,
    tier: "HIGH",
    factors: [
      { factor: "magnitude", value: 0.41, weight: 0.3, points: 12.2, explanation: "A 20.4% price change (50% or more counts as the largest)." },
      { factor: "kind", value: 1, weight: 0.25, points: 25, explanation: "Your emphasis on this kind of change is 100%." },
      { factor: "history", value: 1, weight: 0.1, points: 10, explanation: "The first change ever seen on this price or plan." },
      { factor: "corroboration", value: 0, weight: 0.1, points: 0, explanation: "No other competitor showed this kind of change." },
    ],
    ...overrides,
  };
}

describe("decideAlert (Phase 29 D4)", () => {
  it("alerts an important price change at the level of the rule that matched, with a mandatory explanation", () => {
    const decision = decideAlert(signal())!;
    expect(decision.level).toBe("IMPORTANT");
    expect(decision.rule.id).toBe("default-important-price-plan");
    expect(decision.title).toBe("Rival: Pro: price increased");
    expect(decision.dedupeKey).toBe("u1|plan:pro|PRICE_INCREASE");
    expect(decision.explanation).toContain('Rule "Important price or plan change" matched');
    expect(decision.explanation).toContain("importance 72 (at least 65 needed)");
    expect(decision.explanation).toContain("confidence 90% (at least 60% needed)");
    expect(decision.explanation).toContain("Price changed from EUR49.00 to EUR59.00");
    expect(decision.explanation).toContain("1 verified change event from Rival");
  });

  it("explains with the three strongest reasons, in order of points, and leaves out what contributed nothing", () => {
    const text = decideAlert(signal())!.explanation;
    const at = (f: string) => text.indexOf(`${f} (+`);
    expect(at("kind")).toBeGreaterThan(-1);
    expect(at("kind")).toBeLessThan(at("magnitude"));
    expect(at("magnitude")).toBeLessThan(at("history"));
    expect(text).not.toContain("corroboration (+");
  });

  it("escalates to URGENT when a more urgent rule also matches, and picks the most urgent of several", () => {
    expect(decideAlert(signal({ importance: 85 }))!.level).toBe("URGENT");
    expect(decideAlert(signal({ importance: 85, confidence: 0.65 }))!.level).toBe("IMPORTANT"); // too uncertain for the urgent rule
  });

  it("does not alert below the thresholds, for text changes, or when every rule is off", () => {
    expect(decideAlert(signal({ importance: 50 }))).toBeNull();
    expect(decideAlert(signal({ importance: 90, confidence: 0.4 }))).toBeNull();
    expect(decideAlert(signal({ kind: "CONTENT_UPDATE", importance: 95 }))).toBeNull(); // no default rule covers text
    expect(decideAlert(signal(), DEFAULT_ALERT_RULES.map((r) => ({ ...r, enabled: false })))).toBeNull();
    expect(decideAlert(signal(), [])).toBeNull();
  });

  it("covers plan and promotion changes with their own thresholds", () => {
    expect(decideAlert(signal({ kind: "PLAN_ADDED", importance: 70 }))!.level).toBe("IMPORTANT");
    expect(decideAlert(signal({ kind: "PROMOTION_STARTED", importance: 45 }))!.level).toBe("NOTICE");
    expect(decideAlert(signal({ kind: "PROMOTION_STARTED", importance: 30 }))).toBeNull();
  });

  it("warns when confidence is only moderate, and not otherwise", () => {
    expect(buildAlertExplanation(signal({ confidence: 0.65 }), DEFAULT_ALERT_RULES[1]!)).toContain("Confidence is moderate");
    expect(buildAlertExplanation(signal({ confidence: 0.9 }), DEFAULT_ALERT_RULES[1]!)).not.toContain("Confidence is moderate");
  });

  it("a custom rule can cover text changes or every kind, and an empty kind list means all", () => {
    const rules: AlertRuleSpec[] = [{ id: "mine", name: "Anything big", level: "NOTICE", minImportance: 20, minConfidence: 0, kinds: [], enabled: true }];
    expect(decideAlert(signal({ kind: "CONTENT_UPDATE", importance: 25 }), rules)!.rule.id).toBe("mine");
    expect(ruleMatches(rules[0]!, { kind: "PLAN_REMOVED", importance: 19, confidence: 1 })).toBe(false);
  });

  it("keys repeats of the same page, plan and kind together, and different plans or kinds apart", () => {
    expect(alertDedupeKey(signal())).toBe(alertDedupeKey(signal({ id: "s2" })));
    expect(alertDedupeKey(signal())).not.toBe(alertDedupeKey(signal({ entityKey: "plan:team" })));
    expect(alertDedupeKey(signal())).not.toBe(alertDedupeKey(signal({ kind: "PRICE_DECREASE" })));
    expect(alertDedupeKey(signal())).not.toBe(alertDedupeKey(signal({ monitoredUrlId: "u2" })));
  });
});

describe("validateAlertRules", () => {
  const ok = DEFAULT_ALERT_RULES;
  it("accepts the defaults and rejects rules that cannot work", () => {
    expect(validateAlertRules(ok)).toBeNull();
    expect(validateAlertRules([ok[0]!, { ...ok[1]!, id: ok[0]!.id }])).toContain("unique");
    expect(validateAlertRules([{ ...ok[0]!, name: " " }])).toContain("name");
    expect(validateAlertRules([{ ...ok[0]!, minImportance: 120 }])).toContain("importance");
    expect(validateAlertRules([{ ...ok[0]!, minConfidence: 2 }])).toContain("confidence");
    expect(validateAlertRules([{ ...ok[0]!, level: "PANIC" as never }])).toContain("level");
  });
});
