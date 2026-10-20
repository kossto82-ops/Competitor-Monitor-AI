import { describe, expect, it } from "vitest";
import { deriveSignals, REVERT_MARKER, RENAME_MARKER, SIGNAL_RULE_VERSIONS, type EventForSignal } from "./signalRules.js";

const at = new Date("2026-10-13T10:00:00Z");
function event(overrides: Partial<EventForSignal> = {}): EventForSignal {
  return {
    id: "e1",
    monitoredUrlId: "u1",
    changeType: "PRICE_CHANGE",
    entityKey: "plan:pro",
    oldValue: "29.00",
    newValue: "39.00",
    currency: "USD",
    percentageChange: 34.48,
    confidence: 0.9,
    evidenceExcerpt: "Pro (per month): 29.00 -> 39.00",
    detectedAt: at,
    ...overrides,
  };
}
const labels = new Map([["plan:pro", "Pro (per month)"]]);

describe("deriveSignals (Phase 29 D2)", () => {
  it("promotes a price increase with a template title, the event's own summary and the rule that produced it", () => {
    const { drafts, skipped } = deriveSignals([event()], labels);
    expect(skipped).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: "PRICE_INCREASE",
      ruleId: "price-change",
      ruleVersion: SIGNAL_RULE_VERSIONS["price-change"],
      dedupeKey: "price:e1",
      entityKey: "plan:pro",
      epistemicLevel: "FACT",
      title: "Pro: price increased",
      summary: "Price changed from USD29.00 to USD39.00 (+34.48%)",
      primaryEventId: "e1",
      confidence: 0.9,
    });
  });

  it("promotes a decrease, and works out the direction from the values when no percentage is given", () => {
    expect(deriveSignals([event({ percentageChange: -25 })], labels).drafts[0]?.kind).toBe("PRICE_DECREASE");
    expect(deriveSignals([event({ percentageChange: null, oldValue: "39.00", newValue: "29.00" })], labels).drafts[0]?.kind).toBe("PRICE_DECREASE");
    const none = deriveSignals([event({ percentageChange: null, oldValue: "x", newValue: "y" })], labels);
    expect(none.drafts).toEqual([]);
    expect(none.skipped[0]?.reason).toContain("direction");
  });

  it("does not promote a price change the detector downgraded: low confidence, or a revert of a recent change", () => {
    const low = deriveSignals([event({ confidence: 0.45 })], labels);
    expect(low.drafts).toEqual([]);
    expect(low.skipped[0]?.reason).toContain("below 0.6");
    const revert = deriveSignals([event({ confidence: 0.9, evidenceExcerpt: `x ${REVERT_MARKER} 3h ago` })], labels);
    expect(revert.drafts).toEqual([]);
    expect(revert.skipped[0]?.reason).toContain("A/B test");
  });

  it("promotes a plan that appears or disappears, but not one half of a probable rename", () => {
    const added = deriveSignals([event({ id: "a", changeType: "PRODUCT_ADDED", oldValue: null, newValue: "59.00", percentageChange: null, entityKey: "plan:team" })], new Map([["plan:team", "Team"]]));
    expect(added.drafts[0]).toMatchObject({ kind: "PLAN_ADDED", title: "New plan or price listed: Team", dedupeKey: "plan:a" });
    const removed = deriveSignals([event({ id: "r", changeType: "PRODUCT_REMOVED", oldValue: "59.00", newValue: null, percentageChange: null, entityKey: "plan:team" })], new Map([["plan:team", "Team"]]));
    expect(removed.drafts[0]?.kind).toBe("PLAN_REMOVED");
    const rename = deriveSignals([event({ changeType: "PRODUCT_ADDED", evidenceExcerpt: `x ${RENAME_MARKER} "A" -> "B"` })]);
    expect(rename.drafts).toEqual([]);
    expect(rename.skipped[0]?.reason).toContain("rename");
  });

  it("does not promote a wave of plans added or removed from one source in one scan, but does promote a few", () => {
    const wave = (n: number) => Array.from({ length: n }, (_, i) => event({ id: `r${i}`, changeType: "PRODUCT_REMOVED", entityKey: `plan:p${i}`, oldValue: "10.00", newValue: null, percentageChange: null }));
    const mass = deriveSignals(wave(6));
    expect(mass.drafts).toEqual([]);
    expect(mass.skipped).toHaveLength(6);
    expect(mass.skipped[0]?.reason).toContain("6 plans of one source");
    expect(deriveSignals(wave(3)).drafts).toHaveLength(3);
    // another source's retirement in the same batch is counted separately
    expect(deriveSignals([...wave(3), event({ id: "x", monitoredUrlId: "u2", changeType: "PRODUCT_REMOVED", entityKey: "plan:z", percentageChange: null })]).drafts).toHaveLength(4);
  });

  it("promotes a capability the page now claims or no longer claims, named by its label", () => {
    const added = deriveSignals([event({ id: "c1", changeType: "CAPABILITY_ADDED", entityKey: "capability:support_24_7", oldValue: null, newValue: "Support or availability 24/7", percentageChange: null, confidence: 0.85 })]);
    expect(added.drafts[0]).toMatchObject({ kind: "CAPABILITY_ADDED", ruleId: "capability-change", title: "Now says it offers: Support or availability 24/7", dedupeKey: "capability:c1", epistemicLevel: "FACT" });
    expect(added.drafts[0]!.summary).toBe("The page now says the service offers: Support or availability 24/7");
    const removed = deriveSignals([event({ id: "c2", changeType: "CAPABILITY_REMOVED", entityKey: "capability:call_transfer", oldValue: "Call transfer", newValue: null, percentageChange: null, confidence: 0.85 })]);
    expect(removed.drafts[0]).toMatchObject({ kind: "CAPABILITY_REMOVED", title: "No longer says it offers: Call transfer" });
    expect(deriveSignals([event({ id: "c3", changeType: "CAPABILITY_ADDED", newValue: "X", confidence: 0.4 })]).drafts).toEqual([]);
  });

  it("does not promote a wave of capabilities changing on one source in one scan", () => {
    const wave = Array.from({ length: 4 }, (_, i) => event({ id: `w${i}`, changeType: "CAPABILITY_ADDED", entityKey: `capability:k${i}`, newValue: `K${i}`, percentageChange: null, confidence: 0.85 }));
    const result = deriveSignals(wave);
    expect(result.drafts).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("4 plans of one source");
  });

  it("promotes promotion events by their kind", () => {
    const kinds = (changeType: string) => deriveSignals([event({ changeType, entityKey: "promo:trial", oldValue: null, newValue: "14 days free", percentageChange: null })]).drafts[0]?.kind;
    expect(kinds("PROMOTION_ADDED")).toBe("PROMOTION_STARTED");
    expect(kinds("PROMOTION_CHANGE")).toBe("PROMOTION_CHANGED");
    expect(kinds("PROMOTION_REMOVED")).toBe("PROMOTION_ENDED");
  });

  it("groups a source's text changes of one UTC day under one dedupe key, and keeps days apart", () => {
    const text = (id: string, when: string) => event({ id, changeType: "CONTENT_CHANGE", entityKey: null, oldValue: null, newValue: null, percentageChange: null, confidence: 0.6, detectedAt: new Date(when) });
    const { drafts } = deriveSignals([text("c1", "2026-10-13T01:00:00Z"), text("c2", "2026-10-13T22:00:00Z"), text("c3", "2026-10-14T01:00:00Z")]);
    expect(drafts.map((d) => d.dedupeKey)).toEqual(["content:u1:2026-10-13", "content:u1:2026-10-13", "content:u1:2026-10-14"]);
    expect(drafts[0]).toMatchObject({ kind: "CONTENT_UPDATE", title: "Page text changed", summary: "The page's visible text changed" });
  });

  it("explains every event it does not promote, and never promotes an unknown type", () => {
    const { drafts, skipped } = deriveSignals([event({ id: "z", changeType: "SOMETHING_NEW" }), event({ id: "w", changeType: "CONTENT_CHANGE", confidence: 0.3 })]);
    expect(drafts).toEqual([]);
    expect(skipped.map((s) => s.eventId)).toEqual(["z", "w"]);
    expect(skipped.every((s) => s.reason.length > 0)).toBe(true);
  });
});
