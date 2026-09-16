/**
 * @cma/ai - the AI interpretation layer (Phase 3, made provider-neutral
 * and multi-tenant in Phase 3.1).
 *
 * Deliberately has NO dependency on @cma/db or @cma/queue: this
 * package is pure (prompt/schema/limits/provider/registry logic only,
 * plus @cma/security for credential-safe outbound requests) so it can
 * be unit tested without Postgres or Redis. The orchestration that
 * reads a ChangeEvent, resolves an organization's AiConnection, calls a
 * provider, and persists an AiAnalysis row lives in
 * apps/worker/src/aiPipeline.ts, mirroring how apps/worker/src/pipeline.ts
 * orchestrates @cma/detection + @cma/extraction without either of those
 * depending on @cma/db.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./limits.js";
export * from "./schema.js";
export * from "./pricing.js";
export * from "./buildContext.js";
export * from "./prompt.js";
export * from "./parseOutput.js";
export * from "./analyzeChangeWithRetry.js";
export * from "./analyzeAndValidateChange.js";
export * from "./registry.js";
export * from "./testConnection.js";
export * from "./providers/fakeProvider.js";
export * from "./providers/openaiProvider.js";
export * from "./providers/openaiCompatibleProvider.js";

// Phase 11 (Tier 4 - Evidence-Grounded AI Interpretation): the Digest
// interpretation path, parallel to the ChangeEvent path above. See
// digestTypes.ts's module doc comment for the architecture rationale.
export * from "./digestTypes.js";
export * from "./digestLimits.js";
export * from "./digestSchema.js";
export * from "./buildDigestContext.js";
export * from "./digestPrompt.js";
export * from "./validateDigestInterpretation.js";
export * from "./interpretDigestWithRetry.js";
export * from "./analyzeAndValidateDigest.js";
