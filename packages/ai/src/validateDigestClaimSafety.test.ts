import { describe, expect, it } from "vitest";
import { buildDigestInterpretationInput } from "./buildDigestContext.js";
import { parseDigestInterpretationOutput } from "./validateDigestInterpretation.js";
import { validateDigestClaimSafety } from "./validateDigestClaimSafety.js";
import { analyzeAndValidateDigest } from "./analyzeAndValidateDigest.js";
import { createFakeAiProvider } from "./providers/fakeProvider.js";
import { AiOutputValidationError } from "./errors.js";
import type { AiInterpretationOutput, DigestForInterpretation, DigestItemForInterpretation } from "./digestTypes.js";

const WINDOW_START = new Date("2026-08-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-31T00:00:00Z");

function changeEventItem(overrides: Partial<DigestItemForInterpretation> = {}): DigestItemForInterpretation {
  return {
    kind: "CHANGE_EVENT",
    competitorId: "comp-1",
    competitorName: "Competitor One",
    detectedAt: WINDOW_END,
    changeEventIds: ["ce-1"],
    changeEventId: "ce-1",
    changeType: "PRICE_CHANGE",
    severity: "MEDIUM",
    description: "Price changed from 49.00 to 39.00.",
    ...overrides,
  };
}

function makeDigest(items: DigestItemForInterpretation[]): DigestForInterpretation {
  return {
    days: 30,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    totalTrackedCompetitors: 1,
    items,
    crossCompetitorContext: { aboveBaselineCount: 1, sustainedCount: 0, totalTrackedCompetitors: 1 },
  };
}

/** Single-item digest whose only real, allowed evidence id is "ce-1". */
function bundleWithAllowedId(id = "ce-1") {
  const digest = makeDigest([changeEventItem({ changeEventId: id, changeEventIds: [id] })]);
  return buildDigestInterpretationInput(digest);
}

function outputWith(overrides: Partial<AiInterpretationOutput>): AiInterpretationOutput {
  return {
    summary: "One verified change was recorded.",
    observations: [],
    interpretations: [],
    hypotheses: [],
    ...overrides,
  };
}

