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

  const offer = extractOffer(obj["offers"]);
  if (offer && type !== undefined && COMMERCIAL_OFFER_TYPES.has(type)) {
    out.push({
      type: "PRICE",
      key: `jsonld:${name ?? "unknown"}`.toLowerCase(),
      label: name ?? "Unnamed product",
      value: offer.price,
      currency: offer.currency,
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
