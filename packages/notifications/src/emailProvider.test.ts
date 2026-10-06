import { describe, expect, it, vi } from "vitest";
import {
  ConsoleEmailProvider,
  NotConfiguredEmailProvider,
  SmtpEmailProvider,
  createEmailProviderFromEnv,
  isEmailProviderConfigured,
  parseSmtpConfig,
} from "./emailProvider.js";

const VALID_ENV = {
  CMA_EMAIL_SMTP_HOST: "smtp.example.test",
  CMA_EMAIL_SMTP_USER: "bot@example.test",
  CMA_EMAIL_SMTP_PASS: "s3cret",
  CMA_EMAIL_FROM: "bot@example.test",
};

describe("ConsoleEmailProvider", () => {
  it("resolves successfully and logs the message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await new ConsoleEmailProvider().send({ to: "owner@example.test", subject: "Subject", text: "text", html: "<p>html</p>" });

    expect(result.providerMessageId).toBeTruthy();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("owner@example.test"));
    logSpy.mockRestore();
  });
});

describe("parseSmtpConfig", () => {
  it("accepts a full STARTTLS config with defaults (port 587)", () => {
    expect(parseSmtpConfig(VALID_ENV)).toEqual({
      ok: true,
      config: { host: "smtp.example.test", port: 587, security: "starttls", user: "bot@example.test", pass: "s3cret", from: "bot@example.test" },
    });
  });

  it("defaults to implicit TLS on port 465, and SECURE=ssl without a port picks 465", () => {
    expect(parseSmtpConfig({ ...VALID_ENV, CMA_EMAIL_SMTP_PORT: "465" })).toMatchObject({ ok: true, config: { port: 465, security: "ssl" } });
    expect(parseSmtpConfig({ ...VALID_ENV, CMA_EMAIL_SMTP_SECURE: "ssl" })).toMatchObject({ ok: true, config: { port: 465, security: "ssl" } });
  });

  it("allows an unauthenticated relay (no user/pass) and builds a display-name sender", () => {
    const parsed = parseSmtpConfig({
      CMA_EMAIL_SMTP_HOST: "relay.example.test",
      CMA_EMAIL_SMTP_SECURE: "none",
      CMA_EMAIL_FROM: "alerts@example.test",
      CMA_EMAIL_FROM_NAME: 'Competitor "Monitor"',
    });
    expect(parsed).toEqual({
      ok: true,
      config: { host: "relay.example.test", port: 587, security: "none", from: '"Competitor Monitor" <alerts@example.test>' },
    });
  });

  it.each([
    [{}, "CMA_EMAIL_SMTP_HOST"],
    [{ ...VALID_ENV, CMA_EMAIL_FROM: undefined }, "CMA_EMAIL_FROM is not set"],
    [{ ...VALID_ENV, CMA_EMAIL_FROM: "not-an-email" }, "valid email"],
    [{ ...VALID_ENV, CMA_EMAIL_SMTP_PORT: "99999" }, "not a valid port"],
    [{ ...VALID_ENV, CMA_EMAIL_SMTP_SECURE: "maybe" }, "must be one of"],
    [{ ...VALID_ENV, CMA_EMAIL_SMTP_PASS: undefined }, "set together"],
    [{ ...VALID_ENV, CMA_EMAIL_SMTP_USER: undefined }, "set together"],
  ])("rejects an invalid config with an explanation (%#)", (env, expected) => {
    const parsed = parseSmtpConfig(env);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain(expected);
  });
});

describe("SmtpEmailProvider", () => {
  it("sends through the transport with the configured sender and returns the message id", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@example.test>" });
    const provider = new SmtpEmailProvider({ host: "h", port: 587, security: "starttls", from: "bot@example.test" }, { sendMail });

    const result = await provider.send({ to: "owner@example.test", subject: "S", text: "t", html: "<p>h</p>" });

    expect(result).toEqual({ providerMessageId: "<abc@example.test>" });
    expect(sendMail).toHaveBeenCalledWith({ from: "bot@example.test", to: "owner@example.test", subject: "S", text: "t", html: "<p>h</p>" });
  });

  it("propagates a transport failure so the caller can record it", async () => {
    const provider = new SmtpEmailProvider(
      { host: "h", port: 587, security: "starttls", from: "bot@example.test" },
      { sendMail: vi.fn().mockRejectedValue(new Error("535 auth failed")) },
    );
    await expect(provider.send({ to: "a@b.test", subject: "S", text: "t", html: "h" })).rejects.toThrow("535 auth failed");
  });
});

describe("createEmailProviderFromEnv", () => {
  it("is NOT configured by default - it never pretends to deliver", () => {
    const provider = createEmailProviderFromEnv({});
    expect(provider.name).toBe("not-configured");
    expect(isEmailProviderConfigured(provider)).toBe(false);
  });

  it("explains a half-filled SMTP block instead of silently degrading", async () => {
    const provider = createEmailProviderFromEnv({ CMA_EMAIL_SMTP_HOST: "smtp.example.test" });
    expect(provider).toBeInstanceOf(NotConfiguredEmailProvider);
    await expect(provider.send({ to: "a@b.test", subject: "S", text: "t", html: "h" })).rejects.toThrow("CMA_EMAIL_FROM is not set");
  });

  it("returns the SMTP provider for a valid config", () => {
    const provider = createEmailProviderFromEnv(VALID_ENV);
    expect(provider.name).toBe("smtp");
    expect(isEmailProviderConfigured(provider)).toBe(true);
  });

  it("returns the console provider only when explicitly requested", () => {
    expect(createEmailProviderFromEnv({ CMA_EMAIL_PROVIDER: "console" }).name).toBe("console");
    expect(createEmailProviderFromEnv({ CMA_EMAIL_PROVIDER: "console", ...VALID_ENV }).name).toBe("console");
  });
});
