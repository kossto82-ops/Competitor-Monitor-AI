import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 29 D5d (E33): every route that changes credentials, settings or the product's configuration refuses a
 * plain member with a 403, before it reads the body or touches the database. Listing them here makes a new
 * route without a permission check show up as a gap in this table.
 */
const mockRequireSession = vi.fn();
const dbCalls = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  // Anything that reaches the database from a route here is a failure of the check, so record it.
  return new Proxy(actual, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && !/Error$/.test(String(prop)) && !/^(prisma|Prisma)/.test(String(prop))) {
        return (...args: unknown[]) => {
          dbCalls(String(prop));
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      }
      return value;
    },
  });
});
vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const params = Promise.resolve({ id: "x", urlId: "x", competitorId: "x", changeEventId: "x" });
const request = (method: string) => new Request("http://test/api", { method, body: method === "GET" ? undefined : "{}", headers: { "content-type": "application/json" } });

const ADMIN_ONLY: [string, string, () => Promise<Record<string, unknown>>][] = [
  ["POST /api/ai-connections", "POST", () => import("./ai-connections/route")],
  ["PATCH /api/ai-connections/[id]", "PATCH", () => import("./ai-connections/[id]/route")],
  ["DELETE /api/ai-connections/[id]", "DELETE", () => import("./ai-connections/[id]/route")],
  ["POST /api/ai-connections/test", "POST", () => import("./ai-connections/test/route")],
  ["POST /api/ai-connections/[id]/test", "POST", () => import("./ai-connections/[id]/test/route")],
  ["GET /api/settings/smtp", "GET", () => import("./settings/smtp/route")],
  ["PUT /api/settings/smtp", "PUT", () => import("./settings/smtp/route")],
  ["DELETE /api/settings/smtp", "DELETE", () => import("./settings/smtp/route")],
  ["POST /api/settings/smtp/test", "POST", () => import("./settings/smtp/test/route")],
  ["PATCH /api/settings/organization", "PATCH", () => import("./settings/organization/route")],
];

describe("roles on the API (Phase 29 D5d, E33)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "u1", organizationId: "o1", sessionId: "s1", role: "MEMBER" });
  });

  it.each(ADMIN_ONLY)("%s: a member gets 403 and the database is never touched", async (_name, method, load) => {
    const handler = (await load())[method] as Handler;
    const response = await handler(request(method), { params });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(dbCalls).not.toHaveBeenCalled();
  });

  it("a member can still do the daily work: these routes get past the permission check", async () => {
    // With a role that may not do it the answer would be 403; here the request goes on (and stops at validation).
    const { POST } = await import("./competitors/route");
    mockRequireSession.mockResolvedValue({ userId: "u1", organizationId: "o1", sessionId: "s1", role: "MEMBER" });
    const response = await POST(new Request("http://test/api/competitors", { method: "POST", body: "not json", headers: { "content-type": "application/json" } }));
    expect(response.status).not.toBe(403);
  });

  it("an unknown or missing role is treated as no role at all", async () => {
    const { PATCH } = await import("./settings/organization/route");
    for (const role of [undefined, "", "OWNERISH"]) {
      mockRequireSession.mockResolvedValue({ userId: "u1", organizationId: "o1", sessionId: "s1", role });
      expect((await PATCH(request("PATCH"))).status).toBe(403);
    }
  });

  it("an admin and an owner pass the check on the same route", async () => {
    const { PATCH } = await import("./settings/organization/route");
    for (const role of ["ADMIN", "OWNER"]) {
      mockRequireSession.mockResolvedValue({ userId: "u1", organizationId: "o1", sessionId: "s1", role });
      const response = await PATCH(new Request("http://test/api", { method: "PATCH", body: "not json", headers: { "content-type": "application/json" } }));
      expect(response.status).not.toBe(403);
    }
  });
});
