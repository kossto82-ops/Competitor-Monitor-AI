import { analyzeChangeWithRetry } from "./analyzeChangeWithRetry.js";
import { parseAiOutput } from "./parseOutput.js";
import type { AiAnalysisOutput, AiProvider, ChangeAnalysisInput, NormalizedAiResponse } from "./types.js";

export interface AnalyzedChange {
  output: AiAnalysisOutput;
  raw: NormalizedAiResponse;
}

/**
 * Phase 3.1 (Section 13): the single place `NormalizedAiResponse.content`
 * becomes trusted structured data, applied identically no matter which
 * `AiProvider` produced it. Providers translate vendor responses into
 * plain text (Section 2: "no vendor-specific response objects escape
 * the provider layer"); this function is what turns that text into a
 * schema-validated `AiAnalysisOutput` or rejects it (Section 4: "never
 * trust the model response merely because [the vendor API] returned
 * HTTP 200" - malformed/schema-invalid output throws
 * AiOutputValidationError here, for every provider, not just some).
 */
export async function analyzeAndValidateChange(provider: AiProvider, input: ChangeAnalysisInput): Promise<AnalyzedChange> {
  const raw = await analyzeChangeWithRetry(provider, input);
  const output = parseAiOutput(provider.name, raw.content);
  return { output, raw };
}
