/**
 * Thrown for both "no such row" and "row exists but belongs to another
 * organization". Deliberately the same error either way - an API layer
 * translating this to HTTP must return 404 in both cases, never a 403
 * that would leak whether another tenant's resource exists.
 */
export class NotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} not found`);
    this.name = "NotFoundError";
  }
}

/**
 * Phase 5 (Section 3): "delete where safe" - thrown when a caller asks
 * to permanently delete a row that still has dependent history a
 * customer might reasonably want to keep auditable (e.g. a Competitor
 * with monitored URLs, or a MonitoredUrl with recorded ChangeEvents).
 * The API layer translates this to a 409, distinct from the 404s
 * NotFoundError produces.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
