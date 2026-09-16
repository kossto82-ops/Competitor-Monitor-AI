/**
 * Canonical enum values shared across the monorepo. The Prisma schema
 * (packages/db/prisma/schema.prisma) defines matching enums with the
 * same value names - this file is the source of truth for what those
 * values mean, since packages/security, packages/extraction and
 * packages/detection must not depend on the Prisma client.
 */

export const EXTRACTION_METHODS = ["HTTP", "CHEERIO", "PLAYWRIGHT", "BROWSER_USE"] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/**
 * The system's core honesty contract (see Section 3 of the brief):
 * a failed fetch is NEVER interpreted as a deletion or a real change.
 */
export const VERIFICATION_STATES = ["CHANGED", "NO_CHANGE", "FAILED_TO_VERIFY"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const JOB_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const CHANGE_TYPES = [
  "PRICE_CHANGE",
  "PRODUCT_ADDED",
  "PRODUCT_REMOVED",
  "PROMOTION_CHANGE",
  "CONTENT_CHANGE",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ENTITY_TYPES = ["PRICE", "PRODUCT", "PLAN", "PROMOTION", "GENERIC"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const PLANS = ["STARTER", "PRO", "BUSINESS"] as const;
export type Plan = (typeof PLANS)[number];

/** Phase 4: lifecycle of a DailyReport (`Report` model) - mirrors JobStatus's shape. */
export const REPORT_STATUSES = ["GENERATING", "COMPLETED", "FAILED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
