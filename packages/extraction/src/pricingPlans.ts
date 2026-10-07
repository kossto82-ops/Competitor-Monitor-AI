import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { detectCurrency, parseAmount, type ExtractedEntity } from "@cma/core";
import { normalizeWhitespace } from "./structuredData.js";

/**
 * Phase 29 C3: deterministic extraction of priced plans (name + price + period) from pricing cards and
 * pricing tables, for pages that carry no JSON-LD. Before this, such pages produced only context-hashed
 * `GENERIC` price strings that never entered the diff, so a price change surfaced as a vague
 * "page content changed".
 *
 * Principles (same as the rest of the deterministic layer):
 *  - Evidence only: every entity is a price literally present in the page next to a plan name that is
 *    literally present in the same card/column. Nothing is inferred.
 *  - False negatives over fabricated continuity: when a card is ambiguous (two plans share a container
 *    with no way to tell which price is whose), nothing is emitted.
 *  - Struck-through (old) prices are never taken as the plan's price.
 *
 * Known limits: prices split across several elements with their own cents (`$49<sup>99</sup>`) are read
 * as whole amounts only; "Free" plans are only captured when a `$0`-style price is written; plans whose
 * name sits outside the card (a shared header row of a CSS grid) are skipped.
 */

export interface PlanPrice {
  name: string;
  amount: number;
  currency: string | null;
  period: "month" | "year" | null;
  /** The price exactly as written, e.g. "$49" or "1.299,00 €". */
  token: string;
}

const AMOUNT =
  "(?:\\d{1,3}(?:[.,'\\u00a0\\u202f ]\\d{3}(?!\\d))+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
// A bare symbol must not be the tail of a longer prefix: "A$ 89" is Australian dollars, never "$ 89".
const PREFIXED = `(?:US\\$|CA\\$|AU\\$|NZ\\$|HK\\$|MX\\$|A\\$|C\\$|S\\$|R\\$|(?<![A-Za-z])[€£¥₹₩₽₺₪฿₱$]|\\b[A-Z]{3}(?=\\s?\\d))\\s?${AMOUNT}`;
const SUFFIXED = `${AMOUNT}\\s?(?:€|£|zł|Kč|₽|₺|₪|\\b[A-Z]{3}\\b)`;
const PRICE_TOKEN = new RegExp(`${PREFIXED}|${SUFFIXED}`, "g");

export interface PriceToken {
  token: string;
  amount: number;
  currency: string | null;
}

export function findPriceTokens(text: string): PriceToken[] {
  const out: PriceToken[] = [];
  for (const match of text.matchAll(PRICE_TOKEN)) {
    const token = match[0].trim();
    const currency = detectCurrency(token);
    if (!currency) continue; // an all-caps word followed by a number is not a price ("PRO 10")
    const amount = parseAmount(token);
    if (amount === null || amount < 0) continue;
    out.push({ token, amount, currency: currency.code });
  }
  return out;
}

const PRICE_ONLY_REMAINDER =
  /^(?:[\s/\-–—,.·|*()+:†‡]|\bfor\s+\d+\s+(?:months?|years?)\b|\b(?:from|starting|at|only|just|per|a|an|mo|month|monthly|yr|year|yearly|annually|annual|user|seat|member|each|billed|vat|tax|taxes|excl|incl|and|usd|eur|gbp)\b)*$/i;

/** True when the text is a price and little else ("$49", "$49 / month", "from 29 €"). */
/**
 * Some sites render a price as separate elements - `$` `20` `00` - which reads as "$ 20 00". When the
 * WHOLE text is exactly a symbol, an amount and two digits, the two digits are the cents.
 */
export function joinSplitCents(text: string): string {
  const match = /^\s*([^\d\s]{1,3})\s?(\d{1,6}(?:[.,]\d{3})*)\s(\d{2})\s*$/.exec(text);
  return match ? `${match[1]}${match[2]}.${match[3]}` : text;
}

// A configurator's running total ("Total: $1", "Estimated cost") is the answer to the visitor's current
// slider position, not a plan's price (Klaviyo, Mailchimp).
const CONFIGURATOR_TOTAL = /\b(?:total|subtotal|estimated?|calculator|your (?:price|cost|plan))\b/i;

function isConfiguratorTotal($: cheerio.CheerioAPI, el: AnyNode): boolean {
  let node: AnyNode | null = el;
  for (let depth = 0; depth < 3 && node; depth += 1) {
    const text = normalizeWhitespace($(node).text());
    if (text.length <= 60 && CONFIGURATOR_TOTAL.test(text)) return true;
    node = (node as { parent?: AnyNode | null }).parent ?? null;
  }
  return false;
}

