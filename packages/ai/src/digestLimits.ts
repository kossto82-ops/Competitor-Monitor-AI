import { truncate } from "./limits.js";

/**
 * Phase 11 (Section 19 of the brief - "size limits"): explicit, documented
 * bounds on the Evidence Bundle sent to the model for one Digest
 * interpretation. Mirrors limits.ts's rationale for the ChangeEvent path -
 * these are deliberately conservative and enforced in code, not left to
 * "the model will probably behave."
 */

/** Deterministic selection cap: at most this many competitors are represented in one bundle. See buildDigestContext.ts's selectCompetitors() for the exact, documented ordering rule (recency-first, never an "importance" score). */
export const MAX_BUNDLE_COMPETITORS = 12;

/** Deterministic selection cap per competitor: every qualifying pattern item (REPEATED_PRICE_CHANGE/ACTIVITY_PATTERN/LIFECYCLE) is always kept; raw CHANGE_EVENT items are capped to the N most recent per competitor. */
export const MAX_RAW_CHANGE_EVENTS_PER_COMPETITOR = 8;

/** Hard ceiling on total items across the whole bundle, after the per-competitor caps above - a final defense-in-depth bound. */
export const MAX_BUNDLE_ITEMS_TOTAL = 80;

export const MAX_UNTRUSTED_TEXT_CHARS = 300;

/** Sanity cap on the fully-built user-message text before it is sent - mirrors MAX_TOTAL_INPUT_CHARS's role for the ChangeEvent path, just larger since one Digest interpretation intentionally carries many items instead of one. */
export const MAX_TOTAL_DIGEST_INPUT_CHARS = 16_000;

/** Cap on the raw provider response text before any attempt to JSON.parse it. */
export const MAX_DIGEST_OUTPUT_CHARS = 12_000;

export const DIGEST_REQUEST_TIMEOUT_MS = 30_000;

// Output-contract bounds (Section 14 of the brief) - defense-in-depth
// beyond the zod schema itself (digestSchema.ts), same layering as
// aiAnalysisOutputSchema's own array/string length caps.
export const MAX_SUMMARY_CHARS = 600;
export const MAX_CLAIM_TEXT_CHARS = 400;
export const MAX_OBSERVATIONS = 12;
export const MAX_INTERPRETATIONS = 8;
export const MAX_HYPOTHESES = 5;
export const MAX_EVIDENCE_IDS_PER_CLAIM = 10;

export { truncate };
