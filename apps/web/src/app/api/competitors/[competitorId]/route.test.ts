import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRequireSession = vi.fn();
const mockGetCompetitorForOrg = vi.fn();
const mockListMonitoredUrlsWithStatusForOrg = vi.fn();
const mockUpdateCompetitor = vi.fn();
const mockDeleteCompetitorIfSafe = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getCompetitorForOrg: (...args: unknown[]) => mockGetCompetitorForOrg(...args),
    listMonitoredUrlsWithStatusForOrg: (...args: unknown[]) => mockListMonitoredUrlsWithStatusForOrg(...args),
    updateCompetitor: (...args: unknown[]) => mockUpdateCompetitor(...args),
    deleteCompetitorIfSafe: (...args: unknown[]) => mockDeleteCompetitorIfSafe(...args),
  };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET, PATCH, DELETE } = await import("./route.js");

function makeParams(competitorId: string) {
  return { params: Promise.resolve({ competitorId }) };
}

describe("/api/competitors/[competitorId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("GET returns the competitor + monitored URLs scoped to the caller's org", async () => {
    mockGetCompetitorForOrg.mockResolvedValue({ id: "c1" });
    mockListMonitoredUrlsWithStatusForOrg.mockResolvedValue([]);
    const response = await GET(new Request("http://test"), makeParams("c1"));
    expect(response.status).toBe(200);
    expect(mockGetCompetitorForOrg).toHaveBeenCalledWith("org-1", "c1");
  });

  it("PATCH updates the competitor scoped to the caller's org", async () => {
    mockUpdateCompetitor.mockResolvedValue({ id: "c1", name: "New Name" });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ name: "New Name" }) }), makeParams("c1"));
    expect(response.status).toBe(200);
    expect(mockUpdateCompetitor).toHaveBeenCalledWith("org-1", "c1", { name: "New Name" });
  });

  it("PATCH deactivates via isActive:false", async () => {
    mockUpdateCompetitor.mockResolvedValue({ id: "c1", isActive: false });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ isActive: false }) }), makeParams("c1"));
    expect(response.status).toBe(200);
    expect(mockUpdateCompetitor).toHaveBeenCalledWith("org-1", "c1", { isActive: false });
  });

  it("PATCH 404s for a competitor outside the caller's org", async () => {
    const { NotFoundError } = await import("@cma/db");
    mockUpdateCompetitor.mockRejectedValue(new NotFoundError("Competitor"));
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ name: "x" }) }), makeParams("foreign"));
    expect(response.status).toBe(404);
  });

  it("DELETE removes a safe-to-delete competitor", async () => {
    mockDeleteCompetitorIfSafe.mockResolvedValue(undefined);
    const response = await DELETE(new Request("http://test", { method: "DELETE" }), makeParams("c1"));
    expect(response.status).toBe(204);
  });

  it("DELETE returns 409 when the competitor has monitoring history", async () => {
    const { ConflictError } = await import("@cma/db");
    mockDeleteCompetitorIfSafe.mockRejectedValue(new ConflictError("This competitor has monitored URLs and history - deactivate it instead of deleting it."));
    const response = await DELETE(new Request("http://test", { method: "DELETE" }), makeParams("c1"));
    expect(response.status).toBe(409);
  });

  it("401s when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ name: "x" }) }), makeParams("c1"));
    expect(response.status).toBe(401);
    expect(mockUpdateCompetitor).not.toHaveBeenCalled();
  });
});
