import * as cheerio from "cheerio";
import type { ExtractedEntity } from "@cma/core";
import { sha256 } from "./hash.js";

/**
 * Collapse all whitespace runs to a single space and trim. This is the
 * one normalization step applied before hashing/diffing visible text -
 * deliberately NOT lowercasing, since a real wording change ("Sale" ->
 * "sale") should still be able to surface as a content change; only
 * incidental formatting noise (extra spaces/newlines from a template
 * change) is ignored.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function extractVisibleText($: cheerio.CheerioAPI): string {
  const $body = $("body").clone();
  $body.find("script, style, noscript, svg").remove();
  return normalizeWhitespace($body.text());
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "$": "USD",
  "£": "GBP",
};

/**
 * Structured-data pass, tier 3 of the extraction ladder: JSON-LD
 * (schema.org Product/Offer) is the highest-confidence source because
 * it is machine-readable by design, not scraped from rendered layout.
 */
export function extractJsonLdEntities($: cheerio.CheerioAPI): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // One malformed JSON-LD block must not break the whole extraction.
    }

    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      collectProductLikeEntities(node, entities, raw);
    }
  });

  return entities;
}

/**
 * Schema.org types whose `offers.price` genuinely describes something a
 * customer pays for. Deliberately excludes generic types like
 * `SoftwareApplication` or `Organization`: sites commonly attach an
 * `offers: { category: "free", price: 0 }` block to a SoftwareApplication
 * node purely for app-store/rich-snippet SEO (the "this app is free to
 * download" signal), which has nothing to do with the paid plans shown
 * on the page. Capturing that as a PRICE entity produced a real false
 * signal in dogfooding: Dropbox's own /plans page was extracted as a
 * single "$0 Dropbox" price alongside (and indistinguishable from) its
 * actual $9.99+/mo plans (Phase 22 dogfooding finding).
 */
const COMMERCIAL_OFFER_TYPES = new Set(["Product", "Offer", "Service"]);

function collectProductLikeEntities(node: unknown, out: ExtractedEntity[], raw: string): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  const type = typeof obj["@type"] === "string" ? (obj["@type"] as string) : undefined;
  const name = typeof obj["name"] === "string" ? (obj["name"] as string) : undefined;
  const isCommercialEntity = type !== undefined && COMMERCIAL_OFFER_TYPES.has(type);

  const offer = extractOffer(obj["offers"]);
  if (offer && isCommercialEntity) {
    out.push({
      type: "PRICE",
      key: `jsonld:${name ?? "unknown"}`.toLowerCase(),
      label: name ?? "Unnamed product",
      value: offer.price,
      currency: offer.currency,
      raw,
    });
  }

  // Phase 23: same commercial-entity gate as the PRICE entity above (see
  // COMMERCIAL_OFFER_TYPES's doc comment / Phase 22 dogfooding finding) -
  // a promotion attached to a non-commercial node (Organization,
  // SoftwareApplication SEO offer, etc.) is never captured.
  const promotion = isCommercialEntity ? extractPromotionSignal(obj["offers"]) : null;
  if (promotion) {
    out.push({
      type: "PROMOTION",
      key: `jsonld-promo:${name ?? "unknown"}`.toLowerCase(),
      label: name ?? "Unnamed product",
      value: promotion.summary,
      currency: promotion.currency,
      raw,
    });
  }

  // Recurse into nested @graph arrays, common in real-world JSON-LD.
  if (Array.isArray(obj["@graph"])) {
    for (const child of obj["@graph"] as unknown[]) {
      collectProductLikeEntities(child, out, raw);
    }
  }
}

function extractOffer(offers: unknown): { price: string; currency: string | null } | null {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== "object") return null;
  const obj = offer as Record<string, unknown>;
  const price = obj["price"] ?? obj["lowPrice"];
  if (price === undefined || price === null) return null;
  const currency = typeof obj["priceCurrency"] === "string" ? (obj["priceCurrency"] as string) : null;
  return { price: String(price), currency };
}

