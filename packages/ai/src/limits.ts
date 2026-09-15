/**
 * Section 7 (cost control): hard, enforced-at-build-time caps on what
 * ever reaches the model. These are deliberately conservative - a
 * competitor's page text is not something a paying customer needs
 * reproduced verbatim, just enough to ground the model's summary.
 */
export const MAX_EVIDENCE_EXCERPT_CHARS = 500;
export const MAX_SNAPSHOT_EXCERPT_CHARS = 800;
export const MAX_VALUE_CHARS = 200;

/** Sanity cap on the fully-built user-message text before it is sent. */
export const MAX_TOTAL_INPUT_CHARS = 4000;

/**
 * Cap on the raw provider response text before it is even attempted to
 * be JSON.parse'd - protects against a provider (or injected page
 * content that talked the model into it) returning a huge blob.
 */
export const MAX_OUTPUT_CHARS = 8000;

export const REQUEST_TIMEOUT_MS = 20_000;

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}
