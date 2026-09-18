import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { ExtractedEntity } from "@cma/core";
import { normalizeWhitespace } from "./structuredData.js";

/**
 * Phase 24 - bounded, deterministic HTML promotion extraction. This is
 * Tier 3's second promotion source alongside JSON-LD (structuredData.ts's
 * `extractJsonLdEntities`): real dogfooding (Hostinger, ExpressVPN,
 * Mailchimp - see PHASE24 report) showed that most competitor pages
 * express "20% off"/"Save 80%"/"3 months free" only as styled HTML text,
 * never as schema.org markup, so a JSON-LD-only extractor misses them
 * entirely. This module deliberately does NOT do general NLP/semantic
 * classification (no non-goal in the Phase 24 brief is more important
 * than this one) - it matches a small, fixed set of unambiguous numeric
 * promotional phrasings and REQUIRES structural proximity to a price
 * before trusting a match as a real commercial promotion, exactly the
 * same false-positive discipline Phase 22/23 applied to JSON-LD.
 */

const MAX_CANDIDATE_TEXT_LENGTH = 80;
const MAX_CANDIDATE_CHILDREN = 2;
const MAX_CLIMB_LEVELS = 8;
const MAX_CONTAINER_CHARS = 900;
const MAX_LABEL_LENGTH = 60;
const CANDIDATE_SELECTOR = "h1,h2,h3,h4,h5,h6,span,div,p,li,strong,em,b,a,button,label";

/**
 * The same currency-symbol price pattern `extractGenericPriceEntities`
 * uses, reused here purely as a structural signal ("is there a price
 * near this text?"), never as a price value in its own right.
 */
const PRICE_PATTERN = /[€$£]\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/;

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "$": "USD",
  "£": "GBP",
};

const WORD_NUMBERS: Record<string, string> = {
  one: "1",
  first: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  twelve: "12",
};

const UNIT_CODES: Record<string, string> = {
  day: "DAY",
  days: "DAY",
  week: "WEE",
  weeks: "WEE",
  month: "MON",
  months: "MON",
  year: "ANN",
  years: "ANN",
};

function wordOrDigitToNumber(token: string): string {
  const lower = token.toLowerCase();
  return WORD_NUMBERS[lower] ?? token;
}

interface PromotionMatch {
  field: "percentOff" | "freeDuration" | "discountCode" | "saveAmount";
  value: string;
  currency: string | null;
}

/**
 * Tries each bounded pattern against one short piece of text and returns
 * at most one match. Order matters: percent-off/save-percent are checked
 * before free-duration and discount-code because a phrase like "Save 20%
 * for 3 months" should register as a percentage, not a duration - but in
 * practice these phrasings rarely co-occur in one short leaf-text match,
 * since candidates are already bounded to <=80 chars of own text.
 */
function matchPromotionPattern(text: string): PromotionMatch | null {
  const percentOff = text.match(/\b(\d{1,3})\s?%\s*(?:off|discount)\b/i) ?? text.match(/\bsave\s+(?:up\s+to\s+)?(\d{1,3})\s?%/i);
  if (percentOff?.[1]) {
    return { field: "percentOff", value: percentOff[1], currency: null };
  }

  // Real dogfooding on Hostinger surfaced "Domain - free for 1 year" and
  // "AI email marketing - free for 1 year" inside the plan's bundled
  // FEATURES list - a permanent, standard-issue perk on every plan, not a
  // promotion that can meaningfully appear/disappear/change. The
  // "{feature name} - free for ..." shape is reliably marked by a
  // space-dash-space separator before the phrase; genuine promotional
  // headlines ("3 months free", "First month free!") do not use this
  // line-item punctuation, so excluding it is a real, evidence-driven
  // false-positive fix, not a guess.
  const looksLikeFeatureListLine = /\s-\s/.test(text);
  const freeDuration = looksLikeFeatureListLine
    ? null
    : text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|days|week|weeks|month|months|year|years)\s+free\b/i) ??
      text.match(/\bfree\s+for\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|days|week|weeks|month|months|year|years)\b/i) ??
      text.match(/\bfirst\s+(day|week|month|year)\s+free\b/i);
  if (freeDuration) {
    const amountToken = freeDuration[2] ? freeDuration[1] : "1";
    const unitToken = freeDuration[2] ?? freeDuration[1];
    if (amountToken && unitToken) {
      const unitCode = UNIT_CODES[unitToken.toLowerCase()];
      if (unitCode) {
        return { field: "freeDuration", value: `${wordOrDigitToNumber(amountToken)} ${unitCode}`, currency: null };
      }
    }
  }

  const discountCode = text.match(/\buse code\s+([A-Z][A-Z0-9]{2,19})\b/i);
  if (discountCode?.[1]) {
    return { field: "discountCode", value: discountCode[1].toUpperCase(), currency: null };
  }

  const saveAmount = text.match(/\bsave\s+([€$£])\s?(\d{1,4}(?:[.,]\d{2})?)\b/i);
  if (saveAmount?.[1] && saveAmount?.[2]) {
    const currency = CURRENCY_SYMBOLS[saveAmount[1]] ?? null;
    return { field: "saveAmount", value: `${saveAmount[2]} ${currency ?? saveAmount[1]}`, currency };
  }

  return null;
}

