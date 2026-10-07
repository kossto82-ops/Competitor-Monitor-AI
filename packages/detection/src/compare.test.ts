import { describe, expect, it } from "vitest";
import { compareSnapshots, type CurrentExtractionData, type PriorSnapshotData } from "./compare.js";
import type { ExtractedEntity } from "@cma/core";

function priceEntity(overrides: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    type: "PRICE",
    key: "jsonld:pro plan",
    label: "Pro Plan",
    value: "49.00",
    currency: "EUR",
    raw: "{}",
    ...overrides,
  };
}

function promotionEntity(overrides: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    type: "PROMOTION",
    key: "jsonld-promo:pro plan",
    label: "Pro Plan",
    value: "discount=10",
    currency: "EUR",
    raw: "{}",
    ...overrides,
  };
}

function makeCurrent(overrides: Partial<CurrentExtractionData> = {}): CurrentExtractionData {
  return {
    httpStatus: 200,
    errorMessage: null,
    contentHash: "hash-a",
    structuredDataHash: "struct-a",
    normalizedContent: "Pro Plan 49 EUR",
    entities: [],
    ...overrides,
  };
}

function makePrior(overrides: Partial<PriorSnapshotData> = {}): PriorSnapshotData {
  return {
    contentHash: "hash-a",
    structuredDataHash: "struct-a",
    normalizedContent: "Pro Plan 49 EUR",
    entities: [],
    ...overrides,
  };
}

describe("compareSnapshots - verification states", () => {
  it("treats a fetch error as FAILED_TO_VERIFY, never as a change", () => {
    const result = compareSnapshots(makePrior(), makeCurrent({ errorMessage: "Request timed out" }));
    expect(result.verificationState).toBe("FAILED_TO_VERIFY");
    expect(result.changeEvents).toHaveLength(0);
  });

  it("treats HTTP 403 as FAILED_TO_VERIFY", () => {
    const current = makeCurrent({ httpStatus: 403, errorMessage: "Unexpected HTTP status 403" });
    const result = compareSnapshots(makePrior(), current);
    expect(result.verificationState).toBe("FAILED_TO_VERIFY");
  });

  it("treats HTTP 429 as FAILED_TO_VERIFY", () => {
    const current = makeCurrent({ httpStatus: 429, errorMessage: "Unexpected HTTP status 429" });
    const result = compareSnapshots(makePrior(), current);
    expect(result.verificationState).toBe("FAILED_TO_VERIFY");
  });

  it("treats empty content as FAILED_TO_VERIFY rather than 'everything was removed'", () => {
    const current = makeCurrent({ normalizedContent: "", contentHash: null, structuredDataHash: null });
    const prior = makePrior({ entities: [priceEntity()] });
    const result = compareSnapshots(prior, current);
    expect(result.verificationState).toBe("FAILED_TO_VERIFY");
    expect(result.changeEvents).toHaveLength(0);
  });

  it("treats the very first snapshot as a baseline (NO_CHANGE), not as a change", () => {
    const result = compareSnapshots(null, makeCurrent());
    expect(result.verificationState).toBe("NO_CHANGE");
    expect(result.changeEvents).toHaveLength(0);
  });

  it("reports NO_CHANGE when hashes are identical", () => {
    const result = compareSnapshots(makePrior(), makeCurrent());
    expect(result.verificationState).toBe("NO_CHANGE");
  });
});

describe("compareSnapshots - price changes", () => {
  it("detects a price decrease with the correct deterministic percentage and HIGH severity", () => {
    const prior = makePrior({ entities: [priceEntity({ value: "49.00" })] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity({ value: "39.00" })],
    });

    const result = compareSnapshots(prior, current);
    expect(result.verificationState).toBe("CHANGED");
    expect(result.changeEvents).toHaveLength(1);
    const event = result.changeEvents[0]!;
    expect(event.changeType).toBe("PRICE_CHANGE");
    expect(event.oldValue).toBe("49.00");
    expect(event.newValue).toBe("39.00");
    expect(event.percentageChange).toBeCloseTo(-20.41, 1);
    expect(event.severity).toBe("HIGH");
  });

  it("classifies a small price change as LOW severity", () => {
    const prior = makePrior({ entities: [priceEntity({ value: "100.00" })] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity({ value: "102.00" })],
    });
    const result = compareSnapshots(prior, current);
    expect(result.changeEvents[0]!.severity).toBe("LOW");
  });

  it("classifies a mid-size price change as MEDIUM severity", () => {
    const prior = makePrior({ entities: [priceEntity({ value: "100.00" })] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity({ value: "108.00" })],
    });
    const result = compareSnapshots(prior, current);
    expect(result.changeEvents[0]!.severity).toBe("MEDIUM");
  });

  it("does not emit a price-change event when the price is unchanged, even if surrounding page text changed", () => {
    const prior = makePrior({ entities: [priceEntity({ value: "49.00" })] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-a", // structured data unchanged
      normalizedContent: "Pro Plan 49 EUR - now with extra support!",
      entities: [priceEntity({ value: "49.00" })],
    });
    const result = compareSnapshots(prior, current);
    expect(result.verificationState).toBe("CHANGED");
    expect(result.changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(false);
    expect(result.changeEvents.some((e) => e.changeType === "CONTENT_CHANGE")).toBe(true);
  });
});

