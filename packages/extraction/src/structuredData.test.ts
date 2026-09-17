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
