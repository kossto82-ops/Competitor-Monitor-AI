import * as cheerio from "cheerio";
import type { ExtractionResult, ExtractedEntity } from "@cma/core";
import { sha256 } from "./hash.js";
import { defaultFetch } from "./defaultFetch.js";
import {
  extractGenericPriceEntities,
  extractJsonLdEntities,
  extractVisibleText,
  looksLikeJsShell,
} from "./structuredData.js";
import type { Extractor, FetchFn } from "./types.js";

/**
 * Tiers 2-3 combined: parses the HTML DOM for visible text and pulls
 * structured entities (JSON-LD first, generic price-pattern fallback).
 * This is the extractor the Phase 1 monitoring pipeline actually runs
 * for every URL - HttpExtractor exists as the simpler tier of the same
 * interface, not as a required first step every scan has to repeat.
 */
export class CheerioExtractor implements Extractor {
  readonly method = "CHEERIO" as const;

  constructor(private readonly fetchFn: FetchFn = defaultFetch) {}

  async extract({ url }: { url: string }): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      const page = await this.fetchFn(url);
      const durationMs = Date.now() - start;

      if (page.status < 200 || page.status >= 300) {
        return this.failure(url, page.finalUrl, page.status, `Unexpected HTTP status ${page.status}`, durationMs);
      }

      const $ = cheerio.load(page.body);
      const visibleText = extractVisibleText($);
      const jsonLdEntities = extractJsonLdEntities($);
      const entities: ExtractedEntity[] =
        jsonLdEntities.length > 0 ? jsonLdEntities : extractGenericPriceEntities(visibleText);

      const warnings: string[] = [];
      let confidence = 1;

      if (looksLikeJsShell($, visibleText)) {
        warnings.push(
          "Page looks like a client-rendered application shell; HTTP+Cheerio extraction may be incomplete. Consider a Playwright-based extractor for this URL.",
        );
        confidence = Math.min(confidence, 0.3);
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
        structuredDataHash: entities.length > 0 ? sha256(JSON.stringify(entities)) : null,
        extractedEntities: entities,
        confidence,
        warnings,
        durationMs,
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
    };
  }
}