interface Candidate {
  el: AnyNode;
  matchedText: string;
  field: PromotionMatch["field"];
  value: string;
  currency: string | null;
}

/**
 * Scans a bounded set of "leaf-ish" elements (own text, at most a couple
 * of element children - e.g. a `<span>` badge or an `<em>` inline
 * emphasis) for a promotional phrase. Restricting to leaf-ish elements
 * with a short text bound keeps this a near-linear pass over the DOM's
 * text-bearing nodes, the same order of work `extractVisibleText` already
 * does - never a repeated full-page text scan per pattern.
 */
function collectCandidates($: cheerio.CheerioAPI): Candidate[] {
  const candidates: Candidate[] = [];
  $(CANDIDATE_SELECTOR).each((_, el) => {
    const $el = $(el);
    if ($el.children().length > MAX_CANDIDATE_CHILDREN) return;
    const text = normalizeWhitespace($el.text());
    if (text.length === 0 || text.length > MAX_CANDIDATE_TEXT_LENGTH) return;
    const match = matchPromotionPattern(text);
    if (match) {
      candidates.push({ el, matchedText: text, ...match });
    }
  });
  return candidates;
}

/** Keeps only the innermost match when a candidate element contains another candidate. */
function keepInnermost($: cheerio.CheerioAPI, candidates: Candidate[]): Candidate[] {
  return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && cheerio.contains(candidate.el, other.el)));
}

/**
 * Climbs ancestors up to MAX_CLIMB_LEVELS, tracking the LARGEST ancestor
 * whose text stays within MAX_CONTAINER_CHARS and which also contains a
 * price pattern. This is the structural "is this inside a product/plan
 * card?" gate (Section 2/12 of the brief) - real dogfooding on Hostinger
 * and ExpressVPN confirmed the plan-card container (title + price +
 * badge) sits at exactly this scale, while stopping at the character cap
 * prevents climbing far enough to spuriously associate a hero-banner
 * headline (no nearby price) with an unrelated pricing table elsewhere on
 * the same page.
 */
function findCommercialContainer($: cheerio.CheerioAPI, el: AnyNode): AnyNode | null {
  let current = $(el);
  let best: AnyNode | null = null;
  for (let i = 0; i < MAX_CLIMB_LEVELS; i++) {
    current = current.parent();
    if (current.length === 0) break;
    const text = normalizeWhitespace(current.text());
    if (text.length > MAX_CONTAINER_CHARS) break;
    if (PRICE_PATTERN.test(text)) {
      best = current.get(0) ?? null;
    }
  }
  return best;
}

/**
 * Looks for a short heading (or, failing that, an element whose class
 * plausibly names a plan/product) inside the commercial container to use
 * as the promotion's product/plan identity. Returns null - never a
 * fabricated fallback - when no such label can be found, per Section 5 of
 * the brief ("If a promotion cannot be reliably associated with a stable
 * commercial entity, do NOT manufacture one").
 */
function findPlanLabel($: cheerio.CheerioAPI, containerEl: AnyNode, matchEl: AnyNode, matchedText: string): string | null {
  const $container = $(containerEl);
  const matchedTextLower = matchedText.toLowerCase();

  // A label that itself contains the matched promotional phrase (e.g. an
  // <h2> reading "Try our Standard plan for 50% off!") would couple the
  // entity's identity to the promotion's own value - the exact fragile-
  // identity failure mode Phase 23 documented for content-hash keys: the
  // moment the discount changes, the "label" changes too, turning a real
  // PROMOTION_CHANGE into a spurious REMOVED+ADDED pair. Such a heading is
  // therefore never an acceptable identity source.
  const isUsableLabel = (candidate: AnyNode): string | null => {
    if (candidate === matchEl) return null;
    const label = normalizeWhitespace($(candidate).text());
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
    if (label.toLowerCase().includes(matchedTextLower)) return null;
    return label;
  };

  const heading = $container
    .find("h1,h2,h3,h4,h5,h6")
    .toArray()
    .map(isUsableLabel)
    .find((label): label is string => label !== null);
  if (heading) return heading;

  const titled = $container
    .find("*")
    .toArray()
    .filter((node) => /title|plan-name|product-name/.test(($(node).attr("class") ?? "").toLowerCase()))
    .map(isUsableLabel)
    .find((label): label is string => label !== null);
  if (titled) return titled;

  return null;
}

