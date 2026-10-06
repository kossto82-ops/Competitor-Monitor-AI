import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrfBlockedError } from "@cma/security";

const { createTransport, sendMail, close } = vi.hoisted(() => {
  const sendMail = vi.fn().mockResolvedValue({ messageId: "<m@x>" });
  const close = vi.fn();
  return { sendMail, close, createTransport: vi.fn((..._args: unknown[]) => ({ sendMail, close })) };
});
vi.mock("nodemailer", () => ({ default: { createTransport } }));

import { classifyEmailSendError, createTenantSmtpProvider, formatFromHeader } from "./emailProvider.js";

const MESSAGE = { to: "owner@example.test", subject: "S", text: "t", html: "<p>h</p>" };
const CONFIG = {
  host: "smtp.customer.test",
  port: 587,
  security: "starttls" as const,
  username: "u@customer.test",
  password: "pw",
  fromAddress: "alerts@customer.test",
  fromName: "Acme Alerts",
};

describe("customer-supplied SMTP host (SSRF guard)", () => {
  beforeEach(() => {
    delete process.env["CMA_ALLOW_PRIVATE_TARGETS"];
    createTransport.mockClear();
    sendMail.mockClear();
    close.mockClear();
  });
  afterEach(() => {
    delete process.env["CMA_ALLOW_PRIVATE_TARGETS"];
  });

  it.each([
    ["a hostname that resolves to loopback", "smtp.customer.test", "127.0.0.1"],
    ["a hostname that resolves to the cloud metadata address", "smtp.customer.test", "169.254.169.254"],
    ["a hostname that resolves to a private range", "smtp.customer.test", "10.0.0.5"],
    ["a literal private IP", "192.168.1.10", "192.168.1.10"],
    ["a literal loopback IP", "127.0.0.1", "127.0.0.1"],
  ])("refuses %s and never opens a connection", async (_label, host, resolvedTo) => {
    const provider = createTenantSmtpProvider({ ...CONFIG, host }, async () => [{ address: resolvedTo, family: 4 }]);

    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("refuses when ANY resolved address is internal (a public record cannot smuggle in a private one)", async () => {
    const provider = createTenantSmtpProvider(CONFIG, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("refuses localhost-style names without resolving them at all", async () => {
    const resolve = vi.fn();
    const provider = createTenantSmtpProvider({ ...CONFIG, host: "mail.internal" }, resolve);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("connects to the VALIDATED IP (not the name, so no re-resolution) while verifying TLS against the original hostname", async () => {
    const provider = createTenantSmtpProvider(CONFIG, async () => [{ address: "93.184.216.34", family: 4 }]);

    await provider.send(MESSAGE);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "93.184.216.34",
        port: 587,
        secure: false,
        requireTLS: true,
        tls: { servername: "smtp.customer.test" },
        auth: { user: "u@customer.test", pass: "pw" },
      }),
    );
    const options = createTransport.mock.calls[0]?.[0] as unknown as { tls: Record<string, unknown> };
    expect(options.tls).not.toHaveProperty("rejectUnauthorized");
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"Acme Alerts" <alerts@customer.test>', to: "owner@example.test" }));
    expect(close).toHaveBeenCalled();
  });

  it("uses implicit TLS for the ssl mode and sends without auth when no credentials are stored", async () => {
    const provider = createTenantSmtpProvider(
      { host: "smtp.customer.test", port: 465, security: "ssl", fromAddress: "a@customer.test" },
      async () => [{ address: "93.184.216.34", family: 4 }],
    );
    await provider.send(MESSAGE);

    const options = createTransport.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(options).toMatchObject({ secure: true, requireTLS: false });
    expect(options).not.toHaveProperty("auth");
  });

  it("closes the transport even when sending fails", async () => {
    sendMail.mockRejectedValueOnce(new Error("550 relay denied"));
    const provider = createTenantSmtpProvider(CONFIG, async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(provider.send(MESSAGE)).rejects.toThrow("550 relay denied");
    expect(close).toHaveBeenCalled();
  });
});

describe("formatFromHeader", () => {
  it("strips characters that could break out of the header", () => {
    expect(formatFromHeader("a@b.test", 'Evil"\r\nBcc: x <y>')).toBe('"EvilBcc: x y" <a@b.test>');
    expect(formatFromHeader("a@b.test", "  ")).toBe("a@b.test");
    expect(formatFromHeader("a@b.test", null)).toBe("a@b.test");
  });
});

describe("classifyEmailSendError", () => {
  const withCode = (code: string, message = "boom") => Object.assign(new Error(message), { code });

  it.each([
    [new SsrfBlockedError("Hostname x resolved to 10.1.2.3, which is blocked"), "BLOCKED_HOST"],
    [withCode("EAUTH", "535 5.7.8 Authentication failed for bot@x"), "AUTH_FAILED"],
    [withCode("ECONNECTION"), "CONNECTION_FAILED"],
    [withCode("ETIMEDOUT"), "CONNECTION_FAILED"],
    [withCode("ESOCKET", "self-signed certificate"), "TLS_FAILED"],
    [withCode("EENVELOPE"), "REJECTED"],
    [new Error("something else"), "UNKNOWN"],
  ])("classifies %#", (err, expected) => {
    expect(classifyEmailSendError(err).code).toBe(expected);
  });

  it("never leaks the raw server reply or a resolved internal address to the customer", () => {
    const blocked = classifyEmailSendError(new SsrfBlockedError("Hostname x resolved to 10.1.2.3, which is blocked"));
    const auth = classifyEmailSendError(withCode("EAUTH", "535 internal-relay-07 says no"));
    expect(blocked.message).not.toContain("10.1.2.3");
    expect(auth.message).not.toContain("internal-relay-07");
  });
});
