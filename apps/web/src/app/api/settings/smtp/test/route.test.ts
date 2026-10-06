import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRequireSession = vi.fn();
const mockGetConfig = vi.fn();
const mockGetRecipient = vi.fn();
const mockSend = vi.fn();
const mockCreateProvider = vi.fn();

vi.mock("@cma/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/db")>();
  return {
    ...actual,
    getEnabledSmtpConfigForOrg: (...a: unknown[]) => mockGetConfig(...a),
    getReportRecipientEmailForOrg: (...a: unknown[]) => mockGetRecipient(...a),
  };
});
vi.mock("@cma/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cma/notifications")>();
  return { ...actual, createTenantSmtpProvider: (...a: unknown[]) => mockCreateProvider(...a) };
});
vi.mock("@/lib/currentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/currentSession")>();
  return { ...actual, requireSession: () => mockRequireSession() };
});

const { POST } = await import("./route.js");

const CONFIG = {
  host: "smtp.customer.test",
  port: 587,
  security: "starttls",
  username: "u",
  password: "super-secret",
  fromAddress: "a@customer.test",
  fromName: null,
};

describe("POST /api/settings/smtp/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
    mockGetConfig.mockResolvedValue(CONFIG);
    mockGetRecipient.mockResolvedValue("owner@customer.test");
    mockCreateProvider.mockReturnValue({ send: mockSend });
    mockSend.mockResolvedValue({});
  });

  it("sends one test email to the organization OWN recipient, using the saved account", async () => {
    const response = await POST();
    const body = await response.json();

    expect(body.status).toBe("SUCCESS");
    expect(mockGetConfig).toHaveBeenCalledWith("org-1");
    expect(mockGetRecipient).toHaveBeenCalledWith("org-1");
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@customer.test" }));
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  it("takes no recipient from the request, so it cannot mail arbitrary addresses", async () => {
    // The handler takes no request argument at all; calling it with one must change nothing.
    const call = POST as unknown as (r: Request) => Promise<Response>;
    await call(new Request("http://test", { method: "POST", body: JSON.stringify({ to: "victim@example.test" }) }));
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@customer.test" }));
  });

  it("409s when no enabled SMTP account is saved", async () => {
    mockGetConfig.mockResolvedValue(null);
    const response = await POST();
    expect(response.status).toBe(409);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reports a blocked (internal) host without leaking the address it resolved to", async () => {
    const { SsrfBlockedError } = await import("@cma/security");
    mockSend.mockRejectedValue(new SsrfBlockedError("Hostname smtp.customer.test resolved to 10.9.8.7, which is blocked"));
    const body = await (await POST()).json();

    expect(body.status).toBe("FAILED");
    expect(body.code).toBe("BLOCKED_HOST");
    expect(JSON.stringify(body)).not.toContain("10.9.8.7");
  });

  it("returns a classified message, never the raw server reply", async () => {
    mockSend.mockRejectedValue(Object.assign(new Error("535 relay-internal-03: bad creds for u"), { code: "EAUTH" }));
    const body = await (await POST()).json();

    expect(body.code).toBe("AUTH_FAILED");
    expect(JSON.stringify(body)).not.toContain("relay-internal-03");
  });

  it("401s when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/currentSession");
    mockRequireSession.mockRejectedValue(new UnauthorizedError());
    expect((await POST()).status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
