import { describe, expect, it } from "vitest";
import { CheerioExtractor } from "./cheerioExtractor.js";
import type { FetchFn } from "./types.js";

const FILLER = "Plans and pricing for teams of every size, with monthly billing and the freedom to cancel at any time.";

const jsonLdHtml = `
<html><body>
  <h1>Pro Plan</h1>
  <p>${FILLER}</p>
  <script type="application/ld+json">
    { "@type": "Product", "name": "Pro Plan", "offers": { "@type": "Offer", "price": "39.00", "priceCurrency": "EUR" } }
  </script>
</body></html>
`;

const genericPriceHtml = `
<html><body>
  <p>${FILLER}</p>
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
    const html = `<html><body><style>.x{color:red}</style><script>var x=1;</script><p>Real content ${FILLER}</p></body></html>`;
    const result = await new CheerioExtractor(fetchReturning(html)).extract({ url: "https://competitor.test/" });

    expect(result.normalizedContent).toBe(`Real content ${FILLER}`);
    expect(result.normalizedContent).not.toContain("color:red");
  });

  it("treats an empty application shell as an unverified scan (a failure), not as a successful one with a warning", async () => {
    const result = await new CheerioExtractor(fetchReturning(spaShellHtml)).extract({
      url: "https://competitor.test/",
    });

    expect(result.errorMessage).toMatch(/client-rendered application/);
    expect(result.confidence).toBe(0);
    expect(result.contentHash).toBeNull();
    expect(result.extractedEntities).toEqual([]);
  });

  it("treats a nearly empty page (a block or error page) the same way", async () => {
    const result = await new CheerioExtractor(fetchReturning("<html><body><p>Access denied</p></body></html>")).extract({ url: "https://competitor.test/" });
    expect(result.errorMessage).toMatch(/too little readable content/);
  });

  it("does not take a server-rendered app with real text in its root for a shell", async () => {
    const html = `<html><body><div id="root"><h1>Pricing</h1><p>${FILLER}</p></div></body></html>`;
    const result = await new CheerioExtractor(fetchReturning(html)).extract({ url: "https://competitor.test/" });
    expect(result.errorMessage).toBeNull();
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

  it("does not fetch the page and reports a clear failure when robots.txt disallows it", async () => {
    let fetched = false;
    const fetchFn: FetchFn = async () => {
      fetched = true;
      return { status: 200, body: "<html></html>", finalUrl: "https://a.test/pricing" };
    };
    const extractor = new CheerioExtractor(fetchFn, { isAllowed: async () => false });
    const result = await extractor.extract({ url: "https://a.test/pricing" });
    expect(fetched).toBe(false);
    expect(result.errorMessage).toMatch(/robots\.txt/);
    expect(result.extractedEntities).toEqual([]);
  });

  it("fetches normally when robots.txt allows the page", async () => {
    const fetchFn: FetchFn = async () => ({ status: 200, body: `<html><body><p>${FILLER}</p><p>Pro $10</p></body></html>`, finalUrl: "https://a.test/pricing" });
    const extractor = new CheerioExtractor(fetchFn, { isAllowed: async () => true });
    const result = await extractor.extract({ url: "https://a.test/pricing" });
    expect(result.errorMessage).toBeNull();
  });

  it("surfaces an unsupported content type as an ordinary failed extraction, not a throw", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('Unsupported content type "application/pdf" - only web pages can be monitored.');
    };
    const result = await new CheerioExtractor(fetchFn).extract({ url: "https://a.test/file" });
    expect(result.errorMessage).toMatch(/Unsupported content type/);
  });

  it("returns notModified (and no content) when the server answers 304 to a conditional request", async () => {
    let seen: unknown;
    const fetchFn: FetchFn = async (_url, conditional) => {
      seen = conditional;
      return { status: 304, body: "", finalUrl: "https://a.test/pricing" };
    };
    const result = await new CheerioExtractor(fetchFn).extract({ url: "https://a.test/pricing", conditional: { etag: '"v1"', lastModified: null } });
    expect(seen).toEqual({ etag: '"v1"', lastModified: null });
    expect(result.notModified).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.extractedEntities).toEqual([]);
  });

  it("treats a 304 as an error when no validators were sent (it cannot mean unchanged)", async () => {
    const fetchFn: FetchFn = async () => ({ status: 304, body: "", finalUrl: "https://a.test/pricing" });
    const result = await new CheerioExtractor(fetchFn).extract({ url: "https://a.test/pricing" });
    expect(result.notModified).toBeUndefined();
    expect(result.errorMessage).toMatch(/304/);
  });

  it("surfaces the response validators on a successful full fetch", async () => {
    const fetchFn: FetchFn = async () => ({
      status: 200,
      body: `<html><body><p>${FILLER}</p><p>Pro $10</p></body></html>`,
      finalUrl: "https://a.test/pricing",
      headers: { etag: '"v2"', lastModified: null },
    });
    const result = await new CheerioExtractor(fetchFn).extract({ url: "https://a.test/pricing" });
    expect(result.validators).toEqual({ etag: '"v2"', lastModified: null });
  });
});
