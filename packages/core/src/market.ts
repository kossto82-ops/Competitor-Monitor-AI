/**
 * Phase 29 (market setting): the language a customer wants competitors' pages to be read in.
 *
 * It is sent as the `Accept-Language` header of every monitoring request, so sites that choose their
 * language (and, for some, currency) from it answer in the customer's market instead of in whatever
 * the monitoring server's address suggests. It cannot force a COUNTRY: many sites choose the currency
 * from the visitor's IP address alone, and a header does not change that.
 *
 * A closed list (not free text): the value ends up in an HTTP header, and a typo would silently
 * produce a different page than the customer believes they are watching.
 */
export const MARKET_LOCALES = [
  { code: "en-US", label: "English (United States)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "en-CA", label: "English (Canada)" },
  { code: "en-AU", label: "English (Australia)" },
  { code: "en-IN", label: "English (India)" },
  { code: "es-ES", label: "Spanish (Spain)" },
  { code: "es-MX", label: "Spanish (Mexico)" },
  { code: "fr-FR", label: "French (France)" },
  { code: "de-DE", label: "German (Germany)" },
  { code: "it-IT", label: "Italian (Italy)" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "pt-PT", label: "Portuguese (Portugal)" },
  { code: "nl-NL", label: "Dutch (Netherlands)" },
  { code: "sv-SE", label: "Swedish (Sweden)" },
  { code: "pl-PL", label: "Polish (Poland)" },
  { code: "ja-JP", label: "Japanese (Japan)" },
] as const;

export const MARKET_LOCALE_CODES = MARKET_LOCALES.map((l) => l.code) as readonly string[];
export type MarketLocale = (typeof MARKET_LOCALES)[number]["code"];

export function isMarketLocale(value: unknown): value is MarketLocale {
  return typeof value === "string" && MARKET_LOCALE_CODES.includes(value);
}

/** The header value for a locale: "es-ES" -> "es-ES,es;q=0.9,en;q=0.5". Null when no market is set. */
export function acceptLanguageFor(locale: string | null | undefined): string | null {
  if (!isMarketLocale(locale)) return null;
  const language = locale.split("-")[0]!;
  return language === "en" ? `${locale},en;q=0.9` : `${locale},${language};q=0.9,en;q=0.5`;
}
