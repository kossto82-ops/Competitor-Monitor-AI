import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 29 / A3: every abuse/cost limit, exercised through the real route
 * handlers. The Redis limiter is the suite-wide mock (src/test/setup.ts),
 * overridden per test to say "over the limit", so what is verified here is
 * what each route DOES at the limit - above all that nothing with a cost or
 * a side effect happens first.
 */
const m = vi.hoisted(() => ({
  requireSession: vi.fn(),
  findUserByEmail: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  createOrganizationWithOwner: vi.fn(),
  getMonitoredUrlForOrg: vi.fn(),
  createPendingMonitoringJob: vi.fn(),
  getChangeEventForOrg: vi.fn(),
  getOrCreatePendingAiAnalysis: vi.fn(),
  getOrCreateDigestAiInterpretationSlot: vi.fn(),
  testAiConnection: vi.fn(),
  getEnabledSmtpConfigForOrg: vi.fn(),
  getReportRecipientEmailForOrg: vi.fn(),
  smtpSend: vi.fn(),
  countCompetitorsForOrg: vi.fn(),
  createCompetitor: vi.fn(),
  countMonitoredUrlsForOrg: vi.fn(),
  createMonitoredUrl: vi.fn(),
  updateMonitoredUrl: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/currentSession", async (orig) => ({ ...(await orig<typeof import("@/lib/currentSession")>()), requireSession: () => m.requireSession() }));
vi.mock("@/lib/password", () => ({ verifyPassword: m.verifyPassword, hashPassword: m.hashPassword }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), createSessionToken: async () => "token" }));
vi.mock("@cma/db", async (orig) => ({
  ...(await orig<typeof import("@cma/db")>()),
  findUserByEmail: m.findUserByEmail,
  createOrganizationWithOwner: m.createOrganizationWithOwner,
  getMonitoredUrlForOrg: m.getMonitoredUrlForOrg,
  createPendingMonitoringJob: m.createPendingMonitoringJob,
  markMonitoringJobFailed: vi.fn(),
  getChangeEventForOrg: m.getChangeEventForOrg,
  getOrCreatePendingAiAnalysis: m.getOrCreatePendingAiAnalysis,
  getOrCreateDigestAiInterpretationSlot: m.getOrCreateDigestAiInterpretationSlot,
  getEnabledSmtpConfigForOrg: m.getEnabledSmtpConfigForOrg,
  getReportRecipientEmailForOrg: m.getReportRecipientEmailForOrg,
  countCompetitorsForOrg: m.countCompetitorsForOrg,
  createCompetitor: m.createCompetitor,
  countMonitoredUrlsForOrg: m.countMonitoredUrlsForOrg,
  createMonitoredUrl: m.createMonitoredUrl,
  updateMonitoredUrl: m.updateMonitoredUrl,
}));
vi.mock("@cma/ai", async (orig) => ({ ...(await orig<typeof import("@cma/ai")>()), testAiConnection: m.testAiConnection }));
vi.mock("@cma/notifications", async (orig) => ({
  ...(await orig<typeof import("@cma/notifications")>()),
  createTenantSmtpProvider: () => ({ send: m.smtpSend }),
}));
vi.mock("@cma/security", async (orig) => ({ ...(await orig<typeof import("@cma/security")>()), resolveAndValidateHost: async () => "93.184.216.34" }));
vi.mock("@cma/queue", async (orig) => {
  const queue = { add: m.queueAdd, close: async () => undefined };
  return {
    ...(await orig<typeof import("@cma/queue")>()),
    createMonitoringQueue: () => queue,
    createAiAnalysisQueue: () => queue,
    createDigestInterpretationQueue: () => queue,
    addJobReplacingTerminal: (q: { add: (...a: unknown[]) => unknown }, name: string, data: unknown, jobId: string) => q.add(name, data, { jobId }),
  };
});

import { hit, peek, reset } from "@/lib/rateLimit";

const login = (await import("./auth/login/route")).POST;
const signup = (await import("./auth/signup/route")).POST;
const scan = (await import("./monitored-urls/[urlId]/scan/route")).POST;
const analysis = (await import("./change-events/[changeEventId]/analysis/route")).POST;
const digest = (await import("./digest/interpretation/route")).POST;
const aiTest = (await import("./ai-connections/test/route")).POST;
const smtpTest = (await import("./settings/smtp/test/route")).POST;
const competitors = (await import("./competitors/route")).POST;
const urls = (await import("./competitors/[competitorId]/urls/route")).POST;
const patchUrl = (await import("./monitored-urls/[urlId]/route")).PATCH;

const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://test${url}`, { method: "POST", body: JSON.stringify(body), headers });

const overLimit = (retryAfterSeconds = 42) => ({ allowed: false, count: 99, limit: 1, retryAfterSeconds });
const mockedHit = vi.mocked(hit);
const mockedPeek = vi.mocked(peek);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  m.requireSession.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
});