describe("validateDigestClaimSafety", () => {
  describe("safe claims (must pass)", () => {
    it("Safe 1: a normal observation describing a verified fact", () => {
      const output = outputWith({
        observations: [{ text: "Competitor A recorded 4 price changes during the selected period.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).not.toThrow();
    });

    it("Safe 2: a historical-baseline interpretation", () => {
      const output = outputWith({
        interpretations: [{ text: "This activity level is higher than Competitor A's own historical baseline.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).not.toThrow();
    });

    it("Safe 3: a repeated-price-change interpretation", () => {
      const output = outputWith({
        interpretations: [{ text: "Competitor A changed the price of the same plan twice within the period.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).not.toThrow();
    });

    it("Safe 4: an evidence-linked lifecycle observation", () => {
      const output = outputWith({
        observations: [{ text: "Competitor A added 2 new plans and removed 1 plan during the period.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).not.toThrow();
    });

    it("Safe 5: a low-confidence hypothesis that stays within supported evidence, with no causal/intent/market language", () => {
      const output = outputWith({
        hypotheses: [{ text: "The new plan may be aimed at a different customer segment than the existing plans.", evidenceChangeEventIds: ["ce-1"], confidence: "LOW" }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).not.toThrow();
    });

    it("does not flag the word 'market' in an ordinary descriptive sentence (not a bare keyword blacklist)", () => {
      const output = outputWith({
        observations: [{ text: "The competitor changed its market-facing pricing page.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).not.toThrow();
    });

    it("does not flag the bare word 'strategy' used as a neutral noun phrase", () => {
      const output = outputWith({
        observations: [{ text: "The plan is labeled 'Enterprise Strategy Tier' on the pricing page.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).not.toThrow();
    });
  });

  describe("prohibited claims (must reject)", () => {
    it("Reject 1: a market-demand explanation", () => {
      const output = outputWith({
        interpretations: [{ text: "The introduction of 'Starter Plan' may indicate a response to market demand.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("Reject 2: a competitor-intent claim", () => {
      const output = outputWith({
        hypotheses: [{ text: "Competitor A wants to attract price-sensitive customers with this change.", evidenceChangeEventIds: ["ce-1"], confidence: "LOW" }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("Reject 3: a competitor-strategy claim", () => {
      const output = outputWith({
        interpretations: [{ text: "This appears to be part of a broader aggressive strategy to undercut rivals.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("Reject 4: a causal explanation ('in response to')", () => {
      const output = outputWith({
        interpretations: [{ text: "This price change was made in response to a competitor's earlier move.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("Reject 5: a forecast/future prediction", () => {
      const output = outputWith({
        hypotheses: [{ text: "This price is likely to decrease further in the coming months.", evidenceChangeEventIds: ["ce-1"], confidence: "MEDIUM" }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("Reject 6: an unsupported market-share/revenue claim", () => {
      const output = outputWith({
        interpretations: [{ text: "This change is likely to increase Competitor A's market share.", evidenceChangeEventIds: ["ce-1"] }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("Reject 7: a win/loss claim", () => {
      const output = outputWith({
        hypotheses: [{ text: "Competitor A may be gaining customers as a result of this pricing move.", evidenceChangeEventIds: ["ce-1"], confidence: "LOW" }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("rejects a violation in the summary field, not just observations/interpretations/hypotheses", () => {
      const output = outputWith({ summary: "Competitor A's pricing change was likely driven by market demand." });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });

    it("rejects the ENTIRE response when only one of several claims is prohibited", () => {
      const output = outputWith({
        observations: [
          { text: "Competitor A recorded 4 price changes during the selected period.", evidenceChangeEventIds: ["ce-1"] },
          { text: "Competitor A added a new plan.", evidenceChangeEventIds: ["ce-1"] },
        ],
        interpretations: [{ text: "This activity is higher than Competitor A's own historical baseline.", evidenceChangeEventIds: ["ce-1"] }],
        hypotheses: [{ text: "This may be in response to market demand.", evidenceChangeEventIds: ["ce-1"], confidence: "LOW" }],
      });
      expect(() => validateDigestClaimSafety("fake", output, "raw")).toThrow(AiOutputValidationError);
    });
  });

  describe("independence from evidence-id provenance validation (Phase 12)", () => {
    const bundle = bundleWithAllowedId("ce-1");

    it("Interaction 13: safe text + an invalid evidence id -> rejected by evidence validation, before claim-safety ever runs", () => {
      const raw = JSON.stringify({
        summary: "One verified change was recorded.",
        observations: [{ text: "Competitor A recorded 4 price changes during the selected period.", evidenceChangeEventIds: ["ce-DOES-NOT-EXIST"] }],
        interpretations: [],
        hypotheses: [],
      });
      expect(() => parseDigestInterpretationOutput("fake", raw, bundle)).toThrow(/not present in the supplied evidence bundle/);
    });

    it("Interaction 14: prohibited text + valid evidence ids -> passes evidence validation but is rejected by claim-safety", () => {
      const raw = JSON.stringify({
        summary: "x",
        observations: [],
        interpretations: [{ text: "This may indicate a response to market demand.", evidenceChangeEventIds: ["ce-1"] }],
        hypotheses: [],
      });
      // Evidence validation alone accepts this - it only checks ids.
      const output = parseDigestInterpretationOutput("fake", raw, bundle);
      expect(output.interpretations).toHaveLength(1);
      // Claim-safety independently rejects it.
      expect(() => validateDigestClaimSafety("fake", output, raw)).toThrow(/prohibited unsupported-claim phrase/);
    });

    it("Interaction 15: prohibited text + an invalid evidence id -> rejected (evidence validator fires first in the real pipeline)", () => {
      const raw = JSON.stringify({
        summary: "x",
        observations: [],
        interpretations: [{ text: "This may indicate a response to market demand.", evidenceChangeEventIds: ["ce-DOES-NOT-EXIST"] }],
        hypotheses: [],
      });
      expect(() => parseDigestInterpretationOutput("fake", raw, bundle)).toThrow(AiOutputValidationError);
    });

    it("Interaction 16: end-to-end via analyzeAndValidateDigest - a real provider response with valid evidence but a prohibited claim is rejected, not persisted", async () => {
      const digest = makeDigest([changeEventItem()]);
      const providerBundle = buildDigestInterpretationInput(digest);
      const provider = createFakeAiProvider({
        respondDigest: () =>
          JSON.stringify({
            summary: "Competitor One had verified activity.",
            observations: [{ text: "Competitor One recorded a price change.", evidenceChangeEventIds: ["ce-1"] }],
            interpretations: [{ text: "This may indicate a response to market demand.", evidenceChangeEventIds: ["ce-1"] }],
            hypotheses: [],
          }),
      });

      await expect(analyzeAndValidateDigest(provider, providerBundle)).rejects.toThrow(AiOutputValidationError);
      await expect(analyzeAndValidateDigest(provider, providerBundle)).rejects.toThrow(/prohibited unsupported-claim phrase/);
    });

    it("end-to-end: a real provider response with valid evidence and safe claims is accepted", async () => {
      const digest = makeDigest([changeEventItem()]);
      const providerBundle = buildDigestInterpretationInput(digest);
      const provider = createFakeAiProvider({
        respondDigest: () =>
          JSON.stringify({
            summary: "Competitor One had verified activity.",
            observations: [{ text: "Competitor One recorded a price change.", evidenceChangeEventIds: ["ce-1"] }],
            interpretations: [{ text: "This activity is higher than Competitor One's own historical baseline.", evidenceChangeEventIds: ["ce-1"] }],
            hypotheses: [],
          }),
      });

      const { output } = await analyzeAndValidateDigest(provider, providerBundle);
      expect(output.observations).toHaveLength(1);
      expect(output.interpretations).toHaveLength(1);
    });
  });
});
