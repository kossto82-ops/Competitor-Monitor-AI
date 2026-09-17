// Phase 12: extends phase11RealProviderSmoke.mjs (kept unmodified, not part
// of CI) with real-provider validation of the new claim-safety defense layer.
// Exercises the FULL pipeline - JSON parse -> zod schema -> evidence-id
// provenance validation -> claim-safety validation (Phase 12) - against a
// REAL provider when credentials are available in the environment, same
// OPENAI_API_KEY/CMA_AI_MODEL convention as the Phase 11 script.
//
// Three cases:
//   A. A safe, single-competitor bundle (no cross-competitor PRODUCT_ADDED
//      event, the ingredient behind Phase 11's speculative-language run) ->
//      a fresh real call -> expect the whole pipeline to PASS.
//   B. The EXACT EvidenceBundle from Phase 11's real run
//      (PHASE11-VALIDATION-REPORT.md Section 12), which produced a
//      prohibited "market demand" claim on that run -> a FRESH real call
//      this run (model output is probabilistic - Finding #2's own point -
//      so this script reports the actual live outcome honestly, whatever
//      it is) PLUS a deterministic replay of the exact recorded Phase 11
//      raw output (hardcoded verbatim from that report, not fabricated)
//      through the validation pipeline, which MUST be rejected regardless
//      of what today's live call happens to say.
//   C. A real model response (Case A's own live output) with one
//      evidenceChangeEventIds entry mutated to a fabricated id -> expect
//      REJECT by evidence-provenance validation - independent of, and
//      unaffected by, claim-safety validation passing or failing.
//
// Does not assert exact LLM wording anywhere - only structural/validation
// outcomes. Never prints the API key or any other secret.

import { OpenAiProvider } from "../../packages/ai/dist/providers/openaiProvider.js";
import {
  analyzeAndValidateDigest,
  buildDigestInterpretationInput,
  parseDigestInterpretationOutput,
  validateDigestClaimSafety,
} from "../../packages/ai/dist/index.js";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.CMA_AI_MODEL || "gpt-4o-mini";

const results = { provider: "openai", model, cases: {} };

if (!apiKey) {
  console.log(JSON.stringify({ ok: false, error: "no OPENAI_API_KEY - real-provider validation not performed", ...results }, null, 2));
  process.exit(1);
}

function safeDigest() {
  return {
    days: 30,
    windowStart: new Date("2026-08-01T00:00:00Z"),
    windowEnd: new Date("2026-08-31T00:00:00Z"),
    totalTrackedCompetitors: 1,
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
    ],
    crossCompetitorContext: { aboveBaselineCount: 1, totalTrackedCompetitors: 1 },
  };
}

