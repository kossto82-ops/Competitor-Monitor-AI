import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetMonitoredUrlForOrg = vi.fn();
const mockCreatePendingMonitoringJob = vi.fn();
const mockMarkMonitoringJobFailed = vi.fn();
const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  // Keeps the real NotFoundError class (toErrorResponse does `err
  // instanceof NotFoundError`, which would crash on `undefined` if this
  // mock didn't re-export it) while stubbing only the functions this
  // route actually calls.
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getMonitoredUrlForOrg: (...args: unknown[]) => mockGetMonitoredUrlForOrg(...args),
    createPendingMonitoringJob: (...args: unknown[]) => mockCreatePendingMonitoringJob(...args),
    markMonitoringJobFailed: (...args: unknown[]) => mockMarkMonitoringJobFailed(...args),
  };
});

vi.mock("@cma/queue", () => ({
  createMonitoringQueue: () => ({ add: mockQueueAdd, close: mockQueueClose }),
}));

vi.mock("@/lib/currentSession", async (importOriginal) => {
  // Keeps the real UnauthorizedError class for the same reason as
  // @cma/db's NotFoundError above - toErrorResponse does `instanceof`
  // checks against it.
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

// Imported after the mocks above so the route picks up the mocked modules.
const { POST } = await import("./route.js");

function makeParams(urlId: string) {
  return { params: Promise.resolve({ urlId }) };
}

describe("POST /api/monitored-urls/[urlId]/scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
    mockGetMonitoredUrlForOrg.mockResolvedValue({ id: "url-1", organizationId: "org-1", url: "https://x.test" });
    mockCreatePendingMonitoringJob.mockResolvedValue({ id: "pending-job-1", status: "PENDING" });
    mockMarkMonitoringJobFailed.mockResolvedValue({ id: "pending-job-1", status: "FAILED" });
    mockQueueClose.mockResolvedValue(undefined);
  });

  it("creates a PENDING job and returns 202 with its id when enqueue succeeds", async () => {
    mockQueueAdd.mockResolvedValue({ id: "pending-job-1" });

    const response = await POST(new Request("http://test/scan", { method: "POST" }), makeParams("url-1"));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ monitoringJobId: "pending-job-1", queuedJobId: "pending-job-1" });
    expect(mockMarkMonitoringJobFailed).not.toHaveBeenCalled();
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });

  it("marks the PENDING job FAILED (not orphaned) when queue.add() throws, and returns a 500", async () => {
    const enqueueError = new Error("connect ECONNREFUSED 127.0.0.1:6379");
    mockQueueAdd.mockRejectedValue(enqueueError);

    const response = await POST(new Request("http://test/scan", { method: "POST" }), makeParams("url-1"));

    expect(response.status).toBe(500);
    expect(mockMarkMonitoringJobFailed).toHaveBeenCalledWith("pending-job-1", enqueueError.message);
    // The queue connection is still closed even though add() failed.
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });

  it("still returns the enqueue error response (not swallowed) when marking the job FAILED also fails", async () => {
    mockQueueAdd.mockRejectedValue(new Error("redis down"));
    mockMarkMonitoringJobFailed.mockRejectedValue(new Error("postgres also down"));

    const response = await POST(new Request("http://test/scan", { method: "POST" }), makeParams("url-1"));

    expect(response.status).toBe(500);
  });

  it("never creates a PENDING job (and never enqueues) for a URL outside the caller's organization", async () => {
    const { NotFoundError } = await import("@cma/db");
    mockGetMonitoredUrlForOrg.mockRejectedValue(new NotFoundError("MonitoredUrl not found"));

    const response = await POST(new Request("http://test/scan", { method: "POST" }), makeParams("foreign-url"));

    expect(response.status).toBe(404);
    expect(mockCreatePendingMonitoringJob).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
