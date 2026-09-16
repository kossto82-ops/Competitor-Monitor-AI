import { describe, expect, it, vi, beforeEach } from "vitest";

const mockListReportsForOrg = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return { ...actual, listReportsForOrg: (...args: unknown[]) => mockListReportsForOrg(...args) };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET } = await import("./route.js");

describe("/api/reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("GET returns reports scoped to the caller's organization only", async () => {
    mockListReportsForOrg.mockResolvedValue([{ id: "report-1" }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockListReportsForOrg).toHaveBeenCalledWith("org-1");
    const body = await response.json();
    expect(body.reports).toEqual([{ id: "report-1" }]);
  });

  it("GET 401s when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mockListReportsForOrg).not.toHaveBeenCalled();
  });
});
