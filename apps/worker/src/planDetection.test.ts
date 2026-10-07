import { describe, expect, it } from "vitest";
import { CheerioExtractor, type FetchFn } from "@cma/extraction";
import { compareSnapshots, type PriorSnapshotData } from "@cma/detection";

/**
 * Phase 29 C3, end to end: a pricing page with NO JSON-LD (the common case) goes through the real
 * extractor and the real detector. Before C3 a price change on such a page surfaced only as a vague
 * "page content changed"; now it is a PRICE_CHANGE that names the plan.
 */
const card = (name: string, price: string) => `<div class="card"><h3>${name}</h3><p class="price">${price}<span>/month</span></p><ul><li>Feature</li></ul></div>`;
const page = (cards: string[]) =>
  `<html><body><header><nav><a>Home</a></nav></header><main><h1>Pricing</h1><p>Plans that scale with your team and your budget, month after month.</p><div class="grid">${cards.join("")}</div></main><footer>Terms</footer></body></html>`;

async function scan(html: string) {
  const fetchFn: FetchFn = async () => ({ status: 200, finalUrl: "https://rival.test/pricing", body: html });
  return new CheerioExtractor(fetchFn).extract({ url: "https://rival.test/pricing" });
}

const asPrior = (e: Awaited<ReturnType<typeof scan>>): PriorSnapshotData => ({
  extractorVersion: e.extractorVersion,
  contentHash: e.contentHash,
  structuredDataHash: e.structuredDataHash,
  normalizedContent: e.normalizedContent,
  entities: e.extractedEntities,
});

const asCurrent = (e: Awaited<ReturnType<typeof scan>>) => ({
  extractorVersion: e.extractorVersion,
  httpStatus: e.httpStatus,
  errorMessage: e.errorMessage,
  contentHash: e.contentHash,
  structuredDataHash: e.structuredDataHash,
  normalizedContent: e.normalizedContent,
  entities: e.extractedEntities,
});

describe("plan price detection without JSON-LD (Phase 29 C3)", () => {
  it("reports a price change on a card as PRICE_CHANGE naming the plan, with the percentage", async () => {
    const before = await scan(page([card("Starter", "$9"), card("Pro", "$29"), card("Business", "$99")]));
    const after = await scan(page([card("Starter", "$9"), card("Pro", "$39"), card("Business", "$99")]));

    expect(before.extractedEntities.map((e) => e.key)).toEqual(["plan:starter:month", "plan:pro:month", "plan:business:month"]);

    const result = compareSnapshots(asPrior(before), asCurrent(after));
    const events = result.changeEvents.filter((e) => e.changeType === "PRICE_CHANGE");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityKey: "plan:pro:month", oldValue: "29.00", newValue: "39.00", currency: "USD", percentageChange: 34.48 });
    expect(events[0]!.evidenceExcerpt).toContain("Pro (per month)");
    // The page text changed too, but the entity event explains it - not a vague content change as the only signal.
    expect(result.changeEvents.some((e) => e.changeType === "PRODUCT_ADDED" || e.changeType === "PRODUCT_REMOVED")).toBe(false);
  });

  it("detects a new plan and a removed plan by name", async () => {
    const before = await scan(page([card("Starter", "$9"), card("Pro", "$29")]));
    const after = await scan(page([card("Pro", "$29"), card("Team", "$59")]));
    const types = compareSnapshots(asPrior(before), asCurrent(after)).changeEvents.map((e) => `${e.changeType}:${e.entityKey}`);
    expect(types).toContain("PRODUCT_ADDED:plan:team:month");
    expect(types).toContain("PRODUCT_REMOVED:plan:starter:month");
  });

  it("is not fooled by a re-ordering of the cards or by a new banner and footer year", async () => {
    const before = await scan(page([card("Starter", "$9"), card("Pro", "$29")]));
    const reordered = page([card("Pro", "$29"), card("Starter", "$9")]).replace("<footer>Terms</footer>", "<footer>Terms &copy; 2027</footer><div class='cookie-banner'>Hi</div>");
    const result = compareSnapshots(asPrior(before), asCurrent(await scan(reordered)));
    expect(result.changeEvents.filter((e) => e.changeType === "PRICE_CHANGE" || e.changeType === "PRODUCT_ADDED" || e.changeType === "PRODUCT_REMOVED")).toEqual([]);
  });

  it("reads a locale change correctly: 1.299,00 EUR to 1.499,00 EUR is +15.4%", async () => {
    const tarif = (price: string) =>
      `<html><body><main><h1>Tarifs</h1><p>Des offres adaptees a chaque equipe, avec un engagement mensuel ou annuel selon vos besoins reels.</p><div><h3>Entreprise</h3><p><span class="amount">${price}</span> <span>par mois</span></p></div></main></body></html>`;
    const result = compareSnapshots(asPrior(await scan(tarif("1.299,00 &euro;"))), asCurrent(await scan(tarif("1.499,00 &euro;"))));
    expect(result.changeEvents.find((e) => e.changeType === "PRICE_CHANGE")).toMatchObject({ currency: "EUR", percentageChange: 15.4 });
  });
});
