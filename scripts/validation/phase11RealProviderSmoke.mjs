// Phase 11 (Section 33 of the brief): a scratch, one-off real-provider
// validation script - NOT part of the shipped test suite, NOT run in CI.
// Exercises Digest -> EvidenceBundle -> the REAL OpenAiProvider -> real
// model call -> analyzeAndValidateDigest's schema+evidence validation,
// using the customer-owned OPENAI_API_KEY already present in this local
// .env (see PHASE11-VALIDATION-REPORT.md Section 33 for the recorded
// result). Deleted or left in place is immaterial; it makes no
// assumption about deployment.

import { OpenAiProvider } from "../../packages/ai/dist/providers/openaiProvider.js";
import { analyzeAndValidateDigest, buildDigestInterpretationInput } from "../../packages/ai/dist/index.js";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.CMA_AI_MODEL || "gpt-4o-mini";
if (!apiKey) {
  console.log(JSON.stringify({ ok: false, error: "no OPENAI_API_KEY" }));
  process.exit(1);
}

const digest = {
  days: 30,
  windowStart: new Date("2026-08-01T00:00:00Z"),
  windowEnd: new Date("2026-08-31T00:00:00Z"),
  totalTrackedCompetitors: 2,
  items: [
    {
      kind: "ACTIVITY_PATTERN",
      competitorId: "comp-1",
      competitorName: "Acme Rivals Inc",
      detectedAt: new Date("2026-08-30T00:00:00Z"),
      changeEventIds: ["ce-1", "ce-2", "ce-3", "ce-4"],
      pattern: { current: 4, baselineAverage: 1, qualifyingWindows: 3, days: 30, direction: "ABOVE_BASELINE", ratio: 4, strongEvidence: true },
    },
    {
      kind: "REPEATED_PRICE_CHANGE",
      competitorId: "comp-1",
      competitorName: "Acme Rivals Inc",
      detectedAt: new Date("2026-08-29T00:00:00Z"),
      changeEventIds: ["ce-1", "ce-2"],
      pattern: { label: "Pro Plan", changeCount: 2, qualifies: true, days: 30, monitoredUrlId: "url-1", entityKey: "pro-plan" },
    },
    {
      kind: "CHANGE_EVENT",
      competitorId: "comp-2",
      competitorName: "Beta Competitor Co",
      detectedAt: new Date("2026-08-28T00:00:00Z"),
      changeEventIds: ["ce-5"],
      changeEventId: "ce-5",
      changeType: "PRODUCT_ADDED",
      severity: "MEDIUM",
      description: 'A new item "Starter Plan" was detected with value 9.00.',
    },
  ],
  crossCompetitorContext: { aboveBaselineCount: 1, totalTrackedCompetitors: 2 },
};

const bundle = buildDigestInterpretationInput(digest);
const provider = new OpenAiProvider({ apiKey, model });

const start = Date.now();
try {
  const { output, raw } = await analyzeAndValidateDigest(provider, bundle);
  console.log(
    JSON.stringify({ ok: true, durationMs: Date.now() - start, output, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens }, null, 2),
  );
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), name: err?.name }, null, 2));
  process.exit(1);
}
