import * as cheerio from "cheerio";
import type { ExtractionResult, ExtractedEntity } from "@cma/core";
import { sha256 } from "./hash.js";
import { defaultFetch } from "./defaultFetch.js";
import {
  extractGenericPriceEntities,
  EXTRACTOR_VERSION,
  cleanBody,
  extractJsonLdEntities,
  extractMainContent,
  extractVisibleText,
  looksLikeJsShell,
} from "./structuredData.js";
import { extractPricingPlans, planToEntity } from "./pricingPlans.js";
import { extractHtmlPromotionEntities, mergeHtmlPromotionsWithJsonLd } from "./htmlPromotions.js";
import type { ConditionalRequest, Extractor, FetchFn } from "./types.js";
import type { RobotsChecker } from "./robots.js";

/**
 * Tiers 2-3 combined: parses the HTML DOM for visible text and pulls
 * structured entities (JSON-LD first, generic price-pattern fallback).
 * This is the extractor the Phase 1 monitoring pipeline actually runs
 * for every URL - HttpExtractor exists as the simpler tier of the same
 * interface, not as a required first step every scan has to repeat.
 */
/**
 * Hash of the FACTS the entities carry (what it is, what it costs, in which currency) and nothing else.
 * The previous hash covered the raw JSON-LD text and the context-hashed GENERIC prices, so a changed
 * rating, date or sentence near a price made the page "CHANGED" with no event to show for it. GENERIC
 * entities are evidence only and never enter the diff, so they do not enter the hash either.
 */
export function structuredDataHashOf(entities: ExtractedEntity[]): string | null {
  const facts = entities
    .filter((e) => e.type !== "GENERIC")
    .map((e) => ({ type: e.type, key: e.key, label: e.label, value: e.value, currency: e.currency }))
    .sort((a, b) => `${a.type}|${a.key}`.localeCompare(`${b.type}|${b.key}`));
  return facts.length > 0 ? sha256(JSON.stringify(facts)) : null;
}

export class CheerioExtractor implements Extractor {
  readonly method = "CHEERIO" as const;

  /**
   * `robots` is opt-in (the pipeline passes one built from CMA_ROBOTS_MODE): unit tests that inject
   * a fake `fetchFn` must never trigger a real robots.txt request.
   */
  constructor(
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly robots?: Pick<RobotsChecker, "isAllowed">,
  ) {}

  async extract({ url, conditional }: { url: string; conditional?: ConditionalRequest }): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      if (this.robots && !(await this.robots.isAllowed(url))) {
        return this.failure(url, null, null, "This page is disallowed for automated access by the site's robots.txt.", Date.now() - start);
      }
      const hasValidators = Boolean(conditional && (conditional.etag || conditional.lastModified));
      const page = await this.fetchFn(url, hasValidators ? conditional : undefined);
      const durationMs = Date.now() - start;

      // 304 is only meaningful because WE asked conditionally; without validators it stays an error.
      if (page.status === 304 && hasValidators) {
        return {
          method: this.method,
          requestedUrl: url,
          finalUrl: page.finalUrl,
          httpStatus: 304,
          errorMessage: null,
          normalizedContent: "",
          contentHash: null,
          structuredDataHash: null,
          extractedEntities: [],
          confidence: 1,
          warnings: [],
          durationMs,
          notModified: true,
        };
      }

      if (page.status < 200 || page.status >= 300) {
        return this.failure(url, page.finalUrl, page.status, `Unexpected HTTP status ${page.status}`, durationMs);
      }

      const $ = cheerio.load(page.body);
      // Phase 29 C2: the page's own content (no nav/footer/banners/volatile text) is what gets
      // hashed and diffed; the JS-shell heuristic still looks at the whole body, as before.
      const visibleText = extractMainContent($).text;
      const wholeBodyText = extractVisibleText($);
      const jsonLdEntities = extractJsonLdEntities($);
      // Phase 29 C3: JSON-LD stays the first choice (machine-readable, history already keyed on it).
      // Without it, plan cards/tables give real PRICE entities with a plan name; only when those find
      // nothing do we fall back to the context-hashed GENERIC prices (evidence only, never diffed).
      const planEntities = jsonLdEntities.length > 0 ? [] : extractPricingPlans($, cleanBody($)).map(planToEntity);
      const baseEntities: ExtractedEntity[] =
        jsonLdEntities.length > 0 ? jsonLdEntities : planEntities.length > 0 ? planEntities : extractGenericPriceEntities(visibleText);
      // Phase 24: a second, independent promotion source (bounded HTML
      // pattern matching) runs regardless of whether JSON-LD produced
      // anything - real dogfooding showed most competitor pages express
      // promotions only as styled HTML text, never as schema.org markup.
      const htmlPromotionEntities = mergeHtmlPromotionsWithJsonLd(jsonLdEntities, extractHtmlPromotionEntities($));
      const entities: ExtractedEntity[] = [...baseEntities, ...htmlPromotionEntities];

      const warnings: string[] = [];
      let confidence = 1;

      if (looksLikeJsShell($, wholeBodyText)) {
        // Phase 29 C4: an empty application shell is not a page we observed. Comparing its skeleton with
        // a fully rendered page (or two skeletons with each other) produced false PRODUCT_ADDED/REMOVED
        // events, and recording the scan as a success hid that the source cannot be monitored at all.
        // It is now an unverified scan: no change is inferred, the failure counts toward the source's
        // health, and the message tells the customer why.
        return this.failure(
          url,
          page.finalUrl,
          page.status,
          "The page has too little readable content: it looks like a client-rendered application (its content is built in the browser) or is nearly empty, so it cannot be monitored without a browser.",
          durationMs,
        );
      }

      if (visibleText.length === 0) {
        warnings.push("No visible text extracted - page may be empty or entirely non-text.");
        confidence = Math.min(confidence, 0.1);
      }

      if (entities.length === 0) {
        warnings.push("No structured price/product entities found on this page.");
      }

      return {
        method: this.method,
        requestedUrl: url,
        finalUrl: page.finalUrl,
        httpStatus: page.status,
        errorMessage: null,
        normalizedContent: visibleText,
        contentHash: visibleText.length > 0 ? sha256(visibleText) : null,
        structuredDataHash: structuredDataHashOf(entities),
        extractedEntities: entities,
        confidence,
        warnings,
        durationMs,
        extractorVersion: EXTRACTOR_VERSION,
        ...(page.headers && (page.headers.etag || page.headers.lastModified) ? { validators: page.headers } : {}),
      };
    } catch (err) {
      return this.failure(
        url,
        null,
        null,
        err instanceof Error ? err.message : String(err),
        Date.now() - start,
      );
    }
  }

  private failure(
    requestedUrl: string,
    finalUrl: string | null,
    httpStatus: number | null,
    errorMessage: string,
    durationMs: number,
  ): ExtractionResult {
    return {
      method: this.method,
      requestedUrl,
      finalUrl,
      httpStatus,
      errorMessage,
      normalizedContent: "",
      contentHash: null,
      structuredDataHash: null,
      extractedEntities: [],
      confidence: 0,
      warnings: [],
      durationMs,
      extractorVersion: EXTRACTOR_VERSION,
    };
  }
}
