import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { extractJsonLdEntities } from "./structuredData.js";

/**
 * Phase 22 dogfooding finding: monitoring the real Dropbox /plans page
 * produced a single ExtractedEntity — { label: "Dropbox", value: "0",
 * currency: "USD" } — sourced from a `SoftwareApplication` JSON-LD block
 * that Dropbox embeds purely for app-store/rich-snippet SEO
 * (`offers: { category: "free", price: 0 }`), unrelated to the paid
 * plans actually shown on the page. That entity was indistinguishable
 * from a real tracked price and would have produced a misleading
 * "price changed" ChangeEvent the moment it was next compared against
 * a real plan price. These tests lock in the fix: only schema.org
 * types that genuinely represent something for sale (Product/Offer/
 * Service) are captured.
 */
describe("extractJsonLdEntities", () => {
  it("does not capture a SoftwareApplication's app-store 'free' offer as a price", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": "Dropbox",
            "offers": { "@type": "Offer", "category": "free", "price": 0, "priceCurrency": "USD" }
          }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractJsonLdEntities($)).toEqual([]);
  });

  it("still captures a genuine Product/Offer price", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Pro Plan", "offers": { "@type": "Offer", "price": "39.00", "priceCurrency": "EUR" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractJsonLdEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ label: "Pro Plan", value: "39.00", currency: "EUR" });
  });

  it("still captures a Service offer price", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Service", "name": "Managed Hosting", "offers": { "price": "9.99", "priceCurrency": "USD" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractJsonLdEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ label: "Managed Hosting", value: "9.99", currency: "USD" });
  });

  it("ignores an Organization node that happens to carry an offers block", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Organization", "name": "Acme Inc", "offers": { "price": "0", "priceCurrency": "USD" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractJsonLdEntities($)).toEqual([]);
  });

  it("recurses into @graph and applies the same type filter to nested nodes", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          {
            "@graph": [
              { "@type": "SoftwareApplication", "name": "App", "offers": { "price": 0, "priceCurrency": "USD" } },
              { "@type": "Product", "name": "Team Plan", "offers": { "price": "19", "priceCurrency": "USD" } }
            ]
          }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractJsonLdEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.label).toBe("Team Plan");
  });

  it("ignores malformed JSON-LD without throwing", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">{ not valid json </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractJsonLdEntities($)).toEqual([]);
  });
});

/**
 * Phase 23: Commercial Offer & Promotion Intelligence. A PROMOTION
 * entity is only ever emitted when the offer carries one of the four
 * explicit, unambiguous schema.org signal fields (discount,
 * discountCode, priceValidUntil, eligibleDuration) - see
 * PROMOTION_SIGNAL_FIELDS's doc comment in structuredData.ts for why
 * `description`/`availability` are deliberately excluded as triggers.
 */
describe("extractJsonLdEntities - promotion/offer extraction", () => {
  it("captures an explicit percentage discount on a Product offer", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Pro Plan", "offers": { "@type": "Offer", "price": "39.00", "priceCurrency": "EUR", "discount": "20" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractJsonLdEntities($);
    const price = entities.find((e) => e.type === "PRICE");
    const promo = entities.find((e) => e.type === "PROMOTION");
    expect(price).toMatchObject({ value: "39.00" });
    expect(promo).toMatchObject({ key: "jsonld-promo:pro plan", value: "discount=20", currency: "EUR" });
  });

  it("captures a free-trial duration expressed as a QuantitativeValue", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          {
            "@type": "Service", "name": "Managed Hosting",
            "offers": { "price": "9.99", "priceCurrency": "USD",
              "eligibleDuration": { "@type": "QuantitativeValue", "value": 1, "unitCode": "MON" } }
          }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const promo = extractJsonLdEntities($).find((e) => e.type === "PROMOTION");
    expect(promo).toMatchObject({ value: "eligibleDuration=1 MON" });
  });

  it("composes multiple present signal fields into one deterministic, sorted signature", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Team Plan", "offers": {
            "price": "19", "priceCurrency": "USD",
            "discountCode": "SAVE20", "discount": "20", "priceValidUntil": "2026-12-31" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const promo = extractJsonLdEntities($).find((e) => e.type === "PROMOTION");
    expect(promo?.value).toBe("discount=20; discountCode=SAVE20; priceValidUntil=2026-12-31");
  });

  it("does NOT emit a PROMOTION entity from `description` or `availability` alone", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Basic Plan", "offers": {
            "price": "9", "priceCurrency": "USD",
            "availability": "https://schema.org/InStock",
            "description": "Save big this Black Friday!" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractJsonLdEntities($);
    expect(entities.some((e) => e.type === "PROMOTION")).toBe(false);
    expect(entities).toHaveLength(1); // only the PRICE entity
  });

  it("never captures a promotion signal from a non-commercial node (Phase 22 safeguard applies identically)", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "SoftwareApplication", "name": "App", "offers": { "price": 0, "priceCurrency": "USD", "discount": "50" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractJsonLdEntities($)).toEqual([]);
  });

  it("handles a malformed eligibleDuration object safely (no crash, no fabricated value)", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Weird Plan", "offers": {
            "price": "10", "priceCurrency": "USD", "eligibleDuration": { "foo": "bar" } } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(() => extractJsonLdEntities($)).not.toThrow();
    const entities = extractJsonLdEntities($);
    expect(entities.some((e) => e.type === "PROMOTION")).toBe(false);
  });

  it("handles a missing offers block safely", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "No Offer Plan" }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractJsonLdEntities($)).toEqual([]);
  });
});