// "$5 of mobile messages", "$10 worth of credit": an amount INCLUDED in a plan, not the plan's price.
const INCLUDED_VALUE_AFTER = /^\s*(?:of|worth|credits?|included)\b/i;

function isIncludedValue($: cheerio.CheerioAPI, el: AnyNode): boolean {
  const own = normalizeWhitespace($(el).text());
  let node = (el as { parent?: AnyNode | null }).parent ?? null;
  for (let depth = 0; depth < 2 && node; depth += 1) {
    const text = normalizeWhitespace($(node).text());
    if (text.length <= 120) {
      const at = text.indexOf(own);
      if (at !== -1 && INCLUDED_VALUE_AFTER.test(text.slice(at + own.length))) return true;
    }
    node = (node as { parent?: AnyNode | null }).parent ?? null;
  }
  return false;
}

export function isPriceOnly(text: string): boolean {
  const normalized = joinSplitCents(normalizeWhitespace(text));
  if (normalized.length === 0 || normalized.length > 60) return false;
  const tokens = findPriceTokens(normalized);
  if (tokens.length !== 1) return false;
  const remainder = normalized.replace(tokens[0]!.token, "");
  return PRICE_ONLY_REMAINDER.test(remainder);
}

const MONTH = /\/\s*(?:mo|month)\b|\bper\s+(?:\w+\s*(?:\/|per)\s*)?month\b|\bmonthly\b|\ba\s+month\b|\bmo\b|\bal\s+mes\b|\/\s*mes\b|\bpar\s+mois\b|\bpro\s+monat\b/i;
const YEAR = /\/\s*(?:yr|year)\b|\bper\s+(?:\w+\s*(?:\/|per)\s*)?year\b|\byearly\b|\bannual(?:ly)?\b|\ba\s+year\b|\byr\b|\bal\s+a[nñ]o\b|\/\s*a[nñ]o\b|\bpar\s+an\b|\bpro\s+jahr\b/i;

/** The billing period written near a price; the first one AFTER the price wins ("$10 /mo billed annually" is monthly). */
export function detectPeriod(text: string, token?: string): "month" | "year" | null {
  const normalized = normalizeWhitespace(text);
  const scopes: string[] = [];
  if (token) {
    const at = normalized.indexOf(token);
    if (at !== -1) scopes.push(normalized.slice(at + token.length));
  }
  scopes.push(normalized);
  for (const scope of scopes) {
    const month = scope.search(MONTH);
    const year = scope.search(YEAR);
    if (month === -1 && year === -1) continue;
    if (year === -1) return "month";
    if (month === -1) return "year";
    return month < year ? "month" : "year";
  }
  return null;
}

