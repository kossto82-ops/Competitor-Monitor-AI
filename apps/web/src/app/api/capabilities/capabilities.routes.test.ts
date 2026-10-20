import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRequireSession = vi.fn();
const mockCreateCustom = vi.fn();
const mockDeleteCustom = vi.fn();
const mockCreateRun = vi.fn();
const mockMarkFailed = vi.fn();
const mockAddJob = vi.fn();
const mockCheckLimit = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    createCustomCapability: (...a: unknown[]) => mockCreateCustom(...a),
    deleteCustomCapability: (...a: unknown[]) => mockDeleteCustom(...a),
    createCapabilityAiRun: (...a: unknown[]) => mockCreateRun(...a),
    markCapabilityAiRunFailed: (...a: unknown[]) => mockMarkFailed(...a),
  };
});
vi.mock("@cma/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/queue")>();
  return { ...actual, createCapabilityAiQueue: () => ({ close: async () => undefined }), addJobReplacingTerminal: (...a: unknown[]) => mockAddJob(...a) };
});
vi.mock("@/lib/limitResponse", () => ({ checkLimit: (...a: unknown[]) => mockCheckLimit(...a) }));
vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const custom = await import("./custom/route.js");
const customOne = await import("./custom/[id]/route.js");
const aiCheck = await import("./ai-check/route.js");

const post = (body: unknown) => new Request("http://test", { method: "POST", body: JSON.stringify(body) });
const valid = { label: "Answers in Catalan", description: "Takes calls in Catalan", phrases: ["en catalán"] };
const as = (role: string) => mockRequireSession.mockResolvedValue({ userId: "u1", organizationId: "org-1", role });

describe("/api/capabilities (Phase 29 F3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    as("OWNER");
    mockCheckLimit.mockResolvedValue(null);
  });

  it("lets an admin define a capability of the organization's own, scoped to its organization", async () => {
    as("ADMIN");
    mockCreateCustom.mockResolvedValue({ id: "c1", ...valid });
    const response = await custom.POST(post(valid));
    expect(response.status).toBe(201);
    expect(mockCreateCustom).toHaveBeenCalledWith("org-1", valid);
  });

  it("does not let a member change what the organization looks for, and rejects invalid input", async () => {
    as("MEMBER");
    expect((await custom.POST(post(valid))).status).toBe(403);
    expect((await customOne.DELETE(post({}), { params: Promise.resolve({ id: "c1" }) })).status).toBe(403);
    expect(mockCreateCustom).not.toHaveBeenCalled();
    expect(mockDeleteCustom).not.toHaveBeenCalled();
    as("OWNER");
    expect((await custom.POST(post({ label: "x", description: "y", phrases: [] }))).status).toBe(400);
    expect((await custom.POST(post({ ...valid, phrases: ["ab"] }))).status).toBe(400);
  });

  it("starts one AI check for any member who runs scans, and enqueues it under the run's id", async () => {
    as("MEMBER");
    mockCreateRun.mockResolvedValue({ run: { id: "run-1", status: "PENDING" }, created: true });
    const response = await aiCheck.POST();
    expect(response.status).toBe(202);
    expect(mockCreateRun).toHaveBeenCalledWith("org-1");
    expect(mockAddJob).toHaveBeenCalledWith(expect.anything(), "classify", { organizationId: "org-1", capabilityAiRunId: "run-1" }, "run-1");
  });

  it("returns the check already in flight instead of starting a second paid one", async () => {
    mockCreateRun.mockResolvedValue({ run: { id: "run-1", status: "RUNNING" }, created: false });
    const response = await aiCheck.POST();
    expect(response.status).toBe(200);
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it("refuses over the daily limit before creating any run", async () => {
    const { NextResponse } = await import("next/server");
    mockCheckLimit.mockResolvedValue(NextResponse.json({ error: "limit" }, { status: 429 }));
    expect((await aiCheck.POST()).status).toBe(429);
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("does not leave a job-less run pending when the job cannot be queued", async () => {
    mockCreateRun.mockResolvedValue({ run: { id: "run-2", status: "PENDING" }, created: true });
    mockAddJob.mockRejectedValue(new Error("redis down"));
    mockMarkFailed.mockResolvedValue(undefined);
    expect((await aiCheck.POST()).status).toBe(500);
    expect(mockMarkFailed).toHaveBeenCalledWith("run-2", "redis down");
  });
});
