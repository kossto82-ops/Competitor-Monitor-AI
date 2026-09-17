import { AiOutputValidationError } from "./errors.js";
import type { AiInterpretationOutput } from "./digestTypes.js";

/**
 * Phase 12: a second, deterministic line of defense beyond
 * digestPrompt.ts's own "ABSOLUTELY PROHIBITED" instructions.
 *
 * Phase 11 (Finding #2, PHASE11-VALIDATION-REPORT.md Section 15) showed
 * that a real gpt-4o-mini run produced a schema-valid, evidence-linked,
 * correctly-hedged `interpretations[]` entry that still brushed against
 * the prohibited "causal explanation" / "market demand" category
 * ("The introduction of 'Starter Plan' by Beta Competitor Co may
 * indicate a response to market demand."). Real-model prompt adherence
 * on borderline phrasing is probabilistic, not guaranteed by
 * construction - this module makes the prohibition mechanical instead of
 * relying on the prompt alone.
 *
 * Runs AFTER schema validation and evidence-id provenance validation
 * (validateDigestInterpretation.ts) but is fully INDEPENDENT of it - see
 * analyzeAndValidateDigest.ts for the pipeline order. Neither validator's
 * logic is merged into the other: a response with perfectly valid,
 * real evidence ids is still rejected here if any claim's text matches a
 * prohibited phrase; a response with fabricated evidence ids is rejected
 * by the OTHER validator regardless of what this one would find.
 *
 * Deliberately NOT a naive single-word blacklist. Banning the bare word
 * "market" would reject legitimate, schema-compliant text like "the
 * competitor changed its market-facing pricing page" - every pattern
 * below targets a specific multi-word phrase form that only appears
 * when a claim is actually making one of the prohibited assertions
 * (a causal explanation, an intent claim, a market-condition
 * explanation, a forecast, a financial inference, or a win/loss claim).
 *
 * False positives (rejecting a borderline-but-arguably-safe claim) are
 * the INTENDED failure mode over false negatives (letting an unsupported
 * causal/market/intent claim through) - per the product brief's Section
 * 39 and Phase 11 Finding #2. A rejected response is never partially
 * edited or silently rewritten: the ENTIRE interpretation is rejected as
 * `AiOutputValidationError`, exactly like a schema violation or a
 * fabricated evidence id (see parseDigestInterpretationOutput).
 */

export type ClaimSafetyCategory =
  | "causal-explanation"
  | "competitor-intent"
  | "competitor-strategy"
  | "market-demand"
  | "forecast"
  | "financial-inference"
  | "win-loss";

interface ProhibitedPattern {
  category: ClaimSafetyCategory;
  pattern: RegExp;
}

/**
 * Every pattern is a specific multi-word (or otherwise sufficiently
 * distinctive) phrase form, never a single common word in isolation.
 * Exported (readonly) so tests can assert exact category coverage
 * without duplicating the list.
 */