/** Verbatim from PHASE11-VALIDATION-REPORT.md Section 12 - the exact bundle whose real run produced the "market demand" interpretation (Finding #2). */
function phase11Digest() {
  return {
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
}

/** Verbatim recorded output from PHASE11-VALIDATION-REPORT.md Section 12 - a REAL gpt-4o-mini response, not fabricated for this script. */
const PHASE11_RECORDED_OUTPUT = {
  summary:
    "Acme Rivals Inc exhibited elevated activity with significant pricing changes, while Beta Competitor Co introduced a new product.",
  observations: [
    { text: "Acme Rivals Inc recorded 4 activity pattern occurrences during the selected period.", evidenceChangeEventIds: ["ce-1", "ce-2", "ce-3", "ce-4"] },
    { text: "Acme Rivals Inc had 2 repeated price changes detected within the same timeframe.", evidenceChangeEventIds: ["ce-1", "ce-2"] },
    { text: "Beta Competitor Co added a new product identified as 'Starter Plan'.", evidenceChangeEventIds: ["ce-5"] },
  ],
  interpretations: [
    { text: "The activity level of Acme Rivals Inc is significantly higher than its historical baseline.", evidenceChangeEventIds: ["ce-1", "ce-2", "ce-3", "ce-4"] },
    { text: "The introduction of 'Starter Plan' by Beta Competitor Co may indicate a response to market demand.", evidenceChangeEventIds: ["ce-5"] },
  ],
  hypotheses: [],
};

async function runCaseA() {
  const bundle = buildDigestInterpretationInput(safeDigest());
  const provider = new OpenAiProvider({ apiKey, model });
  const start = Date.now();
  try {
    const { output, raw } = await analyzeAndValidateDigest(provider, bundle);
    return { ok: true, durationMs: Date.now() - start, output, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, rawContent: raw.content };
  } catch (err) {
    return { ok: false, rejectedBy: err?.name, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runCaseBLive() {
  const bundle = buildDigestInterpretationInput(phase11Digest());
  const provider = new OpenAiProvider({ apiKey, model });
  const start = Date.now();
  try {
    const { output, raw } = await analyzeAndValidateDigest(provider, bundle);
    return { ok: true, durationMs: Date.now() - start, output, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, note: "this run's live model output did not trigger the claim-safety validator" };
  } catch (err) {
    return { ok: false, rejectedBy: err?.name, error: err instanceof Error ? err.message : String(err) };
  }
}

function runCaseBRecordedReplay() {
  const bundle = buildDigestInterpretationInput(phase11Digest());
  try {
    validateDigestClaimSafety("openai", PHASE11_RECORDED_OUTPUT, JSON.stringify(PHASE11_RECORDED_OUTPUT));
    // Must never reach here - this recorded output contains the known
    // prohibited phrase and MUST be rejected.
    return { ok: false, unexpected: "recorded Phase 11 output was NOT rejected - regression" };
  } catch (err) {
    return { ok: true, rejectedBy: err?.name, error: err instanceof Error ? err.message : String(err), bundleAllowedIds: bundle.allowedEvidenceChangeEventIds };
  }
}

function runCaseC(caseAResult) {
  if (!caseAResult.ok || !caseAResult.rawContent) {
    return { ok: false, skipped: true, reason: "Case A did not produce a real raw response to mutate" };
  }
  let parsed;
  try {
    parsed = JSON.parse(caseAResult.rawContent);
  } catch {
    return { ok: false, skipped: true, reason: "Case A's raw response was not valid JSON to mutate" };
  }
  if (Array.isArray(parsed.observations) && parsed.observations.length > 0 && Array.isArray(parsed.observations[0].evidenceChangeEventIds)) {
    parsed.observations[0].evidenceChangeEventIds = ["ce-FABRICATED-DOES-NOT-EXIST"];
  } else {
    // Real response had no observations to mutate - inject one deterministically.
    parsed.observations = [{ text: "fabricated for Case C", evidenceChangeEventIds: ["ce-FABRICATED-DOES-NOT-EXIST"] }];
  }
  const bundle = buildDigestInterpretationInput(safeDigest());
  try {
    parseDigestInterpretationOutput("openai", JSON.stringify(parsed), bundle);
    return { ok: false, unexpected: "mutated fabricated-evidence-id response was NOT rejected - regression" };
  } catch (err) {
    return { ok: true, rejectedBy: err?.name, error: err instanceof Error ? err.message : String(err) };
  }
}

const caseA = await runCaseA();
results.cases.A_safe_interpretation = caseA;

const caseBLive = await runCaseBLive();
results.cases.B_live_repeat_of_phase11_bundle = caseBLive;

results.cases.B_deterministic_replay_of_recorded_phase11_output = runCaseBRecordedReplay();

results.cases.C_fabricated_evidence_id = runCaseC(caseA);

const overallOk =
  caseA.ok &&
  results.cases.B_deterministic_replay_of_recorded_phase11_output.ok &&
  results.cases.C_fabricated_evidence_id.ok;

console.log(JSON.stringify({ ok: overallOk, ...results }, null, 2));
process.exit(overallOk ? 0 : 1);
