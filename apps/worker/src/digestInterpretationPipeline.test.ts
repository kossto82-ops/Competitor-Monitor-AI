import { describe, expect, it, vi } from "vitest";
import { createFakeAiProvider, AiProviderTimeoutError, type AiConnectionConfig, type AiProvider, type DigestForInterpretation } from "@cma/ai";
import { runDigestInterpretationJob, type DigestInterpretationDeps } from "./digestInterpretationPipeline.js";
import { NoAiProviderConfiguredError } from "./resolveAiProvider.js";
import type { DigestInterpretationJobPayload } from "@cma/queue";
import type { ResolvedAiProvider } from "./resolveAiProvider.js";

const PAYLOAD: DigestInterpretationJobPayload = {
  organizationId: "org-1",
  days: 30,
  digestAiInterpretationId: "interp-1",
};

const WINDOW_START = new Date("2026-08-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-31T00:00:00Z");

function digestWithOneCompetitor(): DigestForInterpretation {
  return {
    days: 30,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    totalTrackedCompetitors: 2,
    items: [
      {
        kind: "ACTIVITY_PATTERN",
        competitorId: "comp-1",
        competitorName: "Competitor One",
        detectedAt: WINDOW_END,
        changeEventIds: ["ce-1", "ce-2"],
        pattern: { current: 4, baselineAverage: 1, qualifyingWindows: 3, days: 30, direction: "ABOVE_BASELINE", ratio: 4, strongEvidence: true },
      },
    ],
    crossCompetitorContext: { aboveBaselineCount: 1, totalTrackedCompetitors: 2 },
  };
}

function emptyDigest(): DigestForInterpretation {
  return {
    days: 30,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    totalTrackedCompetitors: 0,
    items: [],
    crossCompetitorContext: { aboveBaselineCount: 0, totalTrackedCompetitors: 0 },
  };
}

function resolvedFrom(provider: AiProvider, config: AiConnectionConfig = { provider: "fake", model: "fake" }): ResolvedAiProvider {
  return { provider, config };
}

