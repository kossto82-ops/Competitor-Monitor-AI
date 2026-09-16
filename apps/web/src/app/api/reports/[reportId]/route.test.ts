import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetReportWithItemsForOrg = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return { ...actual, getReportWithItemsForOrg: (...args: unknown[]) => mockGetReportWithItemsForOrg(...args) };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET } = await import("./route.js");

function makeParams(reportId: string) {
  return { params: Promise.resolve({ reportId }) };
}

describe("/api/reports/[reportId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("GET returns the report scoped to the caller's organization", async () => {
    mockGetReportWithItemsForOrg.mockResolvedValue({ id: "report-1", items: [] });
    const response = await GET(new Request("http://test/reports/report-1"), makeParams("report-1"));
    expect(response.status).toBe(200);
    expect(mockGetReportWithItemsForOrg).toHaveBeenCalledWith("org-1", "report-1");
  });

  it("GET 404s for a report outside the caller's organization (tenant isolation)", async () => {
    const { NotFoundError } = await import("@cma/db");
    mockGetReportWithItemsForOrg.mockRejectedValue(new NotFoundError("Report"));
    const response = await GET(new Request("http://test/reports/foreign"), makeParams("foreign"));
    expect(response.status).toBe(404);
  });
});
