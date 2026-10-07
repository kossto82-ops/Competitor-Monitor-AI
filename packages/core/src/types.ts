import type { EntityType, ExtractionMethod, Severity, ChangeType } from "./enums.js";

/**
 * One structured fact pulled out of a page by an extractor.
 * `key` must be stable across scans of the same URL so the detection
 * engine can match entities between two snapshots (e.g. the same
 * product row) even if unrelated parts of the page changed.
 */
export interface ExtractedEntity {
  type: EntityType;
  /** Stable identifier for matching across snapshots, e.g. a product slug or plan name. */
  key: string;
  label: string;
  value: string | null;
  currency: string | null;
  raw: string;
}

/**
 * The outcome of running one Extractor against one URL. This is the
 * shared contract every tier (HTTP, Cheerio, Playwright, Browser Use)
 * must return, regardless of how it got there.
 */
export interface ExtractionResult {
  method: ExtractionMethod;
  requestedUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  /** Set when the extraction failed outright (network error, SSRF block, timeout). */
  errorMessage: string | null;
  /** Whitespace-normalized visible text content, empty string on failure. */
  normalizedContent: string;
  contentHash: string | null;
  structuredDataHash: string | null;
  extractedEntities: ExtractedEntity[];
  /** 0-1 heuristic confidence that this extraction reflects the real page. */
  confidence: number;
  warnings: string[];
  durationMs: number;
  /**
   * Phase 29 B3b: the server answered 304 Not Modified to our conditional request, i.e. the page is
   * byte-for-byte what we already hold. No content is extracted and no snapshot should be written.
   */
  notModified?: boolean;
  /** Cache validators of a successful full response, stored so the next scan can be conditional. */
  validators?: ConditionalValidators;
}

export interface ConditionalValidators {
  etag: string | null;
  lastModified: string | null;
}

export interface ChangeEventDraft {
  changeType: ChangeType;
  severity: Severity;
  confidence: number;
  entityKey: string | null;
  fieldPath: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  evidenceExcerpt: string;
}

export interface ComparisonResult {
  verificationState: "CHANGED" | "NO_CHANGE" | "FAILED_TO_VERIFY";
  reason: string;
  changeEvents: ChangeEventDraft[];
}
