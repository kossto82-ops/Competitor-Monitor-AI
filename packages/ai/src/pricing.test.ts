import { describe, expect, it } from "vitest";
import { calculateCostUsd } from "./pricing.js";

describe("calculateCostUsd", () => {
  it("computes cost for a known provider/model from its published per-million-token price", () => {
    const cost = calculateCostUsd("openai", "gpt-4o-mini", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.15 + 0.6, 5);
  });

  it("returns null (never fabricates a number) for a model with no published pricing - e.g. this project's configured default", () => {
    expect(calculateCostUsd("openai", "gpt-5.6-luna", 1000, 500)).toBeNull();
  });

  it("returns null for any openai-compatible connection - customer-chosen models are never priced", () => {
    expect(calculateCostUsd("openai-compatible", "gpt-4o-mini", 1000, 500)).toBeNull();
  });

  it("returns null when token counts are unavailable, even for a known provider/model", () => {
    expect(calculateCostUsd("openai", "gpt-4o-mini", undefined, undefined)).toBeNull();
    expect(calculateCostUsd("openai", "gpt-4o-mini", 100, undefined)).toBeNull();
  });

  it("scales linearly with token count", () => {
    const small = calculateCostUsd("openai", "gpt-4o", 1000, 1000)!;
    const large = calculateCostUsd("openai", "gpt-4o", 10_000, 10_000)!;
    expect(large).toBeCloseTo(small * 10, 5);
  });
});
