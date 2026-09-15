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
