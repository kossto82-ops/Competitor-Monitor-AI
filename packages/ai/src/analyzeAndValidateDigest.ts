import { interpretDigestWithRetry } from "./interpretDigestWithRetry.js";
import { parseDigestInterpretationOutput } from "./validateDigestInterpretation.js";
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
 * digestInterpretationPipeline.ts) never call provider.interpretDigest
 * or parseDigestInterpretationOutput directly - this is the one path,
 * applied identically no matter which AiProvider produced the text.
 */
export async function analyzeAndValidateDigest(provider: AiProvider, bundle: EvidenceBundle): Promise<AnalyzedDigest> {
  const raw = await interpretDigestWithRetry(provider, bundle);
  const output = parseDigestInterpretationOutput(provider.name, raw.content, bundle);
  return { output, raw };
}
