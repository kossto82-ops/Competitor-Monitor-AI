import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRequireSession = vi.fn();
const mockGet = vi.fn();
const mockUpsert = vi.fn();
const mockDelete = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getSmtpConnectionForOrg: (...a: unknown[]) => mockGet(...a),
    upsertSmtpConnectionForOrg: (...a: unknown[]) => mockUpsert(...a),
    deleteSmtpConnectionForOrg: (...a: unknown[]) => mockDelete(...a),
  };
});
vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { GET, PUT, DELETE } = await import("./route.js");

const VALID = { host: "smtp.customer.test", port: 587, security: "starttls", username: "u", password: "pw", fromAddress: "a@customer.test" };
const put = (body: unknown) => new Request("http://test/api/settings/smtp", { method: "PUT", body: JSON.stringify(body) });
const safe = (o: Record<string, unknown> = {}) => ({
  id: "c1",
  organizationId: "org-1",
  host: "smtp.customer.test",
  port: 587,
  security: "starttls",
  username: "u",
  hasPassword: true,
  fromAddress: "a@customer.test",
  fromName: null,
  enabled: true,
  ...o,
});

describe("/api/settings/smtp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
    delete process.env["CMA_EMAIL_SMTP_HOST"];
  });

  it("GET returns the caller connection (scoped by session) and whether a server default exists", async () => {
    mockGet.mockResolvedValue(safe());
    const body = await (await GET()).json();

    expect(mockGet).toHaveBeenCalledWith("org-1");
    expect(body.connection.hasPassword).toBe(true);
    expect(body.serverDefaultConfigured).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/"(password|encryptedPassword)":/);
  });

  it("PUT saves for the SESSION organization, ignoring any organizationId in the body", async () => {
    mockUpsert.mockResolvedValue(safe());
    const response = await PUT(put({ ...VALID, organizationId: "org-evil" }));

    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0]?.[0]).toBe("org-1");
    expect(mockUpsert.mock.calls[0]?.[1]).not.toHaveProperty("organizationId");
    expect(JSON.stringify(await response.json())).not.toContain("pw");
  });

  it.each([
    ["a non-submission port (port-scan attempt)", { ...VALID, port: 6379 }],
    ["port 22", { ...VALID, port: 22 }],
    ["an unencrypted mode", { ...VALID, security: "none" }],
    ["a host with a scheme", { ...VALID, host: "http://169.254.169.254/" }],
    ["a host with a path", { ...VALID, host: "smtp.customer.test/x" }],
    ["a password without a username", { ...VALID, username: undefined }],
    ["an invalid sender", { ...VALID, fromAddress: "nope" }],
    ["a header-injecting display name", { ...VALID, fromName: "x\r\nBcc: a@b.test" }],
  ])("PUT rejects %s with 400 and saves nothing", async (_label, body) => {
    const response = await PUT(put(body));
    expect(response.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("DELETE removes the caller connection, and 404s when there is none", async () => {
    mockDelete.mockResolvedValue(undefined);
    expect((await DELETE()).status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("org-1");

    const { NotFoundError } = await import("@cma/db");
    mockDelete.mockRejectedValue(new NotFoundError("SmtpConnection"));
    expect((await DELETE()).status).toBe(404);
  });

  it("401s every method when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    expect((await GET()).status).toBe(401);
    expect((await PUT(put(VALID))).status).toBe(401);
    expect((await DELETE()).status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