export const PROHIBITED_CLAIM_PATTERNS: readonly ProhibitedPattern[] = [
  // Causal explanations for WHY a competitor acted - the exact gap
  // Phase 11's real run fell into ("may indicate a response to...").
  { category: "causal-explanation", pattern: /\bbecause of\b/i },
  { category: "causal-explanation", pattern: /\bdue to\b/i },
  { category: "causal-explanation", pattern: /\bcaused by\b/i },
  { category: "causal-explanation", pattern: /\bin response to\b/i },
  { category: "causal-explanation", pattern: /\bdriven by\b/i },
  { category: "causal-explanation", pattern: /\bas a result of\b/i },

  // Competitor intent.
  { category: "competitor-intent", pattern: /\bintends? to\b/i },
  { category: "competitor-intent", pattern: /\bis trying to\b/i },
  { category: "competitor-intent", pattern: /\bwants? to\b/i },
  { category: "competitor-intent", pattern: /\baims? to\b/i },
  { category: "competitor-intent", pattern: /\bplans? to\b/i },
  { category: "competitor-intent", pattern: /\bis attempting to\b/i },

  // Competitor strategy presented as an explanation of behavior - phrase
  // forms only, so a neutral mention of "pricing strategy" as a noun
  // phrase inside an observation is not blanket-banned by the bare word.
  { category: "competitor-strategy", pattern: /\bstrategic move\b/i },
  { category: "competitor-strategy", pattern: /\bcompetitive strategy\b/i },
  { category: "competitor-strategy", pattern: /\bpositioning strategy\b/i },
  { category: "competitor-strategy", pattern: /\baggressive strategy\b/i },
  { category: "competitor-strategy", pattern: /\bas (?:a|part of a) strategy\b/i },

  // Market demand/conditions asserted as an external explanation - always
  // "market"/"demand" + a specific co-occurring noun, never bare "market".
  { category: "market-demand", pattern: /\bmarket demand\b/i },
  { category: "market-demand", pattern: /\bcustomer demand\b/i },
  { category: "market-demand", pattern: /\bconsumer demand\b/i },
  { category: "market-demand", pattern: /\bincreased demand\b/i },
  { category: "market-demand", pattern: /\bdeclining demand\b/i },
  { category: "market-demand", pattern: /\bmarket conditions\b/i },
  { category: "market-demand", pattern: /\bmarket pressure\b/i },
  { category: "market-demand", pattern: /\bmarket trend/i },

  // Forecasting / prediction.
  { category: "forecast", pattern: /\bwill likely\b/i },
  { category: "forecast", pattern: /\bwill probably\b/i },
  { category: "forecast", pattern: /\bexpected to\b/i },
  { category: "forecast", pattern: /\blikely to (?:increase|decrease|rise|fall|grow|decline)\b/i },
  { category: "forecast", pattern: /\bforecast(?:s|ed|ing)?\b/i },
  { category: "forecast", pattern: /\bpredict(?:s|ed|ing|ion)?\b/i },
  { category: "forecast", pattern: /\bprojected\b/i },

  // Market share / revenue / financial inference presented as fact.
  { category: "financial-inference", pattern: /\bmarket share\b/i },
  { category: "financial-inference", pattern: /\brevenue\b/i },
  { category: "financial-inference", pattern: /\bsales growth\b/i },
  { category: "financial-inference", pattern: /\bsales decline\b/i },
  { category: "financial-inference", pattern: /\bcustomer acquisition\b/i },
  { category: "financial-inference", pattern: /\bconversion rate\b/i },

  // Win/loss claims.
  { category: "win-loss", pattern: /\bwinning customers\b/i },
  { category: "win-loss", pattern: /\blosing customers\b/i },
  { category: "win-loss", pattern: /\btaking market share\b/i },
  { category: "win-loss", pattern: /\bgaining customers\b/i },
] as const;

interface ClaimSafetyMatch {
  category: ClaimSafetyCategory;
  matchedPhrase: string;
  text: string;
}

function findFirstViolation(text: string): ClaimSafetyMatch | undefined {
  for (const { category, pattern } of PROHIBITED_CLAIM_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { category, matchedPhrase: match[0], text };
    }
  }
  return undefined;
}

/**
 * Phase 12's deterministic claim-safety validation pass. Inspects
 * `summary` plus every `observations[].text`, `interpretations[].text`,
 * and `hypotheses[].text` - the entire response is rejected the moment
 * ANY single one matches a prohibited phrase (never a partial edit; the
 * caller must treat this identically to a schema or evidence-provenance
 * failure).
 */
export function validateDigestClaimSafety(provider: string, output: AiInterpretationOutput, rawOutput: string): void {
  const candidates: string[] = [
    output.summary,
    ...output.observations.map((c) => c.text),
    ...output.interpretations.map((c) => c.text),
    ...output.hypotheses.map((c) => c.text),
  ];

  for (const text of candidates) {
    const violation = findFirstViolation(text);
    if (violation) {
      throw new AiOutputValidationError(
        provider,
        `claim contains a prohibited unsupported-claim phrase (category=${violation.category}, matched="${violation.matchedPhrase}"): "${text}"`,
        rawOutput,
      );
    }
  }
}
