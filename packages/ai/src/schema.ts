import { z } from "zod";
import { AI_CONFIDENCE_LEVELS } from "./types.js";

/**
 * Bumped whenever buildUserPrompt/buildSystemPrompt's instructions
 * change in a way that would make an old AiAnalysis row's output no
 * longer comparable to a fresh one - persisted on every row (Section 6
 * & 16) so a future re-analysis feature can tell "analyzed under the
 * old prompt" apart from "analyzed under the current one".
 */
export const PROMPT_VERSION = "change-analysis-v1";

/**
 * Section 5's strict schema. Bounded array/string lengths double as a
 * defense-in-depth output cap - even a provider that ignored
 * MAX_OUTPUT_CHARS on the way in cannot pass validation with an
 * unbounded response.
 */
export const aiAnalysisOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  facts: z.array(z.string().trim().min(1).max(500)).max(20),
  interpretations: z.array(z.string().trim().min(1).max(500)).max(10),
  speculation: z.array(z.string().trim().min(1).max(500)).max(10),
  confidence: z.enum(AI_CONFIDENCE_LEVELS),
});
