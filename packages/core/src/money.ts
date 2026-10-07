/**
 * Phase 29 C1: deterministic price/currency parsing and comparison.
 *
 * Why this exists: the detector used to strip every character that is not a digit, dot or minus and
 * parse the rest as an English number, so "1.299,00" (European) became 1.299 - a 1000x error - and
 * "10" vs "10.00" were treated as different strings. Every price comparison now goes through here.
 *
 * Nothing in this file guesses beyond what the text supports: an ambiguous reading is reported as
 * `ambiguous` so callers can lower their confidence instead of silently trusting it.
 */

export interface ParsedAmount {
  value: number;
  /** True when the text admits two readings (e.g. "1.299" is 1299 in Europe, 1.299 elsewhere). */
  ambiguous: boolean;
}

// Spaces, no-break spaces and apostrophes used as thousands separators (1 299,00 / 1'299.00).
const GROUP_SEPARATORS = /(?<=\d)[\s  '’](?=\d{3}(?!\d))/g;

/**
 * Parses the numeric part of a price string in any common locale convention:
 * `1,299.00`, `1.299,00`, `1 299,00`, `1'299.00`, `1,23,456.00` (Indian grouping), `10`, `10.5`.
 * Returns null when there is no number or the digits cannot be a well-formed amount.
 */
export function parseAmountDetailed(raw: string | null | undefined): ParsedAmount | null {
  if (raw === null || raw === undefined) return null;
  const grouped = raw.replace(GROUP_SEPARATORS, "");
  const match = grouped.match(/\d[\d.,]*/);
  if (!match) return null;
  const token = match[0].replace(/[.,]+$/, ""); // "10." or "10," -> "10"
  const negative = /(^|[^\d])-\s*$/.test(grouped.slice(0, match.index ?? 0));
  const sign = negative ? -1 : 1;

  const dots = (token.match(/\./g) ?? []).length;
  const commas = (token.match(/,/g) ?? []).length;

  const done = (text: string, ambiguous: boolean): ParsedAmount | null => {
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? { value: sign * value, ambiguous } : null;
  };

  if (dots === 0 && commas === 0) return done(token, false);

  if (dots > 0 && commas > 0) {
    // The separator that appears last is the decimal one; the other groups thousands.
    const decimalIsComma = token.lastIndexOf(",") > token.lastIndexOf(".");
    const thousands = decimalIsComma ? "." : ",";
    const decimal = decimalIsComma ? "," : ".";
    const parts = token.split(decimal);
    if (parts.length !== 2) return null;
    const [intPart, fracPart] = parts as [string, string];
    if (!isValidGrouping(intPart.split(thousands), thousands)) return null;
    return done(`${intPart.split(thousands).join("")}.${fracPart}`, false);
  }

  const separator = dots > 0 ? "." : ",";
  const parts = token.split(separator);

  if (parts.length > 2) {
    // Repeated single separator: it can only be a thousands separator.
    if (!isValidGrouping(parts, separator)) return null;
    return done(parts.join(""), false);
  }

  const [intPart, fracPart] = parts as [string, string];
  if (fracPart.length === 3 && intPart.length >= 1 && intPart.length <= 3 && intPart !== "0") {
    // "1,299" / "1.299": thousands in practice for prices, but a 3-decimal reading exists.
    return done(`${intPart}${fracPart}`, true);
  }
  return done(`${intPart}.${fracPart}`, false);
}

/** Groups after the first must be 3 digits (Indian "1,23,456" also allows 2-digit groups with commas). */
function isValidGrouping(parts: string[], separator: string): boolean {
  const [first, ...rest] = parts;
  if (!first || first.length === 0 || first.length > 3) return false;
  if (rest.length === 0) return true;
  const last = rest[rest.length - 1] as string;
  if (last.length !== 3) return false;
  const middle = rest.slice(0, -1);
  return middle.every((p) => p.length === 3 || (separator === "," && p.length === 2));
}

export function parseAmount(raw: string | null | undefined): number | null {
  return parseAmountDetailed(raw)?.value ?? null;
}

// ---------------------------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------------------------

export interface DetectedCurrency {
  /** ISO 4217 code. */
  code: string;
  /** True when the symbol is shared by several currencies ("$", "¥"); the code is the most common reading. */
  ambiguous: boolean;
}

// Longest first so "US$" is never read as "$".
const PREFIXED_DOLLARS: [string, string][] = [
  ["US$", "USD"],
  ["CA$", "CAD"],
  ["C$", "CAD"],
  ["AU$", "AUD"],
  ["A$", "AUD"],
  ["NZ$", "NZD"],
  ["HK$", "HKD"],
  ["MX$", "MXN"],
  ["S$", "SGD"],
  ["R$", "BRL"],
];

const SYMBOLS: [string, DetectedCurrency][] = [
  ["€", { code: "EUR", ambiguous: false }],
  ["£", { code: "GBP", ambiguous: false }],
  ["₹", { code: "INR", ambiguous: false }],
  ["₩", { code: "KRW", ambiguous: false }],
  ["₽", { code: "RUB", ambiguous: false }],
  ["₺", { code: "TRY", ambiguous: false }],
  ["₪", { code: "ILS", ambiguous: false }],
  ["₫", { code: "VND", ambiguous: false }],
  ["฿", { code: "THB", ambiguous: false }],
  ["₱", { code: "PHP", ambiguous: false }],
  ["zł", { code: "PLN", ambiguous: false }],
  ["Kč", { code: "CZK", ambiguous: false }],
  ["¥", { code: "JPY", ambiguous: true }], // also CNY
  ["$", { code: "USD", ambiguous: true }], // also CAD, AUD, MXN, ...
];

const ISO_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CNY", "INR", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "BRL", "MXN", "KRW",
  "SGD", "HKD", "ZAR", "TRY", "RUB", "ILS", "AED", "SAR", "THB", "IDR", "PHP", "VND", "CZK", "HUF", "RON", "ARS", "CLP",
  "COP", "TWD", "MYR", "EGP", "NGN", "UAH",
]);

