import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { extractHtmlPromotionEntities, mergeHtmlPromotionsWithJsonLd } from "./htmlPromotions.js";
import { extractJsonLdEntities } from "./structuredData.js";

/**
 * Phase 24: bounded, deterministic HTML promotion extraction. Several
 * of these fixtures are minimized reconstructions of real DOM shapes
 * found in dogfooding (Hostinger's discount-tag badge, ExpressVPN's
 * "Save X%" badge, Mailchimp's plan-named heading) - see the Phase 24
 * report's real-world validation table for the unmodified source pages.
 */
describe("extractHtmlPromotionEntities", () => {
  it("captures a percent-off badge inside a pricing card (Hostinger shape)", () => {
    const html = `
      <html><body>
        <div class="pricing-card">
          <div class="discount-tag"><span>75% off</span></div>
          <div class="title">Premium</div>
          <div class="price-container">
            <span class="old-price">$11.99</span>
            <span class="current-price">$2.99</span>
          </div>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: "PROMOTION", key: "html-promo:premium", label: "Premium", value: "percentOff=75" });
  });

  it("captures a 'Save X%' badge next to a plan duration and price (ExpressVPN shape)", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Basic</h3>
          <div class="badge">Save 80%</div>
          <p>2 Years + 4 Months</p>
          <p>Billed <span>$419.72</span> <span>$83.72</span></p>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ key: "html-promo:basic", label: "Basic", value: "percentOff=80" });
  });

  it("does NOT use a heading that itself contains the matched promo phrase as identity (fragile-identity guard, Mailchimp shape)", () => {
    // The only heading in this container is the one carrying the "50%
    // off" phrase itself - using it as identity would make the entity's
    // key change every time the discount value changes (a real
    // PROMOTION_CHANGE would misreport as REMOVED+ADDED). No other
    // resolvable label exists, so the conservative outcome is no entity.
    const html = `
      <html><body>
        <div class="single-plan">
          <h2>Try our Standard plan for <em>50% off</em>!</h2>
          <p>Only $10.00/mo for 12 months.</p>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("uses a separate, stable heading as identity even when a promo-embedding heading also exists in the same card", () => {
    const html = `
      <html><body>
        <div class="single-plan">
          <h3 class="plan-name">Standard</h3>
          <h2>Try our Standard plan for <em>50% off</em>!</h2>
          <p>Only $10.00/mo for 12 months.</p>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ key: "html-promo:standard", label: "Standard", value: "percentOff=50" });
  });

  it("does NOT fabricate an entity when no resolvable plan/product label exists in the container", () => {
    const html = `
      <html><body>
        <div class="card">
          <p>Get 20% off today. Price: $9.99/mo.</p>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("does NOT capture a promotional phrase with no price nearby within the bounded container-size cap (hero banner, ExpressVPN shape)", () => {
    // Realistic page scale matters here: on a real page the pricing
    // section sits far enough away (in characters of intervening markup)
    // that the container-size cap stops the ancestor climb before it
    // ever reaches a price - confirmed on the real ExpressVPN page in
    // dogfooding. This fixture pads the intervening content so the same
    // cap applies, rather than relying on an unrealistically tiny page.
    const filler = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(10);
    const html = `
      <html><body>
        <div class="hero">
          <h1>Stream and work securely from anywhere.</h1>
          <p>Get up to 80% off</p>
          <p>${filler}</p>
        </div>
        <section id="pricing">
          <div class="unrelated-card"><h3>Basic</h3><span>$2.99</span></div>
        </section>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("does NOT capture a bundled permanent feature described as '{feature} - free for N years' (Hostinger false-positive finding)", () => {
    const html = `
      <html><body>
        <div class="pricing-card">
          <h3>Premium</h3>
          <span>$2.99</span>
          <div class="features">
            <div>Domain - free for 1 year</div>
            <div>AI email marketing - free for 1 year</div>
          </div>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("captures a genuine free-duration promotion headline (not the dash-separated feature-list shape)", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Pro</h3>
          <div class="badge">3 months free</div>
          <span>$29.00/mo</span>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ key: "html-promo:pro", value: "freeDuration=3 MON" });
  });

  it("captures a 'first month free' phrasing", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Starter</h3>
          <div class="badge">First month free!</div>
          <span>$5.00/mo</span>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities[0]).toMatchObject({ key: "html-promo:starter", value: "freeDuration=1 MON" });
  });

  it("captures an explicit discount code phrased as 'Use code X'", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Team</h3>
          <p>Use code SAVE20 at checkout</p>
          <span>$49.00/mo</span>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities[0]).toMatchObject({ key: "html-promo:team", value: "discountCode=SAVE20" });
  });

  it("captures a 'Save $50' amount with currency", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Enterprise</h3>
          <div class="badge">Save $50</div>
          <span>$199.00/mo</span>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities[0]).toMatchObject({ key: "html-promo:enterprise", value: "saveAmount=50 USD", currency: "USD" });
  });

  it("ignores an unrelated percentage with no off/discount/save keyword (satisfaction rating)", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Premium</h3>
          <span>$2.99</span>
          <p>If you're not 100% satisfied, let us know within 30 days.</p>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("ignores a marketing statistic percentage ('141% more revenue')", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Standard</h3>
          <span>$13.00/mo</span>
          <p>Up to 141% more revenue with automations.</p>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("ignores a generic 'free plan'/'free account' mention (no numeric promo pattern)", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Free</h3>
          <span>$0.00</span>
          <p>Our free account includes free support and free shipping.</p>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("ignores promotional-sounding text embedded in a JSON-LD script block, not visible DOM (Audible false-positive finding)", () => {
    const html = `
      <html><body>
        <div class="plan-card"><h3>Standard</h3><span>$14.95/mo</span></div>
        <script type="application/ld+json">
          { "@type": "FAQPage", "mainEntity": [{ "@type": "Question", "name": "What benefits?",
            "acceptedAnswer": { "@type": "Answer", "text": "As a member you receive a 30% discount on purchases." } }] }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(html);
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });

  it("correctly associates each promotion with its own plan when multiple plan cards are on the page", () => {
    const html = `
      <html><body>
        <div class="plan-card"><h3>Plan A</h3><div class="badge">20% off</div><span>$10.00/mo</span></div>
        <div class="plan-card"><h3>Plan B</h3><span>$20.00/mo</span></div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ key: "html-promo:plan a", value: "percentOff=20" });
  });

  it("composes multiple distinct signals found for the same plan into one sorted signature", () => {
    const html = `
      <html><body>
        <div class="plan-card">
          <h3>Bundle</h3>
          <div class="badge">30% off</div>
          <p>Use code BUNDLE30 at checkout</p>
          <span>$70.00/mo</span>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const entities = extractHtmlPromotionEntities($);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.value).toBe("discountCode=BUNDLE30; percentOff=30");
  });

  it("does not throw on malformed/unclosed HTML", () => {
    const html = `<div class="plan-card"><h3>Broken<div class="badge">20% off<span>$5.00`;
    const $ = cheerio.load(html);
    expect(() => extractHtmlPromotionEntities($)).not.toThrow();
  });

  it("does not throw or crash on a completely empty document", () => {
    const $ = cheerio.load("");
    expect(extractHtmlPromotionEntities($)).toEqual([]);
  });
});

describe("mergeHtmlPromotionsWithJsonLd", () => {
  it("drops the HTML promotion when JSON-LD already reports the exact same numeric discount for the same product", () => {
    const jsonLdHtml = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Pro Plan", "offers": { "price": "39.00", "priceCurrency": "EUR", "discount": "20" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(jsonLdHtml);
    const jsonLd = extractJsonLdEntities($);

    const htmlEntities = [
      { type: "PROMOTION" as const, key: "html-promo:pro plan", label: "Pro Plan", value: "percentOff=20", currency: null, raw: "{}" },
    ];
    expect(mergeHtmlPromotionsWithJsonLd(jsonLd, htmlEntities)).toEqual([]);
  });

  it("keeps both entities when the JSON-LD promotion signal is NOT a discount field (e.g. priceValidUntil only - the real Hostinger case)", () => {
    const jsonLdHtml = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Web hosting", "offers": { "price": "2.99", "priceCurrency": "USD", "priceValidUntil": "2027-09-17" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(jsonLdHtml);
    const jsonLd = extractJsonLdEntities($);

    const htmlEntities = [
      { type: "PROMOTION" as const, key: "html-promo:premium", label: "Premium", value: "percentOff=75", currency: null, raw: "{}" },
    ];
    expect(mergeHtmlPromotionsWithJsonLd(jsonLd, htmlEntities)).toEqual(htmlEntities);
  });

  it("keeps the HTML entity when the numeric discount values differ (not the same fact)", () => {
    const jsonLdHtml = `
      <html><body>
        <script type="application/ld+json">
          { "@type": "Product", "name": "Pro Plan", "offers": { "price": "39.00", "priceCurrency": "EUR", "discount": "10" } }
        </script>
      </body></html>
    `;
    const $ = cheerio.load(jsonLdHtml);
    const jsonLd = extractJsonLdEntities($);

    const htmlEntities = [
      { type: "PROMOTION" as const, key: "html-promo:pro plan", label: "Pro Plan", value: "percentOff=20", currency: null, raw: "{}" },
    ];
    expect(mergeHtmlPromotionsWithJsonLd(jsonLd, htmlEntities)).toEqual(htmlEntities);
  });
});
