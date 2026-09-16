import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetDigestAiInterpretationForOrg = vi.fn();
const mockGetOrCreateDigestAiInterpretationSlot = vi.fn();
const mockMarkDigestAiInterpretationFailed = vi.fn();
const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getDigestAiInterpretationForOrg: (...args: unknown[]) => mockGetDigestAiInterpretationForOrg(...args),
    getOrCreateDigestAiInterpretationSlot: (...args: unknown[]) => mockGetOrCreateDigestAiInterpretationSlot(...args),
    markDigestAiInterpretationFailed: (...args: unknown[]) => mockMarkDigestAiInterpretationFailed(...args),
  };
});

vi.mock("@cma/queue", () => ({
  createDigestInterpretationQueue: () => ({ add: mockQueueAdd, close: mockQueueClose }),
}));

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET, POST } = await import("./route.js");

describe("/api/digest/interpretation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
    mockGetOrCreateDigestAiInterpretationSlot.mockResolvedValue({ id: "interp-1", status: "PENDING" });
    mockMarkDigestAiInterpretationFailed.mockResolvedValue(undefined);
    mockQueueClose.mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns the interpretation for the caller's org and the requested period", async () => {
      mockGetDigestAiInterpretationForOrg.mockResolvedValue({ id: "interp-1", status: "COMPLETED" });
      const response = await GET(new Request("http://test/interpretation?days=30"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.interpretation).toEqual({ id: "interp-1", status: "COMPLETED" });
      expect(mockGetDigestAiInterpretationForOrg).toHaveBeenCalledWith("org-1", 30);
    });

    it("returns null (not an error) when no interpretation has been triggered yet", async () => {
      mockGetDigestAiInterpretationForOrg.mockResolvedValue(null);
      const response = await GET(new Request("http://test/interpretation?days=7"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.interpretation).toBeNull();
    });

    it("400s on an invalid days value - never falls back to a silent default", async () => {
      const response = await GET(new Request("http://test/interpretation?days=45"));
      expect(response.status).toBe(400);
      expect(mockGetDigestAiInterpretationForOrg).not.toHaveBeenCalled();
    });
  });

  describe("POST", () => {
    it("creates a PENDING slot, enqueues exactly one job, and returns 202", async () => {
      mockQueueAdd.mockResolvedValue({ id: "interp-1" });
      const response = await POST(new Request("http://test/interpretation?days=30", { method: "POST" }));
      expect(response.status).toBe(202);
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "interpret",
        { organizationId: "org-1", days: 30, digestAiInterpretationId: "interp-1" },
        { jobId: "interp-1" },
      );
    });

    it("does not re-enqueue when a job is already RUNNING (never a duplicate in-flight interpretation)", async () => {
      mockGetOrCreateDigestAiInterpretationSlot.mockResolvedValue({ id: "interp-1", status: "RUNNING" });
      const response = await POST(new Request("http://test/interpretation?days=30", { method: "POST" }));
      expect(response.status).toBe(200);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("enqueues exactly one fresh job when the slot was reset from COMPLETED/FAILED back to PENDING by the repository layer", async () => {
      // getOrCreateDigestAiInterpretationSlot itself performs the COMPLETED/FAILED -> PENDING
      // reset (tested at the repository level) - this route only ever enqueues when the
      // returned status is PENDING, regardless of what it was a moment ago.
      mockGetOrCreateDigestAiInterpretationSlot.mockResolvedValue({ id: "interp-1", status: "PENDING" });
      mockQueueAdd.mockResolvedValue({ id: "interp-1" });
      const response = await POST(new Request("http://test/interpretation?days=30", { method: "POST" }));
      expect(response.status).toBe(202);
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });

    it("marks the slot FAILED (not orphaned) when queue.add() throws", async () => {
      const enqueueError = new Error("connect ECONNREFUSED 127.0.0.1:6379");
      mockQueueAdd.mockRejectedValue(enqueueError);
      const response = await POST(new Request("http://test/interpretation?days=30", { method: "POST" }));
      expect(response.status).toBe(500);
      expect(mockMarkDigestAiInterpretationFailed).toHaveBeenCalledWith("interp-1", enqueueError.message);
    });

    it("400s on an invalid days value before ever creating a slot", async () => {
      const response = await POST(new Request("http://test/interpretation?days=15", { method: "POST" }));
      expect(response.status).toBe(400);
      expect(mockGetOrCreateDigestAiInterpretationSlot).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("401s when there is no session", async () => {
      const { UnauthorizedError } = await import("@/lib/currentSession");
      mockRequireSession.mockRejectedValue(new UnauthorizedError());
      const response = await POST(new Request("http://test/interpretation?days=30", { method: "POST" }));
      expect(response.status).toBe(401);
      expect(mockGetOrCreateDigestAiInterpretationSlot).not.toHaveBeenCalled();
    });
  });
});