/**
 * The four schema.org `Offer` fields that genuinely, unambiguously
 * signal a promotional/temporary commercial condition rather than a
 * plain standing price. Deliberately NOT included: `description`
 * (arbitrary free text - the exact kind of unbounded signal Phase 22's
 * dogfooding showed produces false positives) and `availability` (present
 * on virtually every Offer regardless of any promotion, would fire on
 * almost every page). A site's own wording ("Save 20%", "3 months on us")
 * is real evidence when it lives inside one of these four fields - schema.org
 * authors put it there specifically to describe the commercial condition -
 * but the same sentence sitting in a generic `description` is not
 * distinguishable from ordinary marketing copy without semantic
 * interpretation, which this deterministic layer does not perform.
 */
const PROMOTION_SIGNAL_FIELDS = ["discount", "discountCode", "priceValidUntil", "eligibleDuration"] as const;

/**
 * Normalizes one of the four signal fields to a short, deterministic
 * string. `eligibleDuration` in particular is commonly a nested
 * QuantitativeValue object (`{ "@type": "QuantitativeValue", "value": 1,
 * "unitCode": "MON" }`, e.g. "1 month free") - flattened to `1 MON` here
 * rather than JSON-stringified so the same duration always normalizes to
 * the same literal string across scans/sites, and a malformed/partial
 * object degrades to `null` (excluded) rather than throwing.
 */
function normalizePromotionFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const amount = obj["value"];
    const unit = obj["unitCode"] ?? obj["unitText"];
    if ((typeof amount === "number" || typeof amount === "string") && typeof unit === "string") {
      return `${amount} ${unit}`;
    }
    // No recognizable QuantitativeValue shape - don't guess at a
    // representation for an arbitrary nested object.
    return null;
  }
  return null;
}

/**
 * Builds a deterministic, sorted `field=value; field=value` signature
 * from whichever of PROMOTION_SIGNAL_FIELDS are actually present on the
 * offer - returns null (no PROMOTION entity at all) unless at least one
 * signal field is present, per the module's false-positive-avoidance
 * principle (Section 6 of the Phase 23 brief: "False negatives are
 * preferable to fabricated continuity"). The composed string is never
 * semantically interpreted (a "20" vs "20%" vs "0.2" discount are three
 * distinct literal strings, not reconciled) - see compare.ts's
 * detectPromotionChanges for how this string is later diffed.
 */
function extractPromotionSignal(offers: unknown): { summary: string; currency: string | null } | null {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== "object") return null;
  const obj = offer as Record<string, unknown>;

  const parts: string[] = [];
  for (const field of PROMOTION_SIGNAL_FIELDS) {
    const normalized = normalizePromotionFieldValue(obj[field]);
    if (normalized !== null) parts.push(`${field}=${normalized}`);
  }
  if (parts.length === 0) return null;

  const currency = typeof obj["priceCurrency"] === "string" ? (obj["priceCurrency"] as string) : null;
  return { summary: parts.join("; "), currency };
}

/**
 * Best-effort fallback for pages with no JSON-LD: a currency-symbol
 * price pattern in the visible text, keyed by a hash of its immediate
 * surrounding context so the same on-page price can be matched again
 * across scans even though we have no product name to anchor it to.
 */
export function extractGenericPriceEntities(text: string): ExtractedEntity[] {
  const pattern = /([€$£])\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/g;
  const entities: ExtractedEntity[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const [full, symbol, amount] = match;
    if (!symbol || !amount) continue;
    const start = Math.max(0, match.index - 25);
    const context = text.slice(start, match.index + full.length + 10);
    entities.push({
      type: "GENERIC",
      key: `text-price:${sha256(context).slice(0, 16)}`,
      label: context.trim(),
      value: amount.replace(/\./g, "").replace(",", "."),
      currency: CURRENCY_SYMBOLS[symbol] ?? null,
      raw: full,
    });
  }

  return entities;
}

/**
 * Heuristic signal that a page is a client-rendered SPA shell that
 * plain HTTP + Cheerio cannot see through (Tier 5/Playwright territory
 * later - Phase 1 only flags it, doesn't act on it).
 */
export function looksLikeJsShell($: cheerio.CheerioAPI, visibleText: string): boolean {
  const rootLike = $("#root, #app, #__next").first();
  const hasEmptyAppRoot = rootLike.length > 0 && normalizeWhitespace(rootLike.text()).length < 20;
  const veryShortBody = visibleText.length < 40;
  return hasEmptyAppRoot || veryShortBody;
}
