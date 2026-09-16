import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRequireSession = vi.fn();
const mockGetDecryptedAiConnectionForOrg = vi.fn();
const mockTestAiConnection = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return { ...actual, getDecryptedAiConnectionForOrg: (...args: unknown[]) => mockGetDecryptedAiConnectionForOrg(...args) };
});

vi.mock("@cma/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/ai")>();
  return { ...actual, testAiConnection: (...args: unknown[]) => mockTestAiConnection(...args) };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { POST } = await import("./route.js");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/ai-connections/[id]/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("tests an existing connection scoped to the caller's organization, and never returns the decrypted key", async () => {
    mockGetDecryptedAiConnectionForOrg.mockResolvedValue({ provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: "sk-real-secret" });
    mockTestAiConnection.mockResolvedValue({ status: "SUCCESS", message: "Connection successful." });

    const response = await POST(new Request("http://test/ai-connections/conn-1/test", { method: "POST" }), makeParams("conn-1"));

    expect(mockGetDecryptedAiConnectionForOrg).toHaveBeenCalledWith("org-1", "conn-1");
    expect(mockTestAiConnection).toHaveBeenCalledWith({ provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: "sk-real-secret" });
    const bodyText = await response.text();
    expect(bodyText).not.toContain("sk-real-secret");
  });

  it("tenant isolation: 404s for a connection outside the caller's organization", async () => {
    const { NotFoundError } = await import("@cma/db");
    mockGetDecryptedAiConnectionForOrg.mockRejectedValue(new NotFoundError("AiConnection"));
    const response = await POST(new Request("http://test/ai-connections/foreign/test", { method: "POST" }), makeParams("foreign"));
    expect(response.status).toBe(404);
    expect(mockTestAiConnection).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const response = await POST(new Request("http://test/ai-connections/conn-1/test", { method: "POST" }), makeParams("conn-1"));
    expect(response.status).toBe(401);
    expect(mockGetDecryptedAiConnectionForOrg).not.toHaveBeenCalled();
  });
});
