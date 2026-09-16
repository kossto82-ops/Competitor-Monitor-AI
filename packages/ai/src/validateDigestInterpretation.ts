import { aiInterpretationOutputSchema } from "./digestSchema.js";
import { AiOutputValidationError } from "./errors.js";
import { MAX_DIGEST_OUTPUT_CHARS } from "./digestLimits.js";
import type { AiInterpretationOutput, EvidenceBundle } from "./digestTypes.js";

/**
 * Phase 11 (Section 12/33 of the brief): the second, MANDATORY
 * validation pass beyond schema-shape - every evidenceChangeEventIds
 * entry across every observation/interpretation/hypothesis MUST already
 * be present in the EvidenceBundle that was actually sent to the model
 * (`bundle.allowedEvidenceChangeEventIds`). A syntactically valid JSON
 * response that cites an id never given to the model is REJECTED here,
 * exactly like malformed JSON or a schema violation - "the model
 * returned valid JSON" is never sufficient on its own (mirrors
 * parseAiOutput.ts's rationale for the ChangeEvent path, extended with
 * this bundle-scoped provenance check that the single-ChangeEvent path
 * has no equivalent need for).
 */
function findUnknownEvidenceIds(output: AiInterpretationOutput, allowedIds: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();
  const allClaims = [...output.observations, ...output.interpretations, ...output.hypotheses];
  for (const claim of allClaims) {
    for (const id of claim.evidenceChangeEventIds) {
      if (!allowedIds.has(id)) unknown.add(id);
    }
  }
  return Array.from(unknown);
}

/**
 * Shared by every provider implementation, mirrors parseAiOutput.ts's
 * structure exactly: strip an optional ```json fence, JSON.parse, then
 * zod-validate. This function ADDITIONALLY validates evidence
 * provenance against `bundle` - a step parseAiOutput.ts has no
 * equivalent of, since a single-ChangeEvent analysis has no multi-item
 * evidence bundle to check ids against.
 */
export function parseDigestInterpretationOutput(provider: string, rawText: string, bundle: EvidenceBundle): AiInterpretationOutput {
  if (rawText.length > MAX_DIGEST_OUTPUT_CHARS) {
    throw new AiOutputValidationError(provider, `response exceeded ${MAX_DIGEST_OUTPUT_CHARS} characters`, rawText.slice(0, 200));
  }

  const fenced = rawText.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1]! : rawText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AiOutputValidationError(provider, `not valid JSON: ${message}`, rawText);
  }

  const result = aiInterpretationOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new AiOutputValidationError(provider, `failed schema validation: ${result.error.message}`, rawText);
  }

  const allowedIds = new Set(bundle.allowedEvidenceChangeEventIds);
  const unknownIds = findUnknownEvidenceIds(result.data, allowedIds);
  if (unknownIds.length > 0) {
    throw new AiOutputValidationError(
      provider,
      `cited evidenceChangeEventIds not present in the supplied evidence bundle: ${unknownIds.join(", ")}`,
      rawText,
    );
  }

  return result.data;
}
