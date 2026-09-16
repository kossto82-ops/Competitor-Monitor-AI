import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRequireSession = vi.fn();
const mockGetMonitoredUrlDetailForOrg = vi.fn();
const mockUpdateMonitoredUrl = vi.fn();
const mockDeleteMonitoredUrlIfSafe = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getMonitoredUrlDetailForOrg: (...args: unknown[]) => mockGetMonitoredUrlDetailForOrg(...args),
    updateMonitoredUrl: (...args: unknown[]) => mockUpdateMonitoredUrl(...args),
    deleteMonitoredUrlIfSafe: (...args: unknown[]) => mockDeleteMonitoredUrlIfSafe(...args),
  };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET, PATCH, DELETE } = await import("./route.js");

function makeParams(urlId: string) {
  return { params: Promise.resolve({ urlId }) };
}

describe("/api/monitored-urls/[urlId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("GET returns the monitored URL scoped to the caller's org", async () => {
    mockGetMonitoredUrlDetailForOrg.mockResolvedValue({ id: "u1" });
    const response = await GET(new Request("http://test"), makeParams("u1"));
    expect(response.status).toBe(200);
    expect(mockGetMonitoredUrlDetailForOrg).toHaveBeenCalledWith("org-1", "u1");
  });

  it("PATCH pauses via isActive:false", async () => {
    mockUpdateMonitoredUrl.mockResolvedValue({ id: "u1", isActive: false });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ isActive: false }) }), makeParams("u1"));
    expect(response.status).toBe(200);
    expect(mockUpdateMonitoredUrl).toHaveBeenCalledWith("org-1", "u1", { isActive: false });
  });

  it("PATCH updates scanFrequencyMinutes", async () => {
    mockUpdateMonitoredUrl.mockResolvedValue({ id: "u1", scanFrequencyMinutes: 60 });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ scanFrequencyMinutes: 60 }) }), makeParams("u1"));
    expect(response.status).toBe(200);
  });

  it("PATCH 400s on an out-of-range scanFrequencyMinutes", async () => {
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ scanFrequencyMinutes: 1 }) }), makeParams("u1"));
    expect(response.status).toBe(400);
    expect(mockUpdateMonitoredUrl).not.toHaveBeenCalled();
  });

  it("DELETE returns 409 when the URL has monitoring history", async () => {
    const { ConflictError } = await import("@cma/db");
    mockDeleteMonitoredUrlIfSafe.mockRejectedValue(new ConflictError("This URL has monitoring history - pause it instead of deleting it."));
    const response = await DELETE(new Request("http://test", { method: "DELETE" }), makeParams("u1"));
    expect(response.status).toBe(409);
  });

  it("401s when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ isActive: false }) }), makeParams("u1"));
    expect(response.status).toBe(401);
    expect(mockUpdateMonitoredUrl).not.toHaveBeenCalled();
  });
});