describe("login: only FAILED attempts count, and a lockout is a 429 with Retry-After", () => {
  const body = { email: "User@Example.test", password: "whatever-pw" };

  it("blocks without touching the user table or verifying a password once the IP+email key is exhausted", async () => {
    mockedPeek.mockResolvedValueOnce(overLimit(120));
    const response = await login(json("/api/auth/login", body, { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(m.findUserByEmail).not.toHaveBeenCalled();
    expect(m.verifyPassword).not.toHaveBeenCalled();
    expect(mockedPeek.mock.calls[0]?.[0]).toBe("login:9.9.9.9:user@example.test");
  });

  it("also blocks on the email-only key, so rotating X-Forwarded-For does not make guessing free", async () => {
    mockedPeek.mockResolvedValueOnce({ allowed: true, count: 0, limit: 10, retryAfterSeconds: 0 }).mockResolvedValueOnce(overLimit());
    const response = await login(json("/api/auth/login", body, { "x-forwarded-for": "1.2.3.4" }));

    expect(response.status).toBe(429);
    expect(mockedPeek.mock.calls[1]?.[0]).toBe("login-email:user@example.test");
    expect(mockedPeek.mock.calls[1]?.[1]).toBe(50);
    expect(m.verifyPassword).not.toHaveBeenCalled();
  });

  it("counts a wrong password, and counts an UNKNOWN email identically (the throttle leaks nothing about accounts)", async () => {
    m.findUserByEmail.mockResolvedValueOnce({ id: "u", organizationId: "o", passwordHash: "h" }).mockResolvedValueOnce(null);
    m.verifyPassword.mockResolvedValue(false);

    const wrongPassword = await login(json("/api/auth/login", body));
    const unknownEmail = await login(json("/api/auth/login", body));

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(mockedHit).toHaveBeenCalledTimes(4); // ip key + email key, for each of the two failures
  });

  it("a successful login counts nothing and clears the counter", async () => {
    m.findUserByEmail.mockResolvedValue({ id: "u", organizationId: "o", passwordHash: "h" });
    m.verifyPassword.mockResolvedValue(true);

    const response = await login(json("/api/auth/login", body, { "x-forwarded-for": "5.5.5.5" }));

    expect(response.status).toBe(200);
    expect(mockedHit).not.toHaveBeenCalled();
    expect(vi.mocked(reset)).toHaveBeenCalledWith("login:5.5.5.5:user@example.test");
  });

  it("honours CMA_LIMIT_LOGIN_ATTEMPTS and the window", async () => {
    vi.stubEnv("CMA_LIMIT_LOGIN_ATTEMPTS", "3");
    vi.stubEnv("CMA_LIMIT_LOGIN_WINDOW_MIN", "5");
    m.findUserByEmail.mockResolvedValue(null);

    await login(json("/api/auth/login", body));

    expect(mockedPeek.mock.calls[0]?.[1]).toBe(3);
    expect(mockedHit).toHaveBeenCalledWith("login:unknown:user@example.test", 3, 300);
  });
});

describe("signup", () => {
  const body = { organizationName: "Acme", email: "new@example.test", password: "a-long-enough-password" };

  it("is limited per IP and refuses BEFORE any lookup or account creation", async () => {
    mockedHit.mockResolvedValueOnce(overLimit(3000));
    const response = await signup(json("/api/auth/signup", body, { "x-forwarded-for": "7.7.7.7" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3000");
    expect(mockedHit.mock.calls[0]).toEqual(["signup:7.7.7.7", 5, 3600]);
    expect(m.findUserByEmail).not.toHaveBeenCalled();
    expect(m.createOrganizationWithOwner).not.toHaveBeenCalled();
  });
});

describe("cost-bearing actions are refused before any side effect", () => {
  it("manual scan: no PENDING job row and no queue job when over the hourly quota", async () => {
    m.getMonitoredUrlForOrg.mockResolvedValue({ id: "url-1", organizationId: "org-1" });
    mockedHit.mockResolvedValueOnce(overLimit());
    const response = await scan(json("/x", {}), { params: Promise.resolve({ urlId: "url-1" }) });

    expect(response.status).toBe(429);
    expect(mockedHit.mock.calls[0]).toEqual(["scan:org-1", 20, 3600]);
    expect(m.createPendingMonitoringJob).not.toHaveBeenCalled();
    expect(m.queueAdd).not.toHaveBeenCalled();
  });

  it("AI analysis: no PENDING row is created and nothing is enqueued over the daily quota", async () => {
    m.getChangeEventForOrg.mockResolvedValue({ id: "ce-1", changeType: "PRICE_CHANGE" });
    mockedHit.mockResolvedValueOnce(overLimit());
    const response = await analysis(json("/x", {}), { params: Promise.resolve({ changeEventId: "ce-1" }) });

    expect(response.status).toBe(429);
    expect(mockedHit.mock.calls[0]).toEqual(["ai-analysis:org-1", 30, 86_400]);
    expect(m.getOrCreatePendingAiAnalysis).not.toHaveBeenCalled();
    expect(m.queueAdd).not.toHaveBeenCalled();
  });

  it("AI digest: the slot is NOT reset to PENDING (which would strand a job-less row) over the daily quota", async () => {
    mockedHit.mockResolvedValueOnce(overLimit());
    const response = await digest(json("/api/digest/interpretation?days=30", {}));

    expect(response.status).toBe(429);
    expect(mockedHit.mock.calls[0]).toEqual(["ai-digest:org-1", 10, 86_400]);
    expect(m.getOrCreateDigestAiInterpretationSlot).not.toHaveBeenCalled();
    expect(m.queueAdd).not.toHaveBeenCalled();
  });

  it("AI connection test: no outbound provider call over the hourly quota", async () => {
    mockedHit.mockResolvedValueOnce(overLimit());
    const response = await aiTest(json("/x", { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" }));

    expect(response.status).toBe(429);
    expect(m.testAiConnection).not.toHaveBeenCalled();
  });

  it("SMTP test: no connection attempt over the hourly quota", async () => {
    mockedHit.mockResolvedValueOnce(overLimit());
    const response = await smtpTest();

    expect(response.status).toBe(429);
    expect(m.getEnabledSmtpConfigForOrg).not.toHaveBeenCalled();
    expect(m.smtpSend).not.toHaveBeenCalled();
  });

  it("quotas are per organization: the key carries the session org, never anything from the request", async () => {
    m.requireSession.mockResolvedValue({ userId: "u", organizationId: "org-777" });
    m.getMonitoredUrlForOrg.mockResolvedValue({ id: "url-1", organizationId: "org-777" });
    m.createPendingMonitoringJob.mockResolvedValue({ id: "job-1" });
    m.queueAdd.mockResolvedValue({ id: "job-1" });
    await scan(json("/x", { organizationId: "org-evil" }), { params: Promise.resolve({ urlId: "url-1" }) });

    expect(mockedHit.mock.calls[0]?.[0]).toBe("scan:org-777");
  });

  it("an allowed request proceeds normally (the quota is not in the way)", async () => {
    m.getMonitoredUrlForOrg.mockResolvedValue({ id: "url-1", organizationId: "org-1" });
    m.createPendingMonitoringJob.mockResolvedValue({ id: "job-1" });
    m.queueAdd.mockResolvedValue({ id: "job-1" });
    const response = await scan(json("/x", {}), { params: Promise.resolve({ urlId: "url-1" }) });

    expect(response.status).toBe(202);
    expect(m.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("limits come from the environment", async () => {
    vi.stubEnv("CMA_LIMIT_AI_DIGESTS_PER_DAY", "2");
    mockedHit.mockResolvedValueOnce(overLimit());
    await digest(json("/api/digest/interpretation?days=7", {}));
    expect(mockedHit.mock.calls[0]).toEqual(["ai-digest:org-1", 2, 86_400]);
  });
});

describe("per-organization caps", () => {
  it("rejects a new competitor at the cap (inactive ones count) with 403 QUOTA_EXCEEDED, and creates nothing", async () => {
    m.countCompetitorsForOrg.mockResolvedValue(25);
    const response = await competitors(json("/api/competitors", { name: "Rival" }));

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("QUOTA_EXCEEDED");
    expect(m.countCompetitorsForOrg).toHaveBeenCalledWith("org-1");
    expect(m.createCompetitor).not.toHaveBeenCalled();
  });

  it("allows a competitor just below the cap", async () => {
    m.countCompetitorsForOrg.mockResolvedValue(24);
    m.createCompetitor.mockResolvedValue({ id: "c1" });
    expect((await competitors(json("/api/competitors", { name: "Rival" }))).status).toBe(201);
  });

  it("rejects a new monitored URL at the cap, and honours CMA_LIMIT_URLS_PER_ORG", async () => {
    vi.stubEnv("CMA_LIMIT_URLS_PER_ORG", "3");
    m.countMonitoredUrlsForOrg.mockResolvedValue(3);
    const response = await urls(json("/x", { url: "https://rival.example.test/pricing" }), { params: Promise.resolve({ competitorId: "c1" }) });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("3 monitored URLs");
    expect(m.createMonitoredUrl).not.toHaveBeenCalled();
  });

  it("allows a monitored URL below the cap", async () => {
    m.countMonitoredUrlsForOrg.mockResolvedValue(99);
    m.createMonitoredUrl.mockResolvedValue({ id: "u1" });
    const response = await urls(json("/x", { url: "https://rival.example.test/pricing" }), { params: Promise.resolve({ competitorId: "c1" }) });
    expect(response.status).toBe(201);
  });
});

describe("minimum scan interval", () => {
  const patch = (body: unknown) => new Request("http://test/x", { method: "PATCH", body: JSON.stringify(body) });
  const params = { params: Promise.resolve({ urlId: "u1" }) };

  it("rejects an interval shorter than the minimum (default 60 minutes) and changes nothing", async () => {
    const response = await patchUrl(patch({ scanFrequencyMinutes: 15 }), params);

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("SCAN_INTERVAL_TOO_SHORT");
    expect(m.updateMonitoredUrl).not.toHaveBeenCalled();
  });

  it("accepts the minimum itself, and other edits without a frequency are untouched", async () => {
    m.updateMonitoredUrl.mockResolvedValue({ id: "u1" });
    expect((await patchUrl(patch({ scanFrequencyMinutes: 60 }), params)).status).toBe(200);
    expect((await patchUrl(patch({ isActive: false }), params)).status).toBe(200);
  });

  it("the minimum is configurable", async () => {
    vi.stubEnv("CMA_LIMIT_MIN_SCAN_INTERVAL_MIN", "15");
    m.updateMonitoredUrl.mockResolvedValue({ id: "u1" });
    expect((await patchUrl(patch({ scanFrequencyMinutes: 15 }), params)).status).toBe(200);
  });
});
