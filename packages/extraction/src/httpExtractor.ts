import type { ExtractionResult } from "@cma/core";
import { sha256 } from "./hash.js";
import { defaultFetch } from "./defaultFetch.js";
import type { Extractor, FetchFn } from "./types.js";

/**
 * Tier 1: raw fetch, no parsing. Used to establish reachability and a
 * content hash cheaply. Never throws for expected failure modes
 * (blocked URL, network error, non-2xx status) - those become a
 * result with `errorMessage` set, which the detection engine reads to
 * produce FAILED_TO_VERIFY rather than a false "everything changed".
 */
export class HttpExtractor implements Extractor {
  readonly method = "HTTP" as const;

  constructor(private readonly fetchFn: FetchFn = defaultFetch) {}

  async extract({ url }: { url: string }): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      const page = await this.fetchFn(url);
      const durationMs = Date.now() - start;

      if (page.status < 200 || page.status >= 300) {
        return {
          method: this.method,
          requestedUrl: url,
          finalUrl: page.finalUrl,
          httpStatus: page.status,
          errorMessage: `Unexpected HTTP status ${page.status}`,
          normalizedContent: "",
          contentHash: null,
          structuredDataHash: null,
          extractedEntities: [],
          confidence: 0,
          warnings: [],
          durationMs,
        };
      }

      return {
        method: this.method,
        requestedUrl: url,
        finalUrl: page.finalUrl,
        httpStatus: page.status,
        errorMessage: null,
        normalizedContent: page.body,
        contentHash: sha256(page.body),
        structuredDataHash: null,
        extractedEntities: [],
        confidence: page.body.trim().length > 0 ? 1 : 0.2,
        warnings: page.body.trim().length === 0 ? ["Response body was empty"] : [],
        durationMs,
      };
    } catch (err) {
      return {
        method: this.method,
        requestedUrl: url,
        finalUrl: null,
        httpStatus: null,
        errorMessage: err instanceof Error ? err.message : String(err),
        normalizedContent: "",
        contentHash: null,
        structuredDataHash: null,
        extractedEntities: [],
        confidence: 0,
        warnings: [],
        durationMs: Date.now() - start,
      };
    }
  }
}
