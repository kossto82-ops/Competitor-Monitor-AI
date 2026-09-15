import { aiAnalysisOutputSchema } from "./schema.js";
import { AiOutputValidationError } from "./errors.js";
import { MAX_OUTPUT_CHARS } from "./limits.js";
import type { AiAnalysisOutput } from "./types.js";

/**
 * Shared by every provider implementation so "reject malformed
 * output"/"reject schema-invalid output" (Section 5) behave identically
 * regardless of which model produced the text. Strips an optional
 * ```json fence some models add despite being told not to - a
 * tolerance for real-world formatting quirks, not a relaxation of the
 * schema itself.
 */
export function parseAiOutput(provider: string, rawText: string): AiAnalysisOutput {
  if (rawText.length > MAX_OUTPUT_CHARS) {
    throw new AiOutputValidationError(provider, `response exceeded ${MAX_OUTPUT_CHARS} characters`, rawText.slice(0, 200));
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

  const result = aiAnalysisOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new AiOutputValidationError(provider, `failed schema validation: ${result.error.message}`, rawText);
  }
  return result.data;
}
