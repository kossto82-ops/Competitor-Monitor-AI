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
