import * as cheerio from "cheerio";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanBody } from "./structuredData.js";
import { extractPricingPlans, planToEntity, plansToEntities } from "./pricingPlans.js";

/**
 * Phase 29 C3: the pricing extractor is measured, not just unit tested. Every fixture in
 * test-corpus/pricing is an HTML page modelled on a real pricing-page structure (cards, toggles,
 * tables, localized formats, struck-through prices, banners and footers that also contain prices) with
 * the plans a human reads in it listed in expected.json. The suite computes precision and recall over
 * the whole corpus and fails if either drops below the floor - a regression in the heuristics shows up
 * as a number, not as a vague "it seems worse".
 */
const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test-corpus", "pricing");
const expected = JSON.parse(readFileSync(join(corpusDir, "expected.json"), "utf8")) as Record<
  string,
  { name: string; amount: number; currency: string | null; period: "month" | "year" | null }[]
>;

const keyOf = (p: { name: string; amount: number; currency: string | null; period: string | null }) =>
  `${p.name.toLowerCase()}|${p.amount.toFixed(2)}|${p.currency}|${p.period}`;

function extract(file: string) {
  const $ = cheerio.load(readFileSync(join(corpusDir, file), "utf8"));
  return extractPricingPlans($, cleanBody($));
}

const PRECISION_FLOOR = 0.95;
const RECALL_FLOOR = 0.95;

describe("pricing extractor corpus (Phase 29 C3)", () => {
  const files = readdirSync(corpusDir).filter((f) => f.endsWith(".html"));

  it("has a fixture for every entry in expected.json and vice versa", () => {
    expect(files.sort()).toEqual(Object.keys(expected).sort());
  });

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const file of files) {
    it(`extracts exactly the plans a human reads in ${file}`, () => {
      const got = new Set(extract(file).map(keyOf));
      const want = new Set((expected[file] ?? []).map(keyOf));
      const missing = [...want].filter((k) => !got.has(k));
      const extra = [...got].filter((k) => !want.has(k));
      truePositives += [...want].filter((k) => got.has(k)).length;
      falseNegatives += missing.length;
      falsePositives += extra.length;
      expect({ missing, extra }, file).toEqual({ missing: [], extra: [] });
    });
  }

  it(`meets the corpus floors (precision >= ${PRECISION_FLOOR}, recall >= ${RECALL_FLOOR})`, () => {
    const precision = truePositives / Math.max(1, truePositives + falsePositives);
    const recall = truePositives / Math.max(1, truePositives + falseNegatives);
    console.log(
      `pricing corpus: ${files.length} pages, ${truePositives} correct, ${falsePositives} spurious, ${falseNegatives} missed -> precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)}`,
    );
    expect(precision).toBeGreaterThanOrEqual(PRECISION_FLOOR);
    expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });
});

describe("planToEntity", () => {
  it("gives a stable key from the plan name and period, a canonical value, and a short raw", () => {
    const entity = planToEntity({ name: "Pro Plan", amount: 29, currency: "USD", period: "month", token: "$29" });
    expect(entity).toEqual({
      type: "PRICE",
      key: "plan:pro-plan:month",
      label: "Pro Plan (per month)",
      value: "29.00",
      currency: "USD",
      raw: "$29",
    });
  });

  it("keeps the key stable across accents, case and spacing", () => {
    const a = planToEntity({ name: "  Entreprise ", amount: 1, currency: "EUR", period: null, token: "1 €" });
    const b = planToEntity({ name: "ENTREPRISE", amount: 2, currency: "EUR", period: null, token: "2 €" });
    expect(a.key).toBe(b.key);
    expect(a.key).toBe("plan:entreprise:na");
  });
});

describe("plansToEntities (history replay)", () => {
  const plan = (name: string, period: "month" | "year" | null, amount = 10) => ({ name, amount, currency: "USD", period, token: `$${amount}` });

  it("keys a plan by its name alone, so a period that appears or disappears between captures is not a rename", () => {
    const withPeriod = plansToEntities([plan("Premium", "month"), plan("Standard", "month")]);
    const withoutPeriod = plansToEntities([plan("Premium", null), plan("Standard", null)]);
    expect(withPeriod.map((e) => e.key)).toEqual(["plan:premium", "plan:standard"]);
    expect(withoutPeriod.map((e) => e.key)).toEqual(["plan:premium", "plan:standard"]);
  });

  it("adds the period to the key only for a plan the page lists more than once", () => {
    const entities = plansToEntities([plan("Pro", "month", 10), plan("Pro", "year", 96), plan("Team", "month", 30)]);
    expect(entities.map((e) => e.key)).toEqual(["plan:pro:month", "plan:pro:year", "plan:team"]);
  });
});
