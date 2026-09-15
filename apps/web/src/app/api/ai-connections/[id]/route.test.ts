import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetAiConnectionForOrg = vi.fn();
const mockUpdateAiConnection = vi.fn();
const mockDeleteAiConnection = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getAiConnectionForOrg: (...args: unknown[]) => mockGetAiConnectionForOrg(...args),
    updateAiConnection: (...args: unknown[]) => mockUpdateAiConnection(...args),
    deleteAiConnection: (...args: unknown[]) => mockDeleteAiConnection(...args),
  };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET, PATCH, DELETE } = await import("./route.js");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function safeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    organizationId: "org-1",
    provider: "openai",
    model: "gpt-5.6-luna",
    baseUrl: null,
    enabled: true,
    hasApiKey: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("/api/ai-connections/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("GET returns the connection scoped to the caller's organization", async () => {
    mockGetAiConnectionForOrg.mockResolvedValue(safeConnection());
    const response = await GET(new Request("http://test/ai-connections/conn-1"), makeParams("conn-1"));
    expect(response.status).toBe(200);
    expect(mockGetAiConnectionForOrg).toHaveBeenCalledWith("org-1", "conn-1");
  });

  it("GET 404s for a connection outside the caller's organization (tenant isolation)", async () => {
    const { NotFoundError } = await import("@cma/db");
    mockGetAiConnectionForOrg.mockRejectedValue(new NotFoundError("AiConnection"));
    const response = await GET(new Request("http://test/ai-connections/foreign"), makeParams("foreign"));
    expect(response.status).toBe(404);
  });

  it("PATCH can disable a connection", async () => {
    mockUpdateAiConnection.mockResolvedValue(safeConnection({ enabled: false }));
    const response = await PATCH(
      new Request("http://test/ai-connections/conn-1", { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      makeParams("conn-1"),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateAiConnection).toHaveBeenCalledWith("org-1", "conn-1", { enabled: false });
    const body = await response.json();
    expect(body.connection.enabled).toBe(false);
  });

  it("PATCH 404s when updating a connection outside the caller's organization", async () => {
    const { NotFoundError } = await import("@cma/db");
    mockUpdateAiConnection.mockRejectedValue(new NotFoundError("AiConnection"));
    const response = await PATCH(
      new Request("http://test/ai-connections/foreign", { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      makeParams("foreign"),
    );
    expect(response.status).toBe(404);
  });

  it("DELETE removes the connection and returns 204", async () => {
    mockDeleteAiConnection.mockResolvedValue(undefined);
    const response = await DELETE(new Request("http://test/ai-connections/conn-1", { method: "DELETE" }), makeParams("conn-1"));
    expect(response.status).toBe(204);
    expect(mockDeleteAiConnection).toHaveBeenCalledWith("org-1", "conn-1");
  });

  it("DELETE 404s for a connection outside the caller's organization", async () => {
    const { NotFoundError } = await import("@cma/db");
    mockDeleteAiConnection.mockRejectedValue(new NotFoundError("AiConnection"));
    const response = await DELETE(new Request("http://test/ai-connections/foreign", { method: "DELETE" }), makeParams("foreign"));
    expect(response.status).toBe(404);
  });
});
