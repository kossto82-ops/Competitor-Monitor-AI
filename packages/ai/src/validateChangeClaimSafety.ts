import { AiOutputValidationError } from "./errors.js";
import { PROHIBITED_CLAIM_PATTERNS } from "./validateDigestClaimSafety.js";
import type { AiAnalysisOutput, ChangeAnalysisInput } from "./types.js";

/**
 * Phase 29 / A5: a deterministic check of the per-change analysis output
 * against the "STRICT EVIDENCE RULE" its own system prompt states, for the
 * same reason validateDigestClaimSafety.ts exists for the digest: a prompt
 * is an instruction, not a guarantee, and a competitor's page can push the
 * model toward exactly these claims.
 *
 * Two kinds of rule:
 *
 *  - EVIDENCE-GATED claims (promotion, stock, discontinuation, temporariness,
 *    legal): a model may only say them if the evidence it was given already
 *    contains the same kind of wording. A page that says "20% discount"
 *    lets the analysis say "discount"; a page that does not, does not.
 *  - ALWAYS-BANNED claims (intent, strategy, motivation, targeting,
 *    positioning, causal explanation): the system only measures WHAT
 *    changed, never WHY, so no evidence can support these.
 *
 * Whole-response rejection, never a silent edit - same convention as the
 * digest validator. False positives are the intended failure mode.
 */
type GatedCategory = "promotion" | "availability" | "discontinuation" | "temporary" | "legal";

const EVIDENCE_GATED: readonly { category: GatedCategory; pattern: RegExp }[] = [
  { category: "promotion", pattern: /\b(?:promotions?|promotional|promo|discount(?:s|ed)?|on sale|sale price|coupons?|special offer|limited[- ]time|clearance|black friday|bundle[sd]?)\b/i },
  { category: "availability", pattern: /\b(?:out of stock|in stock|sold out|back[- ]?order(?:ed)?|low stock|stock levels?)\b/i },
  { category: "discontinuation", pattern: /\b(?:discontinu\w+|phased? out|phasing out|delisted|withdrawn from|retired|end[- ]of[- ]life|no longer (?:sold|offered|available|listed|supported))\b/i },
  { category: "temporary", pattern: /\b(?:temporary|temporarily|short[- ]term (?:price|offer|change)|one[- ]off|for a limited (?:time|period)|introductory)\b/i },
  { category: "legal", pattern: /\b(?:regulat\w+|compliance|legal(?:ly)?|lawsuit|litigation|tax (?:change|rate)|policy change|terms of service)\b/i },
];

type BannedCategory = "intent" | "strategy" | "targeting" | "motivation" | "positioning";

const ALWAYS_BANNED: readonly { category: BannedCategory; pattern: RegExp }[] = [
  { category: "targeting", pattern: /\b(?:targeting|targets? (?:the|a|an|our|customers?)|aimed at|going after)\b/i },
  { category: "positioning", pattern: /\b(?:repositioning|re-positioning|positioning (?:itself|the|its)|market position(?:ing)?|moving (?:up|down)[- ]?market|premium(?:ization| positioning)|budget positioning)\b/i },
  { category: "motivation", pattern: /\b(?:motivat\w+|in an effort to|seeking to|hoping to|looking to|attempts? to|attempting to|reacting to|responding to)\b/i },
  { category: "strategy", pattern: /\b(?:their|its|the company'?s|the competitor'?s) (?:strategy|strategic|plan to|goal)\b/i },
];

/** Categories of the digest validator that are equally unsupportable for a single change. */
const SHARED_BANNED_DIGEST_CATEGORIES = new Set(["causal-explanation", "competitor-intent", "competitor-strategy"]);

/** Everything the model was shown that came from the page, flattened for evidence lookups. */
function evidenceText(input: ChangeAnalysisInput): string {
  return [
    input.evidenceExcerpt,
    input.previousExcerpt,
    input.currentExcerpt,
    input.priceChange?.oldValue,
    input.priceChange?.newValue,
    input.priceChange?.currency,
    input.productAdded?.label,
    input.productAdded?.value,
    input.productRemoved?.label,
    input.productRemoved?.value,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function findViolation(text: string, evidence: string): { category: string; matched: string } | undefined {
  for (const { category, pattern } of PROHIBITED_CLAIM_PATTERNS) {
    if (!SHARED_BANNED_DIGEST_CATEGORIES.has(category)) continue;
    const match = text.match(pattern);
    if (match) return { category, matched: match[0] };
  }
  for (const { category, pattern } of ALWAYS_BANNED) {
    const match = text.match(pattern);
    if (match) return { category, matched: match[0] };
  }
  for (const { category, pattern } of EVIDENCE_GATED) {
    const match = text.match(pattern);
    // Allowed only when the page itself used that kind of wording.
    if (match && !pattern.test(evidence)) return { category: `${category} (not in the evidence)`, matched: match[0] };
  }
  return undefined;
}

export function validateChangeClaimSafety(provider: string, output: AiAnalysisOutput, input: ChangeAnalysisInput, rawOutput: string): void {
  const evidence = evidenceText(input);
  const candidates = [output.summary, ...output.facts, ...output.interpretations, ...output.speculation];

  for (const text of candidates) {
    const violation = findViolation(text, evidence);
    if (violation) {
      throw new AiOutputValidationError(
        provider,
        `analysis makes an unsupported claim (category=${violation.category}, matched="${violation.matched}"): "${text}"`,
        rawOutput,
      );
    }
  }
}