function makeDeps(overrides: Partial<DigestInterpretationDeps> = {}): DigestInterpretationDeps {
  return {
    resolveProvider: vi.fn().mockResolvedValue(resolvedFrom(createFakeAiProvider())),
    getDigestAiInterpretationForOrgOrThrow: vi.fn().mockResolvedValue({ id: "interp-1", status: "PENDING" }),
    getOrganizationById: vi.fn().mockResolvedValue({ timezone: "UTC" }),
    getDigestForOrganization: vi.fn().mockResolvedValue(digestWithOneCompetitor()),
    markDigestAiInterpretationRunning: vi.fn().mockResolvedValue(undefined),
    markDigestAiInterpretationCompleted: vi.fn().mockResolvedValue({ id: "interp-1" }),
    markDigestAiInterpretationFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runDigestInterpretationJob", () => {
  it("interprets a non-empty digest and persists a COMPLETED result with provider/model metadata and the window actually used", async () => {
    const provider = createFakeAiProvider();
    const deps = makeDeps({ resolveProvider: vi.fn().mockResolvedValue(resolvedFrom(provider)) });

    const result = await runDigestInterpretationJob(PAYLOAD, deps);

    expect(result.status).toBe("COMPLETED");
    expect(deps.markDigestAiInterpretationRunning).toHaveBeenCalledWith("interp-1");
    expect(deps.markDigestAiInterpretationCompleted).toHaveBeenCalledWith(
      "interp-1",
      expect.objectContaining({ provider: "fake", model: "fake", windowStart: WINDOW_START, windowEnd: WINDOW_END }),
    );
    expect(provider.digestCallCount).toBe(1);
  });

  it("resolves the provider using THIS job's own organizationId", async () => {
    const resolveProvider = vi.fn().mockResolvedValue(resolvedFrom(createFakeAiProvider()));
    const deps = makeDeps({ resolveProvider });
    await runDigestInterpretationJob(PAYLOAD, deps);
    expect(resolveProvider).toHaveBeenCalledWith("org-1");
  });

  it("recomputes the digest with the organization's own timezone", async () => {
    const getDigestForOrganization = vi.fn().mockResolvedValue(digestWithOneCompetitor());
    const deps = makeDeps({
      getOrganizationById: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }),
      getDigestForOrganization,
    });
    await runDigestInterpretationJob(PAYLOAD, deps);
    expect(getDigestForOrganization).toHaveBeenCalledWith("org-1", 30, "Europe/Berlin");
  });

  it("an idempotency guard: an already-COMPLETED row is returned as-is, never re-analyzed (no provider call)", async () => {
    const provider = createFakeAiProvider();
    const deps = makeDeps({
      getDigestAiInterpretationForOrgOrThrow: vi.fn().mockResolvedValue({ id: "interp-1", status: "COMPLETED" }),
      resolveProvider: vi.fn().mockResolvedValue(resolvedFrom(provider)),
    });

    const result = await runDigestInterpretationJob(PAYLOAD, deps);
    expect(result.status).toBe("COMPLETED");
    expect(provider.digestCallCount).toBe(0);
    expect(deps.markDigestAiInterpretationRunning).not.toHaveBeenCalled();
  });

  it("Section 18 (cost control): an empty bundle (nothing to interpret) completes WITHOUT any provider call, using the deterministic insufficient-evidence shape", async () => {
    const provider = createFakeAiProvider();
    const deps = makeDeps({
      getDigestForOrganization: vi.fn().mockResolvedValue(emptyDigest()),
      resolveProvider: vi.fn().mockResolvedValue(resolvedFrom(provider)),
    });

    const result = await runDigestInterpretationJob(PAYLOAD, deps);

    expect(result.status).toBe("COMPLETED");
    expect(provider.digestCallCount).toBe(0);
    expect(deps.markDigestAiInterpretationCompleted).toHaveBeenCalledWith(
      "interp-1",
      expect.objectContaining({
        provider: "none",
        summary: "There is not enough verified activity in this period to interpret.",
        observations: [],
        interpretations: [],
        hypotheses: [],
      }),
    );
  });

  it("marks FAILED when no AI provider is configured for the organization, without ever touching the deterministic Digest", async () => {
    const deps = makeDeps({ resolveProvider: vi.fn().mockRejectedValue(new NoAiProviderConfiguredError("org-1")) });
    await expect(runDigestInterpretationJob(PAYLOAD, deps)).rejects.toThrow(NoAiProviderConfiguredError);
    expect(deps.markDigestAiInterpretationFailed).toHaveBeenCalledWith("interp-1", expect.stringContaining("No AI provider"));
    expect(deps.getDigestForOrganization).not.toHaveBeenCalled();
  });

  it("marks FAILED when the provider throws after retries are exhausted", async () => {
    const provider = createFakeAiProvider({ throwErrorDigest: () => new AiProviderTimeoutError("fake", 30_000), failFirstNDigestCalls: 99 });
    const deps = makeDeps({ resolveProvider: vi.fn().mockResolvedValue(resolvedFrom(provider)) });

    const result = await runDigestInterpretationJob(PAYLOAD, deps);
    expect(result.status).toBe("FAILED");
    expect(deps.markDigestAiInterpretationFailed).toHaveBeenCalledWith("interp-1", expect.stringContaining("did not respond"));
  });

  it("marks FAILED when the provider returns output citing an evidence id outside the supplied bundle", async () => {
    const provider = createFakeAiProvider({
      respondDigest: () =>
        JSON.stringify({
          summary: "x",
          observations: [{ text: "fabricated", evidenceChangeEventIds: ["ce-does-not-exist"] }],
          interpretations: [],
          hypotheses: [],
        }),
    });
    const deps = makeDeps({ resolveProvider: vi.fn().mockResolvedValue(resolvedFrom(provider)) });

    const result = await runDigestInterpretationJob(PAYLOAD, deps);
    expect(result.status).toBe("FAILED");
    expect(deps.markDigestAiInterpretationFailed).toHaveBeenCalledWith("interp-1", expect.stringContaining("not present in the supplied evidence bundle"));
  });

  it("makes at most 2 provider calls total (1 + at most 1 internal retry) even on repeated transient failure", async () => {
    const provider = createFakeAiProvider({ throwErrorDigest: () => new AiProviderTimeoutError("fake", 30_000), failFirstNDigestCalls: 99 });
    const deps = makeDeps({ resolveProvider: vi.fn().mockResolvedValue(resolvedFrom(provider)) });
    await runDigestInterpretationJob(PAYLOAD, deps);
    expect(provider.digestCallCount).toBe(2);
  });
});