const GENERIC_NAME =
  /^(?:pricing|plans?|our plans?|compare(?: all)? plans?|choose (?:your|a|the) plan|features?|most popular|best value|recommended|popular|monthly|annual(?:ly)?|yearly|billed .*|faq|frequently asked questions|get started|start(?: now| free| for free)?|buy now|sign up|contact(?: us| sales)?|learn more|what'?s included|includes?|everything in .*|all (?:plans|features) include.*)$/i;

const NAME_SELECTOR =
  "h1, h2, h3, h4, h5, h6, [class*='plan-name'], [class*='plan_name'], [class*='planName'], [class*='tier-name'], [class*='package-name'], [class*='card-title'], [class*='plan-title'], [class*='product-name']";

const STRUCK =
  "s, del, strike, [class*='strike'], [class*='line-through'], [class*='old-price'], [class*='was-price'], [class*='original-price'], [class*='price-old'], [class*='crossed']";

function isPlausibleName(text: string): boolean {
  const name = normalizeWhitespace(text);
  if (name.length < 2 || name.length > 40) return false;
  if (!/[A-Za-zÀ-ɏ]/.test(name)) return false;
  if (findPriceTokens(name).length > 0) return false;
  return !GENERIC_NAME.test(name);
}

function headingLevel(el: AnyNode): number {
  const tag = (el as { tagName?: string }).tagName ?? "";
  const m = /^h([1-6])$/i.exec(tag);
  return m ? Number(m[1]) : 0;
}

interface NameCandidate {
  el: AnyNode;
  name: string;
}

const BADGE_CHILD =
  "[class*='badge'], [class*='pill'], [class*='chip'], [class*='ribbon'], [class*='popular'], [class*='recommended'], [class*='sr-only'], [class*='visually-hidden'], [class*='tooltip']";
// Marketing flags that sites render inside or glued to the plan heading ("BusinessRecommended").
const BADGE_WORDS = ["most popular", "best value", "best deal", "recommended", "popular", "new", "current plan", "your plan"];

function isUpper(ch: string | undefined): boolean {
  return ch !== undefined && ch !== ch.toLowerCase();
}

/** Strips a badge word glued to the start or end of a name, only at a word or camelCase boundary. */
function stripBadgeWords(text: string): string {
  const lower = text.toLowerCase();
  for (const word of BADGE_WORDS) {
    if (lower.endsWith(word) && text.length > word.length) {
      const head = text.slice(0, text.length - word.length);
      const flag = text.slice(text.length - word.length);
      const boundary = /\s$/.test(head) || (isUpper(flag[0]) && /[a-z0-9+]$/.test(head));
      if (boundary) return head.trim();
    }
    if (lower.startsWith(word) && text.length > word.length) {
      const rest = text.slice(word.length);
      const boundary = /^\s/.test(rest) || (isUpper(text[0]) && isUpper(rest[0]));
      if (boundary) return rest.trim();
    }
  }
  return text;
}

/** The plan name a heading shows, without badge elements or glued-on marketing flags. */
function cleanPlanName($: cheerio.CheerioAPI, el: AnyNode): string {
  const $clone = $(el).clone();
  $clone.find(BADGE_CHILD).remove();
  let text = normalizeWhitespace($clone.text());
  if (text.length === 0) text = normalizeWhitespace($(el).text());
  for (let i = 0; i < 2; i += 1) {
    const stripped = stripBadgeWords(text);
    if (stripped.length >= 2) text = stripped;
  }
  return text;
}

function planNamesIn($: cheerio.CheerioAPI, container: AnyNode): NameCandidate[] {
  const out: NameCandidate[] = [];
  $(container)
    .find(NAME_SELECTOR)
    .each((_, el) => {
      const text = cleanPlanName($, el);
      if (isPlausibleName(text)) out.push({ el, name: text });
    });
  return out;
}

function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function documentIndex($: cheerio.CheerioAPI, root: AnyNode, target: AnyNode): number {
  let index = -1;
  let i = 0;
  $(root)
    .find("*")
    .each((_, el) => {
      if (el === target) index = i;
      i += 1;
    });
  return index;
}

/** Extracts every unambiguous plan price from the cleaned page body. */
export function extractPricingPlans($: cheerio.CheerioAPI, $root: cheerio.Cheerio<AnyNode>): PlanPrice[] {
  const plans: PlanPrice[] = [];

  // ---- Tables ---------------------------------------------------------------------------------
  $root.find("table").each((_, table) => {
    const found = plansFromTable($, table);
    if (found.length > 0) plans.push(...found);
  });

  // ---- Cards ----------------------------------------------------------------------------------
  const priceEls: AnyNode[] = [];
  $root.find("*").each((_, el) => {
    // Prices inside a table are read by the card logic too: many sites lay their plan cards out in a
    // layout <table> (Mailchimp), and the table logic alone only sees the columns that look like a header.
    // A plan found by both is kept once (first wins, below).
    if ($(el).closest(STRUCK).length > 0) return;
    const style = $(el).attr("style") ?? "";
    if (/line-through/i.test(style)) return;
    if (!isPriceOnly($(el).text())) return;
    if (isConfiguratorTotal($, el)) return;
    if (isIncludedValue($, el)) return;
    // Take the smallest price-only element: skip when a child already is one.
    const childIsPrice = $(el)
      .children()
      .toArray()
      .some((child) => isPriceOnly($(child).text()));
    if (!childIsPrice) priceEls.push(el);
  });

  for (const priceEl of priceEls) {
    const found = planFromCard($, priceEl, priceEls);
    if (found) plans.push(found);
  }

  // Keep the first occurrence of each (name, period): a repeated plan (e.g. a sticky copy of the
  // same card) must not produce two entities with one key.
  const seen = new Set<string>();
  return plans.filter((p) => {
    const key = `${slug(p.name)}:${p.period ?? "na"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function planFromCard($: cheerio.CheerioAPI, priceEl: AnyNode, allPriceEls: AnyNode[]): PlanPrice | null {
  const tokenInfo = findPriceTokens(joinSplitCents(normalizeWhitespace($(priceEl).text())))[0];
  if (!tokenInfo) return null;

  let node: AnyNode | null = (priceEl as { parent?: AnyNode | null }).parent ?? null;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    const container = node;
    const inside = allPriceEls.filter((p) => p === container || cheerio.contains(container as never, p as never));
    if (inside.length > 2) return null; // reached the grid of several plans without finding this card's name

    const names = planNamesIn($, container);
    if (names.length > 0) {
      const level = headingLevel(names[0]!.el);
      const sameLevel = names.filter((n) => headingLevel(n.el) === level);
      // Two or more prices and two or more names in one container: we cannot tell whose price is whose.
      if (inside.length >= 2 && sameLevel.length > 1) return null;

      let chosen = names[0]!;
      if (names.length > 1) {
        // Nearest name that precedes the price in document order, otherwise the first one.
        const priceIdx = documentIndex($, container, priceEl);
        const preceding = names.filter((n) => documentIndex($, container, n.el) < priceIdx);
        chosen = preceding.length > 0 ? preceding[preceding.length - 1]! : names[0]!;
      }

      return {
        name: chosen.name,
        amount: tokenInfo.amount,
        currency: tokenInfo.currency,
        period: periodNear($, priceEl, container, tokenInfo.token),
        token: tokenInfo.token,
      };
    }
    node = (container as { parent?: AnyNode | null }).parent ?? null;
  }
  return null;
}

function periodNear($: cheerio.CheerioAPI, priceEl: AnyNode, card: AnyNode, token: string): "month" | "year" | null {
  let node: AnyNode | null = priceEl;
  while (node) {
    const text = normalizeWhitespace($(node).text());
    if (text.length <= 80) {
      const period = detectPeriod(text, token);
      if (period) return period;
    }
    if (node === card) break;
    node = (node as { parent?: AnyNode | null }).parent ?? null;
  }
  return null;
}

function plansFromTable($: cheerio.CheerioAPI, table: AnyNode): PlanPrice[] {
  const rows = $(table)
    .find("tr")
    .toArray()
    .map((tr) =>
      $(tr)
        .children("th, td")
        .toArray()
        .map((cell) => normalizeWhitespace($(cell).text())),
    )
    .filter((cells) => cells.length >= 2);
  if (rows.length < 2) return [];

  // Orientation 1: plans are columns. Header row = names, a later row = prices.
  const header = rows[0]!;
  const out: PlanPrice[] = [];
  for (const row of rows.slice(1)) {
    const priced = row.slice(1).filter((cell) => cell.length <= 60 && findPriceTokens(cell).length === 1);
    if (priced.length < 2 && !(priced.length === 1 && row.length === 2)) continue;
    for (let i = 1; i < row.length; i += 1) {
      const cell = row[i] ?? "";
      const tokens = findPriceTokens(cell);
      const name = stripBadgeWords(header[i] ?? "");
      if (cell.length > 60 || tokens.length !== 1 || !isPlausibleName(name)) continue;
      out.push({
        name,
        amount: tokens[0]!.amount,
        currency: tokens[0]!.currency,
        period: detectPeriod(cell, tokens[0]!.token) ?? detectPeriod(row[0] ?? ""),
        token: tokens[0]!.token,
      });
    }
    if (out.length > 0) return out; // the first price row defines the plans
  }

  // Orientation 2: plans are rows. First cell = name, another cell = price.
  for (const row of rows) {
    const name = stripBadgeWords(row[0] ?? "");
    if (!isPlausibleName(name)) continue;
    const priceCell = row.slice(1).find((cell) => cell.length <= 60 && findPriceTokens(cell).length === 1);
    if (!priceCell) continue;
    const token = findPriceTokens(priceCell)[0]!;
    out.push({ name, amount: token.amount, currency: token.currency, period: detectPeriod(priceCell, token.token), token: token.token });
  }
  // A single matching row is more likely a coincidence than a pricing table.
  return out.length >= 2 ? out : [];
}

/**
 * Entities for every plan of a page. A plan's identity is its NAME: `plan:{name}`. The billing period only
 * joins the key (`plan:{name}:month`, `plan:{name}:year`, `:na`) when the same page lists the same plan
 * more than once with different periods (a monthly/annual pair), because then the name alone would collide.
 * Replaying real archived history showed why: the period wording appears or disappears between captures of
 * one page, and a key that included it turned every such edit into a removed plan plus an added plan.
 */
export function plansToEntities(plans: PlanPrice[]): ExtractedEntity[] {
  const periodsByName = new Map<string, Set<string>>();
  for (const plan of plans) {
    const set = periodsByName.get(slug(plan.name)) ?? new Set<string>();
    set.add(plan.period ?? "na");
    periodsByName.set(slug(plan.name), set);
  }
  return plans.map((plan) => planToEntity(plan, (periodsByName.get(slug(plan.name))?.size ?? 1) > 1));
}

export function planToEntity(plan: PlanPrice, includePeriodInKey = true): ExtractedEntity {
  const period = plan.period ? ` (per ${plan.period})` : "";
  return {
    type: "PRICE",
    key: includePeriodInKey ? `plan:${slug(plan.name)}:${plan.period ?? "na"}` : `plan:${slug(plan.name)}`,
    label: `${plan.name}${period}`,
    value: plan.amount.toFixed(2),
    currency: plan.currency,
    raw: plan.token.slice(0, 40),
  };
}
