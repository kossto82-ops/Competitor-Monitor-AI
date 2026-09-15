import type { ExtractionMethod, ExtractionResult } from "@cma/core";

export interface FetchedPage {
  status: number;
  body: string;
  finalUrl: string;
}

/**
 * Every extractor fetches through a `FetchFn` rather than calling
 * `safeGet`/`fetch` directly. In production this defaults to the
 * SSRF-safe fetch from @cma/security; tests inject a fake that returns
 * canned HTML, so extraction logic is verified without a network call
 * and without needing to defeat the SSRF allowlist.
 */
export type FetchFn = (url: string) => Promise<FetchedPage>;

export interface Extractor {
  readonly method: ExtractionMethod;
  extract(input: { url: string }): Promise<ExtractionResult>;
}
