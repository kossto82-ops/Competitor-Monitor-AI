import { interpretDigestWithRetry } from "./interpretDigestWithRetry.js";
import { parseDigestInterpretationOutput } from "./validateDigestInterpretation.js";
import { validateDigestClaimSafety } from "./validateDigestClaimSafety.js";
import type { AiInterpretationOutput, EvidenceBundle } from "./digestTypes.js";
import type { AiProvider, NormalizedAiResponse } from "./types.js";

export interface AnalyzedDigest {
  output: AiInterpretationOutput;
  raw: NormalizedAiResponse;
}

/**
 * Phase 11's equivalent of analyzeAndValidateChange.ts: the single place
 * a provider's raw Tier-4 response text becomes trusted, evidence-
 * checked structured data. Callers (apps/worker/src/
 * digestInterpretationPipeline.ts) never call provider.interpretDigest,
 * parseDigestInterpretationOutput, or validateDigestClaimSafety
 * directly - this is the one path, applied identically no matter which
 * AiProvider produced the text.
 *
 * Phase 12: `validateDigestClaimSafety` runs as a THIRD, independent
 * step after schema validation and evidence-id provenance validation -
 * never merged into either. A response can fail schema validation,
 * evidence-provenance validation, claim-safety validation, or none of
 * the three; passing one check never exempts it from the others (see
 * validateDigestClaimSafety.ts's module doc comment and
 * digestInterpretation.test.ts's independence tests).
 */
export async function analyzeAndValidateDigest(provider: AiProvider, bundle: EvidenceBundle): Promise<AnalyzedDigest> {
  const raw = await interpretDigestWithRetry(provider, bundle);
  const output = parseDigestInterpretationOutput(provider.name, raw.content, bundle);
  validateDigestClaimSafety(provider.name, output, raw.content);
  return { output, raw };
}
