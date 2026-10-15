import { describe, expect, it, vi, beforeEach } from "vitest";
import { NotFoundError } from "@cma/db";

const mockRequireSession = vi.fn();
const mockSetAlertStatus = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return { ...actual, setAlertStatus: (...args: unknown[]) => mockSetAlertStatus(...args) };
});

vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { PATCH } = await import("./route.js");

const params = (alertId: string) => ({ params: Promise.resolve({ alertId }) });
const patch = (body: unknown) => new Request("http://test", { method: "PATCH", body: JSON.stringify(body) });

describe("/api/alerts/[alertId] (Phase 29 D5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
  });

  it("marks an alert as seen, always scoped to the session's organization", async () => {
    mockSetAlertStatus.mockResolvedValue(undefined);
    const response = await PATCH(patch({ status: "ACKNOWLEDGED" }), params("a1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "ACKNOWLEDGED" });
    expect(mockSetAlertStatus).toHaveBeenCalledWith("org-1", "a1", "ACKNOWLEDGED");
  });

  it("dismisses an alert", async () => {
    mockSetAlertStatus.mockResolvedValue(undefined);
    expect((await PATCH(patch({ status: "DISMISSED" }), params("a1"))).status).toBe(200);
    expect(mockSetAlertStatus).toHaveBeenCalledWith("org-1", "a1", "DISMISSED");
  });

  it("does not let a caller reopen an alert or invent a status", async () => {
    for (const status of ["OPEN", "RESOLVED", ""]) {
      expect((await PATCH(patch({ status }), params("a1"))).status).toBe(400);
    }
    expect((await PATCH(patch({}), params("a1"))).status).toBe(400);
    expect(mockSetAlertStatus).not.toHaveBeenCalled();
  });

  it("404s for an alert that is not in the caller's organization", async () => {
    mockSetAlertStatus.mockRejectedValue(new NotFoundError("Alert"));
    expect((await PATCH(patch({ status: "DISMISSED" }), params("someone-elses"))).status).toBe(404);
  });

  it("401s without a session and touches nothing", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    expect((await PATCH(patch({ status: "DISMISSED" }), params("a1"))).status).toBe(401);
    expect(mockSetAlertStatus).not.toHaveBeenCalled();
  });
});
