import { z } from "zod";
import { AI_HYPOTHESIS_CONFIDENCE_LEVELS } from "./digestTypes.js";
import { MAX_CLAIM_TEXT_CHARS, MAX_EVIDENCE_IDS_PER_CLAIM, MAX_HYPOTHESES, MAX_INTERPRETATIONS, MAX_OBSERVATIONS, MAX_SUMMARY_CHARS } from "./digestLimits.js";

/**
 * Bumped whenever buildDigestSystemPrompt/buildDigestUserPrompt's
 * instructions change in a way that would make an old
 * DigestAiInterpretation row no longer comparable to a fresh one -
 * mirrors PROMPT_VERSION's role for the ChangeEvent path.
 */
export const DIGEST_PROMPT_VERSION = "digest-interpretation-v1";

const evidenceIdsSchema = z.array(z.string().trim().min(1)).min(1).max(MAX_EVIDENCE_IDS_PER_CLAIM);

const claimSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CLAIM_TEXT_CHARS),
  evidenceChangeEventIds: evidenceIdsSchema,
});

const hypothesisSchema = claimSchema.extend({
  confidence: z.enum(AI_HYPOTHESIS_CONFIDENCE_LEVELS),
});

/**
 * Section 13/14 of the brief: the strict schema every provider's raw
 * text must match. Every array is length-capped (defense-in-depth beyond
 * the prompt's own instructions, same layering rationale as
 * aiAnalysisOutputSchema) and every claim MUST carry at least one
 * evidence id - an unsupported/bare assertion is a schema violation, not
 * just a style preference.
 */
export const aiInterpretationOutputSchema = z.object({
  summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
  observations: z.array(claimSchema).max(MAX_OBSERVATIONS),
  interpretations: z.array(claimSchema).max(MAX_INTERPRETATIONS),
  hypotheses: z.array(hypothesisSchema).max(MAX_HYPOTHESES),
});

/**
 * Plain JSON Schema mirror for providers with native structured-output
 * support - a request-time hint only, mirrors
 * aiAnalysisOutputJsonSchema's own doc comment: the zod schema above
 * remains the actual enforcement point regardless of what was requested.
 */
export const aiInterpretationOutputJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    observations: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, evidenceChangeEventIds: { type: "array", items: { type: "string" } } },
        required: ["text", "evidenceChangeEventIds"],
        additionalProperties: false,
      },
    },
    interpretations: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, evidenceChangeEventIds: { type: "array", items: { type: "string" } } },
        required: ["text", "evidenceChangeEventIds"],
        additionalProperties: false,
      },
    },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          evidenceChangeEventIds: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: [...AI_HYPOTHESIS_CONFIDENCE_LEVELS] },
        },
        required: ["text", "evidenceChangeEventIds", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "observations", "interpretations", "hypotheses"],
  additionalProperties: false,
} as const;