describe("compareSnapshots - product add/remove", () => {
  it("detects a newly added product/plan", () => {
    const prior = makePrior({ entities: [priceEntity({ key: "jsonld:pro plan" })] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity({ key: "jsonld:pro plan" }), priceEntity({ key: "jsonld:enterprise plan", label: "Enterprise Plan", value: "199.00" })],
    });
    const result = compareSnapshots(prior, current);
    const added = result.changeEvents.find((e) => e.changeType === "PRODUCT_ADDED");
    expect(added).toBeDefined();
    expect(added!.entityKey).toBe("jsonld:enterprise plan");
  });

  it("detects a removed product/plan", () => {
    const prior = makePrior({
      entities: [priceEntity({ key: "jsonld:pro plan" }), priceEntity({ key: "jsonld:enterprise plan", label: "Enterprise Plan", value: "199.00" })],
    });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity({ key: "jsonld:pro plan" })],
    });
    const result = compareSnapshots(prior, current);
    const removed = result.changeEvents.find((e) => e.changeType === "PRODUCT_REMOVED");
    expect(removed).toBeDefined();
    expect(removed!.entityKey).toBe("jsonld:enterprise plan");
  });

  it("does not treat unstable GENERIC (regex) entities as add/remove candidates", () => {
    const generic = (key: string): ExtractedEntity => ({
      type: "GENERIC",
      key,
      label: "some context",
      value: "39",
      currency: "EUR",
      raw: "€39",
    });
    const prior = makePrior({ entities: [generic("text-price:aaaa")] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [generic("text-price:bbbb")], // different hash key, same "kind" of entity
    });
    const result = compareSnapshots(prior, current);
    expect(result.changeEvents.some((e) => e.changeType === "PRODUCT_ADDED" || e.changeType === "PRODUCT_REMOVED")).toBe(
      false,
    );
  });
});

/**
 * Phase 23: Commercial Offer & Promotion Intelligence. Same byKey-diff
 * shape as price/product detection, but for the PROMOTION entity type
 * that structuredData.ts's extractPromotionSignal produces - see
 * compare.ts's detectPromotionChanges/detectPromotionAddedOrRemoved doc
 * comments.
 */