/** An ISO 4217 code from free text such as "usd", " EUR ", or null when it is not a known code. */
export function normalizeCurrencyCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase();
  return ISO_CODES.has(code) ? code : null;
}

/** Finds the currency written next to a price: an ISO code first, then prefixed dollars, then symbols. */
export function detectCurrency(text: string | null | undefined): DetectedCurrency | null {
  if (!text) return null;
  const iso = text.match(/\b([A-Za-z]{3})\b/g)?.map((m) => m.toUpperCase()).find((c) => ISO_CODES.has(c));
  if (iso) return { code: iso, ambiguous: false };
  for (const [prefix, code] of PREFIXED_DOLLARS) {
    if (text.includes(prefix)) return { code, ambiguous: false };
  }
  for (const [symbol, currency] of SYMBOLS) {
    if (text.includes(symbol)) return currency;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

export interface PriceSide {
  value: string | null;
  currency: string | null;
}

export type PriceComparison =
  | { kind: "unparseable" }
  | { kind: "same"; oldAmount: number; newAmount: number }
  | {
      kind: "changed";
      oldAmount: number;
      newAmount: number;
      amountChanged: boolean;
      currencyChanged: boolean;
      /** null when the currency changed (a % across currencies is meaningless) or the old amount is 0. */
      percentageChange: number | null;
      /** True if either side's number had two valid readings; callers should be less sure. */
      ambiguous: boolean;
    };

const AMOUNT_EPSILON = 0.005;

/**
 * Compares two stored price values numerically and by currency. `"10"` and `"10.00"` are the same
 * price; a currency change with the same number is a real change; a percentage is only produced when
 * both sides are in the same (or an unknown) currency.
 */
export function comparePrices(previous: PriceSide, current: PriceSide): PriceComparison {
  const oldParsed = parseAmountDetailed(previous.value);
  const newParsed = parseAmountDetailed(current.value);
  if (!oldParsed || !newParsed) return { kind: "unparseable" };

  const oldCurrency = normalizeCurrencyCode(previous.currency);
  const newCurrency = normalizeCurrencyCode(current.currency);
  // Only a difference between two KNOWN currencies counts: a missing currency is "unknown", not "changed".
  const currencyChanged = oldCurrency !== null && newCurrency !== null && oldCurrency !== newCurrency;
  const amountChanged = Math.abs(oldParsed.value - newParsed.value) >= AMOUNT_EPSILON;

  if (!amountChanged && !currencyChanged) {
    return { kind: "same", oldAmount: oldParsed.value, newAmount: newParsed.value };
  }

  const percentageChange =
    currencyChanged || oldParsed.value === 0 ? null : Math.round(((newParsed.value - oldParsed.value) / oldParsed.value) * 10000) / 100;

  return {
    kind: "changed",
    oldAmount: oldParsed.value,
    newAmount: newParsed.value,
    amountChanged,
    currencyChanged,
    percentageChange,
    ambiguous: oldParsed.ambiguous || newParsed.ambiguous,
  };
}
