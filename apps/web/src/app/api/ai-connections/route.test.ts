import { describe, expect, it, vi, beforeEach } from "vitest";

const mockCreateAiConnection = vi.fn();
const mockListAiConnectionsForOrg = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    createAiConnection: (...args: unknown[]) => mockCreateAiConnection(...args),
    listAiConnectionsForOrg: (...args: unknown[]) => mockListAiConnectionsForOrg(...args),
  };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET, POST } = await import("./route.js");

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

describe("/api/ai-connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  describe("GET", () => {
    it("lists the caller's organization's connections without ever including a key", async () => {
      mockListAiConnectionsForOrg.mockResolvedValue([safeConnection()]);
      const response = await GET();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connections).toHaveLength(1);
      // "hasApiKey" (the masked indicator) is expected and fine - only a
      // literal apiKey/encryptedApiKey field name must never appear.
      expect(JSON.stringify(body)).not.toMatch(/"(encryptedApiKey|apiKey)":/i);
      expect(mockListAiConnectionsForOrg).toHaveBeenCalledWith("org-1");
    });
  });

  describe("POST", () => {
    it("creates an openai connection", async () => {
      mockCreateAiConnection.mockResolvedValue(safeConnection());
      const response = await POST(
        new Request("http://test/ai-connections", {
          method: "POST",
          body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-test" }),
        }),
      );
      expect(response.status).toBe(201);
      expect(mockCreateAiConnection).toHaveBeenCalledWith("org-1", { provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-test" });
    });

    it("requires a baseUrl for provider='openai-compatible'", async () => {
      const response = await POST(
        new Request("http://test/ai-connections", {
          method: "POST",
          body: JSON.stringify({ provider: "openai-compatible", model: "custom", apiKey: "sk-test" }),
        }),
      );
      expect(response.status).toBe(400);
      expect(mockCreateAiConnection).not.toHaveBeenCalled();
    });

    it("rejects an unrecognized provider value", async () => {
      const response = await POST(
        new Request("http://test/ai-connections", {
          method: "POST",
          body: JSON.stringify({ provider: "anthropic", model: "claude", apiKey: "sk-test" }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("never echoes the submitted apiKey back in the response beyond what the repository returns", async () => {
      mockCreateAiConnection.mockResolvedValue(safeConnection());
      const response = await POST(
        new Request("http://test/ai-connections", {
          method: "POST",
          body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", apiKey: "sk-must-not-appear" }),
        }),
      );
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("sk-must-not-appear");
    });
  });
});