describe("compareSnapshots - promotion added/changed/removed", () => {
  it("detects a newly added promotion as PROMOTION_ADDED", () => {
    const prior = makePrior({ entities: [priceEntity()] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity(), promotionEntity()],
    });
    const result = compareSnapshots(prior, current);
    const added = result.changeEvents.find((e) => e.changeType === "PROMOTION_ADDED");
    expect(added).toBeDefined();
    expect(added!.newValue).toBe("discount=10");
    expect(added!.oldValue).toBeNull();
  });

  it("detects a materially changed promotion as PROMOTION_CHANGE, distinct from PRODUCT/PRICE events", () => {
    const prior = makePrior({ entities: [priceEntity(), promotionEntity({ value: "discount=10" })] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity(), promotionEntity({ value: "discount=20" })],
    });
    const result = compareSnapshots(prior, current);
    const changed = result.changeEvents.find((e) => e.changeType === "PROMOTION_CHANGE");
    expect(changed).toBeDefined();
    expect(changed!.oldValue).toBe("discount=10");
    expect(changed!.newValue).toBe("discount=20");
    expect(result.changeEvents.some((e) => e.changeType === "PROMOTION_ADDED" || e.changeType === "PROMOTION_REMOVED")).toBe(
      false,
    );
    expect(result.changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(false);
  });

  it("detects a removed promotion as PROMOTION_REMOVED, even while the underlying price stays unchanged", () => {
    const prior = makePrior({ entities: [priceEntity(), promotionEntity()] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity()], // promotion gone, price identical
    });
    const result = compareSnapshots(prior, current);
    const removed = result.changeEvents.find((e) => e.changeType === "PROMOTION_REMOVED");
    expect(removed).toBeDefined();
    expect(removed!.oldValue).toBe("discount=10");
    expect(removed!.newValue).toBeNull();
    expect(result.changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(false);
  });

  it("does not emit any promotion event when the promotion value is unchanged", () => {
    const prior = makePrior({ entities: [promotionEntity()] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-a",
      normalizedContent: "different visible text but promotion identical",
      entities: [promotionEntity()],
    });
    const result = compareSnapshots(prior, current);
    expect(
      result.changeEvents.some((e) => e.changeType === "PROMOTION_ADDED" || e.changeType === "PROMOTION_CHANGE" || e.changeType === "PROMOTION_REMOVED"),
    ).toBe(false);
  });

  it("emits both PRICE_CHANGE and PROMOTION_CHANGE when both change simultaneously on the same product", () => {
    const prior = makePrior({ entities: [priceEntity({ value: "49.00" }), promotionEntity({ value: "discount=10" })] });
    const current = makeCurrent({
      contentHash: "hash-b",
      structuredDataHash: "struct-b",
      entities: [priceEntity({ value: "39.00" }), promotionEntity({ value: "discount=20" })],
    });
    const result = compareSnapshots(prior, current);
    expect(result.changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(true);
    expect(result.changeEvents.some((e) => e.changeType === "PROMOTION_CHANGE")).toBe(true);
    // exactly one of each - never duplicated
    expect(result.changeEvents.filter((e) => e.changeType === "PRICE_CHANGE")).toHaveLength(1);
    expect(result.changeEvents.filter((e) => e.changeType === "PROMOTION_CHANGE")).toHaveLength(1);
  });

  it("never emits a promotion event on FAILED_TO_VERIFY (a fetch failure is never mistaken for a promotion removal)", () => {
    const prior = makePrior({ entities: [promotionEntity()] });
    const current = makeCurrent({ errorMessage: "Request timed out", entities: [] });
    const result = compareSnapshots(prior, current);
    expect(result.verificationState).toBe("FAILED_TO_VERIFY");
    expect(result.changeEvents).toHaveLength(0);
  });

  describe("price parsing and currency (Phase 29 C1)", () => {
    const changed = (priorEntity: ExtractedEntity, currentEntity: ExtractedEntity) =>
      compareSnapshots(
        makePrior({ entities: [priorEntity] }),
        makeCurrent({ contentHash: "hash-b", structuredDataHash: "struct-b", entities: [currentEntity] }),
      );

    it("reads European-format prices correctly: 1.299,00 -> 1.499,00 is +15.4%, not a 1000x error", () => {
      const result = changed(priceEntity({ value: "1.299,00" }), priceEntity({ value: "1.499,00" }));
      const event = result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      expect(event.percentageChange).toBe(15.4);
      expect(event.severity).toBe("HIGH");
    });

    it("does not report 10 -> 10.00 (same price, different formatting) as a price change", () => {
      const result = changed(priceEntity({ value: "10" }), priceEntity({ value: "10.00" }));
      expect(result.changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(false);
    });

    it("does not report the same amount in two locales as a price change", () => {
      const result = changed(priceEntity({ value: "1,299.00" }), priceEntity({ value: "1.299,00" }));
      expect(result.changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(false);
    });

    it("reports a currency change with the same number, with no percentage", () => {
      const result = changed(priceEntity({ value: "10", currency: "USD" }), priceEntity({ value: "10", currency: "EUR" }));
      const event = result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      expect(event).toBeDefined();
      expect(event.percentageChange).toBeNull();
      expect(event.evidenceExcerpt).toContain("currency changed USD -> EUR");
      expect(event.evidenceExcerpt).toContain("amount unchanged");
    });

    it("gives no percentage when the amount and the currency both changed", () => {
      const result = changed(priceEntity({ value: "10", currency: "USD" }), priceEntity({ value: "12", currency: "EUR" }));
      const event = result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      expect(event.percentageChange).toBeNull();
    });

    it("lowers confidence when the number has two valid readings", () => {
      const result = changed(priceEntity({ value: "1.299" }), priceEntity({ value: "1.499" }));
      expect(result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!.confidence).toBe(0.8);
    });

    it("still reports a free-to-paid move, without a percentage", () => {
      const result = changed(priceEntity({ value: "0" }), priceEntity({ value: "9.00" }));
      const event = result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      expect(event.percentageChange).toBeNull();
    });

    it("keeps reporting a non-numeric value change as evidenced, without a percentage", () => {
      const result = changed(priceEntity({ value: "Contact sales" }), priceEntity({ value: "From 99" }));
      const event = result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      expect(event.percentageChange).toBeNull();
    });
  });

  describe("extractor version (Phase 29 C2)", () => {
    it("treats a scan under a different extractor version as the new baseline, not as a change", () => {
      const prior = makePrior({ extractorVersion: 1, contentHash: "old-whole-body-hash", entities: [priceEntity({ value: "49.00" })] });
      const current = makeCurrent({
        extractorVersion: 2,
        contentHash: "new-main-region-hash",
        structuredDataHash: "struct-b",
        entities: [priceEntity({ value: "39.00" })],
      });
      const result = compareSnapshots(prior, current);
      expect(result.verificationState).toBe("NO_CHANGE");
      expect(result.changeEvents).toEqual([]);
      expect(result.reason).toContain("new baseline");
    });

    it("compares normally when both snapshots come from the same version", () => {
      const prior = makePrior({ extractorVersion: 2, entities: [priceEntity({ value: "49.00" })] });
      const current = makeCurrent({ extractorVersion: 2, contentHash: "hash-b", structuredDataHash: "struct-b", entities: [priceEntity({ value: "39.00" })] });
      expect(compareSnapshots(prior, current).changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(true);
    });

    it("compares normally when a version is not known (older callers)", () => {
      const prior = makePrior({ entities: [priceEntity({ value: "49.00" })] });
      const current = makeCurrent({ extractorVersion: 2, contentHash: "hash-b", structuredDataHash: "struct-b", entities: [priceEntity({ value: "39.00" })] });
      expect(compareSnapshots(prior, current).changeEvents.some((e) => e.changeType === "PRICE_CHANGE")).toBe(true);
    });

    it("still reports a failed extraction as FAILED_TO_VERIFY across versions", () => {
      const prior = makePrior({ extractorVersion: 1 });
      const current = makeCurrent({ extractorVersion: 2, errorMessage: "HTTP 403" });
      expect(compareSnapshots(prior, current).verificationState).toBe("FAILED_TO_VERIFY");
    });
  });

  describe("evidence per changed block, derived confidence, oscillation (Phase 29 C4)", () => {
    const FILLER = "Our platform helps teams ship faster with reliable tooling and friendly support every single day of the year.";

    it("shows WHAT changed in a CONTENT_CHANGE, not the first 300 characters of the page", () => {
      const prior = makePrior({ contentHash: "h1", normalizedContent: `${FILLER} Free trial lasts 14 days for everyone. Contact us anytime.` });
      const current = makeCurrent({ contentHash: "h2", normalizedContent: `${FILLER} Free trial lasts 30 days for everyone. Contact us anytime.` });
      const result = compareSnapshots(prior, current);
      const event = result.changeEvents.find((e) => e.changeType === "CONTENT_CHANGE")!;
      expect(event.oldValue).toBe("14");
      expect(event.newValue).toBe("30");
      expect(event.evidenceExcerpt).toContain("Free trial lasts [14 → 30] days for everyone");
      // The unchanged header text must not be what the evidence is made of.
      expect(event.evidenceExcerpt).not.toContain("Our platform helps teams");
    });

    it("still reports unrelated text that changed on the same page as a price change (it used to be suppressed)", () => {
      const prior = makePrior({
        contentHash: "h1",
        structuredDataHash: "s1",
        normalizedContent: `${FILLER} Pro Plan 49 EUR per month. Includes email support for all customers.`,
        entities: [priceEntity({ value: "49.00" })],
      });
      const current = makeCurrent({
        contentHash: "h2",
        structuredDataHash: "s2",
        normalizedContent: `${FILLER} Pro Plan 39 EUR per month. Includes phone and chat support for all customers.`,
        entities: [priceEntity({ value: "39.00" })],
      });
      const types = compareSnapshots(prior, current).changeEvents.map((e) => e.changeType);
      expect(types).toContain("PRICE_CHANGE");
      expect(types).toContain("CONTENT_CHANGE");
    });

    it("does not repeat a price change as a vague content change when the price digits are all that moved", () => {
      const prior = makePrior({ contentHash: "h1", structuredDataHash: "s1", normalizedContent: `${FILLER} Pro Plan 49 EUR per month.`, entities: [priceEntity({ value: "49.00" })] });
      const current = makeCurrent({ contentHash: "h2", structuredDataHash: "s2", normalizedContent: `${FILLER} Pro Plan 39 EUR per month.`, entities: [priceEntity({ value: "39.00" })] });
      const types = compareSnapshots(prior, current).changeEvents.map((e) => e.changeType);
      expect(types).toEqual(["PRICE_CHANGE"]);
    });

    it("does not repeat an added plan's whole card as a content change", () => {
      const prior = makePrior({ contentHash: "h1", structuredDataHash: "s1", normalizedContent: `${FILLER} Starter 9 USD`, entities: [priceEntity({ key: "plan:starter:month", label: "Starter", value: "9.00", currency: "USD" })] });
      const current = makeCurrent({
        contentHash: "h2",
        structuredDataHash: "s2",
        normalizedContent: `${FILLER} Starter 9 USD Team 59 USD 10 seats priority support`,
        entities: [
          priceEntity({ key: "plan:starter:month", label: "Starter", value: "9.00", currency: "USD" }),
          priceEntity({ key: "plan:team:month", label: "Team", value: "59.00", currency: "USD" }),
        ],
      });
      const types = compareSnapshots(prior, current).changeEvents.map((e) => e.changeType);
      expect(types).toEqual(["PRODUCT_ADDED"]);
    });

    it("derives confidence from the source of the entity and the quality of the extraction", () => {
      const run = (key: string, extractionConfidence?: number) => {
        const prior = makePrior({ entities: [priceEntity({ key, value: "100.00" })] });
        const current = makeCurrent({ contentHash: "h2", structuredDataHash: "s2", confidence: extractionConfidence, entities: [priceEntity({ key, value: "130.00" })] });
        return compareSnapshots(prior, current).changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      };
      expect(run("jsonld:pro").confidence).toBe(0.95);
      expect(run("plan:pro:month").confidence).toBe(0.87); // 0.95 x 0.92
      expect(run("jsonld:pro", 0.5).confidence).toBe(0.48);
    });

    it("shows a low-confidence event one severity level lower", () => {
      const prior = makePrior({ entities: [priceEntity({ key: "jsonld:pro", value: "100.00" })] });
      const current = makeCurrent({ contentHash: "h2", structuredDataHash: "s2", confidence: 0.5, entities: [priceEntity({ key: "jsonld:pro", value: "130.00" })] });
      const event = compareSnapshots(prior, current).changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      expect(event.severity).toBe("MEDIUM"); // +30% is HIGH, lowered because confidence 0.48 < 0.6
    });

    it("flags a price that flips back within 48h as a possible A/B test: LOW severity, half the confidence, reversal stated", () => {
      const now = new Date("2026-10-07T12:00:00Z");
      const prior = makePrior({ entities: [priceEntity({ value: "49.00" })] });
      const current = makeCurrent({ contentHash: "h2", structuredDataHash: "s2", entities: [priceEntity({ value: "39.00" })] });
      const result = compareSnapshots(prior, current, {
        now,
        recentEvents: [{ entityKey: "jsonld:pro plan", changeType: "PRICE_CHANGE", oldValue: "39.00", newValue: "49.00", currency: "EUR", detectedAt: new Date("2026-10-07T00:00:00Z") }],
      });
      const event = result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
      expect(event.severity).toBe("LOW");
      expect(event.confidence).toBe(0.48);
      expect(event.evidenceExcerpt).toContain("Reverts the change detected 12h ago");
    });

    it("does not flag a reversal that is older than 48h, a different entity, or a different direction", () => {
      const now = new Date("2026-10-07T12:00:00Z");
      const prior = makePrior({ entities: [priceEntity({ value: "49.00" })] });
      const current = makeCurrent({ contentHash: "h2", structuredDataHash: "s2", entities: [priceEntity({ value: "39.00" })] });
      const base = { entityKey: "jsonld:pro plan", changeType: "PRICE_CHANGE", oldValue: "39.00", newValue: "49.00", currency: "EUR" };
      for (const recent of [
        { ...base, detectedAt: new Date("2026-10-04T00:00:00Z") },
        { ...base, entityKey: "jsonld:other", detectedAt: new Date("2026-10-07T00:00:00Z") },
        { ...base, oldValue: "29.00", detectedAt: new Date("2026-10-07T00:00:00Z") },
      ]) {
        const event = compareSnapshots(prior, current, { now, recentEvents: [recent] }).changeEvents.find((e) => e.changeType === "PRICE_CHANGE")!;
        expect(event.severity).toBe("HIGH");
        expect(event.evidenceExcerpt).not.toContain("Reverts");
      }
    });
  });
});
