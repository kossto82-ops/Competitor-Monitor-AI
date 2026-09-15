import { describe, expect, it } from "vitest";
import { CheerioExtractor } from "./cheerioExtractor.js";
import type { FetchFn } from "./types.js";

const jsonLdHtml = `
<html><body>
  <h1>Pro Plan</h1>
  <script type="application/ld+json">
    { "@type": "Product", "name": "Pro Plan", "offers": { "@type": "Offer", "price": "39.00", "priceCurrency": "EUR" } }
  </script>
</body></html>
`;

const genericPriceHtml = `
<html><body>
  <div class="price">Only €39 this month!</div>
</body></html>
`;

const spaShellHtml = `<html><body><div id="root"></div></body></html>`;

function fetchReturning(body: string, status = 200): FetchFn {
  return async () => ({ status, body, finalUrl: "https://competitor.test/pricing" });
}

describe("CheerioExtractor", () => {
  it("extracts a JSON-LD product price as a structured entity", async () => {
    const result = await new CheerioExtractor(fetchReturning(jsonLdHtml)).extract({
      url: "https://competitor.test/pricing",
    });

    expect(result.errorMessage).toBeNull();
    expect(result.extractedEntities).toHaveLength(1);
    expect(result.extractedEntities[0]).toMatchObject({
      type: "PRICE",
      value: "39.00",
      currency: "EUR",
      label: "Pro Plan",
    });
    expect(result.normalizedContent).toContain("Pro Plan");
    expect(result.structuredDataHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("falls back to generic price-pattern extraction when there is no JSON-LD", async () => {
    const result = await new CheerioExtractor(fetchReturning(genericPriceHtml)).extract({
      url: "https://competitor.test/pricing",
    });

    expect(result.extractedEntities).toHaveLength(1);
    expect(result.extractedEntities[0]).toMatchObject({ type: "GENERIC", value: "39", currency: "EUR" });
  });

  it("removes script/style content from the normalized visible text", async () => {
    const html = `<html><body><style>.x{color:red}</style><script>var x=1;</script><p>Real content</p></body></html>`;
    const result = await new CheerioExtractor(fetchReturning(html)).extract({ url: "https://competitor.test/" });

    expect(result.normalizedContent).toBe("Real content");
    expect(result.normalizedContent).not.toContain("color:red");
  });

  it("flags a likely SPA shell with a low-confidence warning instead of silently succeeding", async () => {
    const result = await new CheerioExtractor(fetchReturning(spaShellHtml)).extract({
      url: "https://competitor.test/",
    });

    expect(result.confidence).toBeLessThan(0.5);
    expect(result.warnings.some((w) => w.includes("client-rendered"))).toBe(true);
  });

  it("does not throw and reports failure material on a non-2xx status", async () => {
    const result = await new CheerioExtractor(fetchReturning("Too Many Requests", 429)).extract({
      url: "https://competitor.test/",
    });

    expect(result.errorMessage).toContain("429");
    expect(result.confidence).toBe(0);
    expect(result.contentHash).toBeNull();
  });

  it("does not throw when the fetch layer throws (e.g. SSRF block or timeout)", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("SsrfBlockedError: blocked");
    };
    const result = await new CheerioExtractor(fetchFn).extract({ url: "https://competitor.test/" });

    expect(result.errorMessage).toContain("SsrfBlockedError");
    expect(result.confidence).toBe(0);
  });

  it("produces the same content hash for the same text across two independent runs", async () => {
    const a = await new CheerioExtractor(fetchReturning(jsonLdHtml)).extract({ url: "https://competitor.test/" });
    const b = await new CheerioExtractor(fetchReturning(jsonLdHtml)).extract({ url: "https://competitor.test/" });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.structuredDataHash).toBe(b.structuredDataHash);
  });
});