function composeSignature(fields: Partial<Record<PromotionMatch["field"], string>>): string {
  return Object.keys(fields)
    .sort()
    .map((field) => `${field}=${fields[field as PromotionMatch["field"]]}`)
    .join("; ");
}

/**
 * Tier 3, HTML source: bounded promotional-phrase detection gated behind
 * structural proximity to a price and a resolvable plan/product label.
 * Grouped by resolved plan label so multiple signals found for the same
 * plan (rare, but e.g. a percent-off badge AND a discount code on the
 * same card) compose into one deterministic, sorted signature string -
 * mirroring `extractJsonLdEntities`'s `extractPromotionSignal` composition
 * exactly, so both sources produce values in the same shape.
 */
export function extractHtmlPromotionEntities($: cheerio.CheerioAPI): ExtractedEntity[] {
  try {
    const candidates = keepInnermost($, collectCandidates($));

    interface Group {
      label: string;
      fields: Partial<Record<PromotionMatch["field"], string>>;
      currency: string | null;
      matchedTexts: string[];
      containerExcerpt: string;
    }
    const groups = new Map<string, Group>();

    for (const candidate of candidates) {
      const container = findCommercialContainer($, candidate.el);
      if (!container) continue;
      const label = findPlanLabel($, container, candidate.el, candidate.matchedText);
      if (!label) continue;

      const key = `html-promo:${label.toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        if (!(candidate.field in existing.fields)) {
          existing.fields[candidate.field] = candidate.value;
          existing.matchedTexts.push(candidate.matchedText);
          existing.currency = existing.currency ?? candidate.currency;
        }
        continue;
      }
      groups.set(key, {
        label,
        fields: { [candidate.field]: candidate.value },
        currency: candidate.currency,
        matchedTexts: [candidate.matchedText],
        containerExcerpt: normalizeWhitespace($(container).text()).slice(0, 300),
      });
    }

    const entities: ExtractedEntity[] = [];
    for (const [key, group] of groups) {
      entities.push({
        type: "PROMOTION",
        key,
        label: group.label,
        value: composeSignature(group.fields),
        currency: group.currency,
        raw: JSON.stringify({ matchedText: group.matchedTexts.join(" | "), containerExcerpt: group.containerExcerpt }),
      });
    }
    return entities;
  } catch {
    // Malformed/unexpected DOM shape must never break the whole extraction.
    return [];
  }
}

/**
 * Section 6 of the brief: JSON-LD and HTML must not both emit a
 * PROMOTION entity for the same underlying commercial fact. The only
 * equivalence this function is willing to assert is a narrow, mechanical
 * one - the SAME product/plan label AND a JSON-LD `discount=N` field
 * whose bare numeric value matches an HTML `percentOff=N` value exactly
 * (schema.org's own `Offer.discount` field is documented as the discount
 * amount, i.e. the same percentage a "20% off" badge expresses). Anything
 * less exact (a `priceValidUntil` date vs. a percent-off badge, as
 * happened on the real Hostinger page - see the Phase 24 report) is left
 * as two distinct entities on purpose: those are two different facts, not
 * two representations of the same fact, and this module does not
 * semantically decide otherwise.
 */
export function mergeHtmlPromotionsWithJsonLd(jsonLdEntities: ExtractedEntity[], htmlEntities: ExtractedEntity[]): ExtractedEntity[] {
  const jsonLdPromotions = jsonLdEntities.filter((e) => e.type === "PROMOTION");

  return htmlEntities.filter((html) => {
    const htmlPercent = html.value?.match(/(?:^|;\s*)percentOff=(\d{1,3})(?:;|$)/)?.[1];
    if (!htmlPercent) return true;

    const isDuplicate = jsonLdPromotions.some((jsonLd) => {
      if (jsonLd.label.trim().toLowerCase() !== html.label.trim().toLowerCase()) return false;
      const jsonLdDiscount = jsonLd.value?.match(/(?:^|;\s*)discount=(\d{1,3})(?:;|$)/)?.[1];
      return jsonLdDiscount !== undefined && jsonLdDiscount === htmlPercent;
    });
    return !isDuplicate;
  });
}
