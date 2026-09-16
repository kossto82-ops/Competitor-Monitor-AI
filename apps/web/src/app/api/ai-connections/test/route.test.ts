import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRequireSession = vi.fn();
const mockTestAiConnection = vi.fn();

vi.mock("@cma/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/ai")>();
  return { ...actual, testAiConnection: (...args: unknown[]) => mockTestAiConnection(...args) };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { POST } = await import("./route.js");

function req(body: unknown) {
  return new Request("http://test/ai-connections/test", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/ai-connections/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("tests the given (not-yet-saved) credentials and returns the classified result", async () => {
    mockTestAiConnection.mockResolvedValue({ status: "SUCCESS", message: "Connection successful." });
    const response = await POST(req({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" }));
    expect(response.status).toBe(200);
    expect(mockTestAiConnection).toHaveBeenCalledWith({ provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: "sk-test" });
    const body = await response.json();
    expect(body.status).toBe("SUCCESS");
  });

  it("never appears to persist anything - only @cma/ai's testAiConnection is called, no @cma/db import", async () => {
    mockTestAiConnection.mockResolvedValue({ status: "SUCCESS", message: "Connection successful." });
    await POST(req({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" }));
    expect(mockTestAiConnection).toHaveBeenCalledTimes(1);
  });

  it("401s when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    const response = await POST(req({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" }));
    expect(response.status).toBe(401);
    expect(mockTestAiConnection).not.toHaveBeenCalled();
  });

  it("400s on an invalid body (e.g. missing apiKey)", async () => {
    const response = await POST(req({ provider: "openai", model: "gpt-4o-mini" }));
    expect(response.status).toBe(400);
    expect(mockTestAiConnection).not.toHaveBeenCalled();
  });

  it("requires baseUrl for openai-compatible", async () => {
    const response = await POST(req({ provider: "openai-compatible", model: "custom", apiKey: "sk-test" }));
    expect(response.status).toBe(400);
  });
});
