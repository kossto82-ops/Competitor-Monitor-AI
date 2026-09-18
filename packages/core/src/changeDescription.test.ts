import { describe, expect, it } from "vitest";
import { describeChangeEvent } from "./changeDescription.js";

/**
 * Phase 23: describeChangeEvent is the single source of the sentence
 * both the UI (statusDisplay.ts) and the AI digest layer
 * (buildDigestContext.ts's untrustedTextForItem) use for a CHANGE_EVENT
 * item's `description` - so PROMOTION_ADDED/PROMOTION_CHANGE/
 * PROMOTION_REMOVED must each render the concrete before/after value,
 * exactly like PRICE_CHANGE/PRODUCT_ADDED/PRODUCT_REMOVED already do,
 * never a generic placeholder sentence.
 */
describe("describeChangeEvent - promotion change types", () => {
  it("describes PROMOTION_ADDED with the new promotion value", () => {
    const text = describeChangeEvent({
      changeType: "PROMOTION_ADDED",
      oldValue: null,
      newValue: "discount=20",
      currency: null,
      percentageChange: null,
    });
    expect(text).toContain("discount=20");
  });

  it("describes PROMOTION_CHANGE with both the old and new promotion value", () => {
    const text = describeChangeEvent({
      changeType: "PROMOTION_CHANGE",
      oldValue: "discount=10",
      newValue: "discount=20",
      currency: null,
      percentageChange: null,
    });
    expect(text).toContain("discount=10");
    expect(text).toContain("discount=20");
  });

  it("describes PROMOTION_REMOVED with the value that disappeared", () => {
    const text = describeChangeEvent({
      changeType: "PROMOTION_REMOVED",
      oldValue: "eligibleDuration=P1M",
      newValue: null,
      currency: null,
      percentageChange: null,
    });
    expect(text).toContain("eligibleDuration=P1M");
  });
});
