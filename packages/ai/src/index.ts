/**
 * @cma/ai - Phase 3's AI interpretation layer.
 *
 * Deliberately has NO dependency on @cma/db or @cma/queue: this
 * package is pure (prompt/schema/limits/provider logic only) so it can
 * be unit tested without Postgres or Redis. The orchestration that
 * reads a ChangeEvent, calls a provider, and persists an AiAnalysis row
 * lives in apps/worker/src/aiPipeline.ts, mirroring how
 * apps/worker/src/pipeline.ts orchestrates @cma/detection +
 * @cma/extraction without either of those depending on @cma/db.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./limits.js";
export * from "./schema.js";
export * from "./buildContext.js";
export * from "./prompt.js";
export * from "./parseOutput.js";
export * from "./analyzeChangeWithRetry.js";
export * from "./providers/fakeProvider.js";
export * from "./providers/anthropicProvider.js";
