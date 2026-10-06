import { describe, expect, it } from "vitest";
import { AiOutputValidationError } from "./errors.js";
import { validateChangeClaimSafety } from "./validateChangeClaimSafety.js";
import { analyzeAndValidateChange } from "./analyzeAndValidateChange.js";
import { createFakeAiProvider } from "./providers/fakeProvider.js";
import type { AiAnalysisOutput, ChangeAnalysisInput } from "./types.js";

function input(overrides: Partial<ChangeAnalysisInput> = {}): ChangeAnalysisInput {
  return {
    changeType: "PRICE_CHANGE",
    sourceUrl: "https://competitor.test/pricing",
    detectedAt: "2026-01-01T00:00:00.000Z",
    evidenceExcerpt: "Pro Plan now 39.00 EUR",
    previousExcerpt: "Pro Plan 49.00 EUR",
    currentExcerpt: "Pro Plan 39.00 EUR",
    priceChange: { oldValue: "49.00", newValue: "39.00", currency: "EUR", percentageChange: -20.41 },
    productAdded: null,
    productRemoved: null,
    ...overrides,
  };
}

function output(overrides: Partial<AiAnalysisOutput> = {}): AiAnalysisOutput {
  return { summary: "The Pro plan price decreased.", facts: ["The listed price changed from 49.00 to 39.00."], interpretations: [], speculation: [], confidence: "medium", ...overrides };
}

const validate = (o: AiAnalysisOutput, i: ChangeAnalysisInput = input()) => validateChangeClaimSafety("test", o, i, "{}");

describe("validateChangeClaimSafety", () => {
  it("accepts a plain, evidence-grounded analysis", () => {
    expect(() =>
      validate(output({ interpretations: ["The reduction makes the Pro plan cheaper than before."], speculation: ["It may have been a routine price update."] })),
    ).not.toThrow();
  });

  it("accepts the sanctioned wording for a removed item", () => {
    const i = input({ changeType: "PRODUCT_REMOVED", priceChange: null, productRemoved: { label: "Gold Plan", value: "99" } });
    expect(() => validate(output({ facts: ['The previously detected item "Gold Plan" was no longer detected in the monitored content.'] }), i)).not.toThrow();
  });

  describe("evidence-gated claims: rejected unless the page itself used that wording", () => {
    it.each([
      ["promotion", "This looks like a promotional price."],
      ["promotion", "The company is running a discount."],
      ["promotion", "It may be a limited-time offer."],
      ["availability", "The item may be out of stock."],
      ["discontinuation", "The plan was discontinued."],
      ["discontinuation", "The product is no longer offered."],
      ["temporary", "The price change is probably temporary."],
      ["legal", "This may relate to a regulatory change."],
    ])("rejects an unsupported %s claim: %s", (_category, text) => {
      expect(() => validate(output({ interpretations: [text] }))).toThrow(AiOutputValidationError);
    });

    it("checks every text field, not just the interpretations", () => {
      expect(() => validate(output({ summary: "A discount was applied." }))).toThrow(AiOutputValidationError);
      expect(() => validate(output({ facts: ["The item is sold out."] }))).toThrow(AiOutputValidationError);
      expect(() => validate(output({ speculation: ["Perhaps a clearance."] }))).toThrow(AiOutputValidationError);
    });

    it("allows the claim when the page evidence really contains that wording", () => {
      const withDiscount = input({ evidenceExcerpt: "Pro Plan 39.00 EUR - 20% discount this month", currentExcerpt: "Pro Plan 39.00 EUR - 20% discount this month" });
      expect(() => validate(output({ facts: ["The page shows a 20% discount."] }), withDiscount)).not.toThrow();
      // ...but only for the kind of claim the evidence supports.
      expect(() => validate(output({ interpretations: ["The item may be out of stock."] }), withDiscount)).toThrow(AiOutputValidationError);
    });
  });

  describe("claims no evidence can support: always rejected", () => {
    it.each([
      "The competitor is targeting enterprise customers.",
      "This is aimed at taking customers from rivals.",
      "They are repositioning the plan as a budget option.",
      "The competitor is motivated by growth.",
      "It is an attempt to win market share.",
      "The cut was made in response to our own pricing.",
      "The reduction is due to increased competition.",
      "The competitor wants to attract new users.",
      "This reflects their strategy to undercut rivals.",
    ])("rejects: %s", (text) => {
      expect(() => validate(output({ interpretations: [text] }))).toThrow(AiOutputValidationError);
    });

    it("rejects them even when the page uses the same words (a page cannot license a motive)", () => {
      const hostile = input({ evidenceExcerpt: "We are targeting enterprise customers because of demand" });
      expect(() => validate(output({ interpretations: ["The competitor is targeting enterprise customers."] }), hostile)).toThrow(AiOutputValidationError);
    });
  });

  it("explains what was matched, so a rejection is debuggable", () => {
    try {
      validate(output({ interpretations: ["The price is only a temporary change."] }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiOutputValidationError);
      expect((err as Error).message).toContain("temporary");
      expect((err as Error).message).toContain("not in the evidence");
    }
  });
});

describe("analyzeAndValidateChange wiring", () => {
  it("rejects a schema-valid response that smuggles in an injected claim (prompt-injection outcome check)", async () => {
    const injected = JSON.stringify({
      summary: "The competitor is discontinuing the Pro plan to target enterprise customers.",
      facts: ["The price changed."],
      interpretations: [],
      speculation: [],
      confidence: "high",
    });
    const provider = createFakeAiProvider({ respond: () => injected });
    await expect(analyzeAndValidateChange(provider, input())).rejects.toBeInstanceOf(AiOutputValidationError);
  });

  it("passes the default canned fake responses for every supported change type", async () => {
    const provider = createFakeAiProvider();
    const inputs = [
      input(),
      input({ changeType: "PRODUCT_ADDED", priceChange: null, productAdded: { label: "Gold Plan", value: "99" } }),
      input({ changeType: "PRODUCT_REMOVED", priceChange: null, productRemoved: { label: "Gold Plan", value: "99" } }),
    ];
    for (const i of inputs) await expect(analyzeAndValidateChange(provider, i)).resolves.toBeTruthy();
  });
});
