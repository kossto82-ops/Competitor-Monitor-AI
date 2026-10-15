import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockCookieValue = vi.fn<() => string | undefined>();
const mockRevokeUserSession = vi.fn();
const mockRevokeAllUserSessions = vi.fn();
const mockRequireSession = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "cma_session" && mockCookieValue() ? { name, value: mockCookieValue() } : undefined) }),
}));
vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    revokeUserSession: (...args: unknown[]) => mockRevokeUserSession(...args),
    revokeAllUserSessions: (...args: unknown[]) => mockRevokeAllUserSessions(...args),
  };
});
vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { createSessionToken } = await import("@/lib/session");
const { POST: logout } = await import("./logout/route");
const { POST: logoutAll } = await import("./logout-all/route");
const { GET: expired } = await import("./expired/route");

beforeAll(() => {
  process.env["AUTH_SECRET"] = "test-secret-at-least-32-characters-long!!";
});
beforeEach(() => {
  vi.clearAllMocks();
  mockCookieValue.mockReturnValue(undefined);
  mockRevokeUserSession.mockResolvedValue(undefined);
});

const clearedCookie = (response: Response) => response.headers.get("set-cookie") ?? "";

describe("POST /api/auth/logout (Phase 29 D5c, E16)", () => {
  it("ends the session on the server, not only in the browser, and clears the cookie with its own attributes", async () => {
    mockCookieValue.mockReturnValue(await createSessionToken({ userId: "u1", organizationId: "o1", sessionId: "sess-9" }));
    const response = await logout();
    expect(response.status).toBe(200);
    expect(mockRevokeUserSession).toHaveBeenCalledWith("sess-9");
    const cookie = clearedCookie(response);
    expect(cookie).toContain("cma_session=;");
    expect(cookie).toMatch(/Max-Age=0/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it("is harmless without a cookie, with a bad one, or when the database is down", async () => {
    expect((await logout()).status).toBe(200);
    mockCookieValue.mockReturnValue("not-a-token");
    expect((await logout()).status).toBe(200);
    mockCookieValue.mockReturnValue(await createSessionToken({ userId: "u1", organizationId: "o1", sessionId: "sess-9" }));
    mockRevokeUserSession.mockRejectedValue(new Error("db down"));
    const response = await logout();
    expect(response.status).toBe(200);
    expect(clearedCookie(response)).toMatch(/Max-Age=0/i);
  });
});

describe("POST /api/auth/logout-all", () => {
  it("ends every other session of the signed-in user and keeps the current one", async () => {
    mockRequireSession.mockResolvedValue({ userId: "u1", organizationId: "o1", sessionId: "sess-1", role: "OWNER" });
    mockRevokeAllUserSessions.mockResolvedValue(3);
    const response = await logoutAll();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ended: 3 });
    expect(mockRevokeAllUserSessions).toHaveBeenCalledWith("u1", { exceptSessionId: "sess-1" });
  });

  it("401s without a session and revokes nothing", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    expect((await logoutAll()).status).toBe(401);
    expect(mockRevokeAllUserSessions).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/expired", () => {
  it("clears the cookie and sends the visitor to the login page", async () => {
    const response = await expired(new Request("http://localhost:3100/api/auth/expired"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3100/login");
    expect(clearedCookie(response)).toMatch(/Max-Age=0/i);
  });
});
