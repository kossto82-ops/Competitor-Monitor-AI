import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { disambiguateKeys, extractJsonLdEntities } from "./structuredData.js";

const ld = (json: unknown) => cheerio.load(`<html><body><script type="application/ld+json">${JSON.stringify(json)}</script></body></html>`);

describe("entity identity (Phase 29 C5)", () => {
  it("reads every offer of a product, not just the first", () => {
    const entities = extractJsonLdEntities(
      ld({
        "@type": "Product",
        name: "Pro Plan",
        offers: [
          { "@type": "Offer", price: "10", priceCurrency: "USD" },
          { "@type": "Offer", price: "96", priceCurrency: "USD" },
        ],
      }),
    );
    expect(entities.map((e) => [e.key, e.value])).toEqual([
      ["jsonld:pro plan", "10"],
      ["jsonld:pro plan#2", "96"],
    ]);
  });

  it("keeps the historical key for the first occurrence and numbers later duplicates in order", () => {
    const entities = extractJsonLdEntities(
      ld([
        { "@type": "Product", name: "Basic", offers: { price: "5", priceCurrency: "EUR" } },
        { "@type": "Product", name: "Basic", offers: { price: "7", priceCurrency: "EUR" } },
        { "@type": "Product", name: "Basic", offers: { price: "9", priceCurrency: "EUR" } },
      ]),
    );
    expect(entities.map((e) => e.key)).toEqual(["jsonld:basic", "jsonld:basic#2", "jsonld:basic#3"]);
  });

  it("still ignores offers without a price and non-commercial nodes", () => {
    expect(extractJsonLdEntities(ld({ "@type": "Product", name: "X", offers: [{ "@type": "Offer" }, { price: "3", priceCurrency: "USD" }] })).map((e) => e.value)).toEqual(["3"]);
    expect(extractJsonLdEntities(ld({ "@type": "SoftwareApplication", name: "App", offers: { price: "0" } }))).toEqual([]);
  });

  it("disambiguateKeys leaves unique keys alone and is deterministic", () => {
    const base = { type: "PRICE" as const, label: "x", value: "1", currency: null, raw: "" };
    const input = [{ ...base, key: "a" }, { ...base, key: "b" }, { ...base, key: "a" }];
    const out = disambiguateKeys(input);
    expect(out.map((e) => e.key)).toEqual(["a", "b", "a#2"]);
    expect(disambiguateKeys(input).map((e) => e.key)).toEqual(out.map((e) => e.key));
  });
});
