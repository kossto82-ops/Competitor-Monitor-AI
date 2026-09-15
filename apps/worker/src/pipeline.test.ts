import { describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "@cma/core";
import { runMonitoringJob, type PipelineDeps } from "./pipeline.js";

function extractionResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    method: "CHEERIO",
    requestedUrl: "https://competitor.test/pricing",
    finalUrl: "https://competitor.test/pricing",
    httpStatus: 200,
    errorMessage: null,
    normalizedContent: "Pro Plan 39 EUR",
    contentHash: "hash-current",
    structuredDataHash: "struct-current",
    extractedEntities: [],
    confidence: 1,
    warnings: [],
    durationMs: 12,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    extractor: { extract: vi.fn().mockResolvedValue(extractionResult()) },
    getMonitoredUrlForOrg: vi.fn().mockResolvedValue({
      id: "url-1",
      organizationId: "org-1",
      url: "https://competitor.test/pricing",
    }),
    getLatestVerifiedSnapshot: vi.fn().mockResolvedValue(null),
    createRunningMonitoringJob: vi.fn().mockResolvedValue({ id: "job-1" }),
    markMonitoringJobRunning: vi.fn().mockResolvedValue({ id: "pending-job-1" }),
    markMonitoringJobFailed: vi.fn().mockResolvedValue(undefined),
    persistMonitoringResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runMonitoringJob", () => {
  it("re-validates the URL belongs to the claimed organization before doing anything else", async () => {
    const deps = makeDeps();
    await runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps);
    expect(deps.getMonitoredUrlForOrg).toHaveBeenCalledWith("org-1", "url-1");
  });

  it("uses the pre-created MonitoringJob row (payload.monitoringJobId) instead of creating a new one, when present", async () => {
    const deps = makeDeps();
    const result = await runMonitoringJob(
      { organizationId: "org-1", monitoredUrlId: "url-1", monitoringJobId: "pending-job-1" },
      deps,
    );

    expect(deps.markMonitoringJobRunning).toHaveBeenCalledWith("pending-job-1");
    expect(deps.createRunningMonitoringJob).not.toHaveBeenCalled();
    expect(result.monitoringJobId).toBe("pending-job-1");
    expect(deps.persistMonitoringResult).toHaveBeenCalledWith("pending-job-1", expect.anything());
  });

  it("falls back to creating a new MonitoringJob row when no monitoringJobId is on the payload (the CLI/enqueue-all path)", async () => {
    const deps = makeDeps();
    await runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps);

    expect(deps.createRunningMonitoringJob).toHaveBeenCalledWith("org-1", "url-1");
    expect(deps.markMonitoringJobRunning).not.toHaveBeenCalled();
  });

  it("treats the first successful extraction as a baseline (NO_CHANGE, zero change events)", async () => {
    const deps = makeDeps();
    const result = await runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps);

    expect(result.verificationState).toBe("NO_CHANGE");
    expect(result.changeEventCount).toBe(0);
    expect(deps.persistMonitoringResult).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ organizationId: "org-1", monitoredUrlId: "url-1", previousSnapshotId: null }),
    );
  });

  it("produces a CHANGED result with change events when content differs from the prior snapshot", async () => {
    const deps = makeDeps({
      getLatestVerifiedSnapshot: vi.fn().mockResolvedValue({
        id: "snap-prior",
        contentHash: "hash-old",
        structuredDataHash: "struct-old",
        normalizedContent: "Pro Plan 49 EUR",
        extractedEntities: [
          { type: "PRICE", key: "jsonld:pro plan", label: "Pro Plan", value: "49.00", currency: "EUR", raw: "{}" },
        ],
      }),
      extractor: {
        extract: vi.fn().mockResolvedValue(
          extractionResult({
            extractedEntities: [
              { type: "PRICE", key: "jsonld:pro plan", label: "Pro Plan", value: "39.00", currency: "EUR", raw: "{}" },
            ],
          }),
        ),
      },
    });

    const result = await runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps);

    expect(result.verificationState).toBe("CHANGED");
    expect(result.changeEventCount).toBe(1);
    const calls = (deps.persistMonitoringResult as ReturnType<typeof vi.fn>).mock.calls;
    const persistedCall = calls[0]?.[1];
    expect(persistedCall?.previousSnapshotId).toBe("snap-prior");
    expect(persistedCall?.comparison.changeEvents[0]?.changeType).toBe("PRICE_CHANGE");
  });

  it("never invents a change when extraction fails - persists FAILED_TO_VERIFY with zero change events", async () => {
    const deps = makeDeps({
      getLatestVerifiedSnapshot: vi.fn().mockResolvedValue({
        id: "snap-prior",
        contentHash: "hash-old",
        structuredDataHash: "struct-old",
        normalizedContent: "Pro Plan 49 EUR",
        extractedEntities: [],
      }),
      extractor: {
        extract: vi.fn().mockResolvedValue(
          extractionResult({ httpStatus: 403, errorMessage: "Unexpected HTTP status 403", normalizedContent: "" }),
        ),
      },
    });

    const result = await runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps);

    expect(result.verificationState).toBe("FAILED_TO_VERIFY");
    expect(result.changeEventCount).toBe(0);
  });

  it("always writes a usage record via persistMonitoringResult, even on failure", async () => {
    const deps = makeDeps({
      extractor: {
        extract: vi.fn().mockResolvedValue(extractionResult({ httpStatus: 500, errorMessage: "boom" })),
      },
    });

    await runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps);
    expect(deps.persistMonitoringResult).toHaveBeenCalledTimes(1);
  });

  describe("unexpected pipeline exceptions (Phase 2.1 data-integrity hardening)", () => {
    it("marks the job FAILED and rethrows when the extractor itself throws, instead of leaving it stuck RUNNING", async () => {
      const boom = new Error("extractor crashed unexpectedly");
      const deps = makeDeps({
        extractor: { extract: vi.fn().mockRejectedValue(boom) },
      });

      await expect(
        runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1", monitoringJobId: "pending-job-1" }, deps),
      ).rejects.toThrow(boom);

      expect(deps.markMonitoringJobFailed).toHaveBeenCalledWith("pending-job-1", boom.message);
      // A genuine execution failure never calls persistMonitoringResult -
      // there is no ExtractionResult/ComparisonResult to write, and doing
      // so would fabricate a Snapshot for an attempt that never actually
      // fetched anything.
      expect(deps.persistMonitoringResult).not.toHaveBeenCalled();
    });

    it("marks the job FAILED and rethrows when persistMonitoringResult itself throws (e.g. a DB error mid-transaction)", async () => {
      const dbError = new Error("connection terminated unexpectedly");
      const deps = makeDeps({
        persistMonitoringResult: vi.fn().mockRejectedValue(dbError),
      });

      await expect(runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps)).rejects.toThrow(
        dbError,
      );

      expect(deps.markMonitoringJobFailed).toHaveBeenCalledWith("job-1", dbError.message);
    });

    it("does not let a failure in markMonitoringJobFailed itself swallow or replace the original error", async () => {
      const boom = new Error("extractor crashed unexpectedly");
      const deps = makeDeps({
        extractor: { extract: vi.fn().mockRejectedValue(boom) },
        markMonitoringJobFailed: vi.fn().mockRejectedValue(new Error("Postgres is also down")),
      });

      await expect(runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps)).rejects.toThrow(
        boom,
      );
    });

    it("never marks a job FAILED for a normal fetch/verification failure - FAILED_TO_VERIFY stays a COMPLETED-job outcome", async () => {
      const deps = makeDeps({
        extractor: {
          extract: vi.fn().mockResolvedValue(
            extractionResult({ httpStatus: 403, errorMessage: "Unexpected HTTP status 403", normalizedContent: "" }),
          ),
        },
      });

      const result = await runMonitoringJob({ organizationId: "org-1", monitoredUrlId: "url-1" }, deps);

      expect(result.verificationState).toBe("FAILED_TO_VERIFY");
      expect(deps.markMonitoringJobFailed).not.toHaveBeenCalled();
      expect(deps.persistMonitoringResult).toHaveBeenCalledTimes(1);
    });
  });
});
