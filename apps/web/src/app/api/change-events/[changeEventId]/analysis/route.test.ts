import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetChangeEventForOrg = vi.fn();
const mockGetOrCreatePendingAiAnalysis = vi.fn();
const mockGetAiAnalysisForChangeEvent = vi.fn();
const mockMarkAiAnalysisFailed = vi.fn();
const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getChangeEventForOrg: (...args: unknown[]) => mockGetChangeEventForOrg(...args),
    getOrCreatePendingAiAnalysis: (...args: unknown[]) => mockGetOrCreatePendingAiAnalysis(...args),
    getAiAnalysisForChangeEvent: (...args: unknown[]) => mockGetAiAnalysisForChangeEvent(...args),
    markAiAnalysisFailed: (...args: unknown[]) => mockMarkAiAnalysisFailed(...args),
  };
});

vi.mock("@cma/queue", () => ({
  createAiAnalysisQueue: () => ({ add: mockQueueAdd, close: mockQueueClose }),
}));

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET, POST } = await import("./route.js");

function makeParams(changeEventId: string) {
  return { params: Promise.resolve({ changeEventId }) };
}

function makeChangeEvent(overrides: Record<string, unknown> = {}) {
  return { id: "change-1", organizationId: "org-1", changeType: "PRICE_CHANGE", ...overrides };
}

describe("/api/change-events/[changeEventId]/analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
    mockGetChangeEventForOrg.mockResolvedValue(makeChangeEvent());
    mockGetOrCreatePendingAiAnalysis.mockResolvedValue({ id: "analysis-1", status: "PENDING" });
    mockMarkAiAnalysisFailed.mockResolvedValue(undefined);
    mockQueueClose.mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns the analysis for a ChangeEvent belonging to the caller's org", async () => {
      mockGetAiAnalysisForChangeEvent.mockResolvedValue({ id: "analysis-1", status: "COMPLETED" });
      const response = await GET(new Request("http://test/analysis"), makeParams("change-1"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.analysis).toEqual({ id: "analysis-1", status: "COMPLETED" });
    });

    it("returns null (not an error) when no analysis has been triggered yet", async () => {
      mockGetAiAnalysisForChangeEvent.mockResolvedValue(null);
      const response = await GET(new Request("http://test/analysis"), makeParams("change-1"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.analysis).toBeNull();
    });

    it("404s for a ChangeEvent outside the caller's organization (Section 13: tenant isolation)", async () => {
      mockGetChangeEventForOrg.mockResolvedValue(null);
      const response = await GET(new Request("http://test/analysis"), makeParams("foreign-change"));
      expect(response.status).toBe(404);
      expect(mockGetAiAnalysisForChangeEvent).not.toHaveBeenCalled();
    });
  });

  describe("POST", () => {
    it("creates a PENDING analysis, enqueues it, and returns 202", async () => {
      mockQueueAdd.mockResolvedValue({ id: "analysis-1" });
      const response = await POST(new Request("http://test/analysis", { method: "POST" }), makeParams("change-1"));
      expect(response.status).toBe(202);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "analyze",
        { organizationId: "org-1", changeEventId: "change-1", aiAnalysisId: "analysis-1" },
        { jobId: "analysis-1" },
      );
    });

    it("returns 422 and never creates a row for a changeType with no AI analysis context (Section 2 & 4/5)", async () => {
      mockGetChangeEventForOrg.mockResolvedValue(makeChangeEvent({ changeType: "PROMOTION_CHANGE" }));
      const response = await POST(new Request("http://test/analysis", { method: "POST" }), makeParams("change-1"));
      expect(response.status).toBe(422);
      expect(mockGetOrCreatePendingAiAnalysis).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("is idempotent - does not re-enqueue when an analysis is already COMPLETED (Section 10)", async () => {
      mockGetOrCreatePendingAiAnalysis.mockResolvedValue({ id: "analysis-1", status: "COMPLETED" });
      const response = await POST(new Request("http://test/analysis", { method: "POST" }), makeParams("change-1"));
      expect(response.status).toBe(200);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("is idempotent - does not re-enqueue when an analysis is already RUNNING", async () => {
      mockGetOrCreatePendingAiAnalysis.mockResolvedValue({ id: "analysis-1", status: "RUNNING" });
      const response = await POST(new Request("http://test/analysis", { method: "POST" }), makeParams("change-1"));
      expect(response.status).toBe(200);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("re-enqueues a fresh job when the previous analysis FAILED", async () => {
      mockGetOrCreatePendingAiAnalysis.mockResolvedValue({ id: "analysis-1", status: "FAILED" });
      mockQueueAdd.mockResolvedValue({ id: "analysis-1" });
      const response = await POST(new Request("http://test/analysis", { method: "POST" }), makeParams("change-1"));
      expect(response.status).toBe(202);
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });

    it("marks the PENDING row FAILED (not orphaned) when queue.add() throws (mirrors the scan route's Bug #1 fix)", async () => {
      const enqueueError = new Error("connect ECONNREFUSED 127.0.0.1:6379");
      mockQueueAdd.mockRejectedValue(enqueueError);
      const response = await POST(new Request("http://test/analysis", { method: "POST" }), makeParams("change-1"));
      expect(response.status).toBe(500);
      expect(mockMarkAiAnalysisFailed).toHaveBeenCalledWith("analysis-1", enqueueError.message);
    });

    it("404s for a ChangeEvent outside the caller's organization before ever creating an AiAnalysis row", async () => {
      mockGetChangeEventForOrg.mockResolvedValue(null);
      const response = await POST(new Request("http://test/analysis", { method: "POST" }), makeParams("foreign-change"));
      expect(response.status).toBe(404);
      expect(mockGetOrCreatePendingAiAnalysis).not.toHaveBeenCalled();
    });
  });
});
