import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import { createEmailProviderFromEnv } from "./emailProvider.js";

/**
 * End-to-end delivery check against a real (in-process) SMTP server: the
 * provider is built from environment variables exactly as in production,
 * and the message is read back off the wire. Covers authentication and
 * that the HTML/text bodies arrive intact.
 */
describe("SMTP delivery against a real SMTP server", () => {
  let server: SMTPServer;
  let port: number;
  const received: ParsedMail[] = [];

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ["STARTTLS"],
      onAuth(auth, _session, callback) {
        if (auth.username === "bot@example.test" && auth.password === "s3cret") return callback(null, { user: auth.username });
        return callback(new Error("Invalid credentials"));
      },
      onData(stream, _session, callback) {
        simpleParser(stream)
          .then((mail) => {
            received.push(mail);
            callback();
          })
          .catch(callback);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const env = (overrides: Record<string, string> = {}) => ({
    CMA_EMAIL_SMTP_HOST: "127.0.0.1",
    CMA_EMAIL_SMTP_PORT: String(port),
    CMA_EMAIL_SMTP_SECURE: "none",
    CMA_EMAIL_SMTP_USER: "bot@example.test",
    CMA_EMAIL_SMTP_PASS: "s3cret",
    CMA_EMAIL_FROM: "bot@example.test",
    CMA_EMAIL_FROM_NAME: "Competitor Monitor",
    ...overrides,
  });

  it("delivers a real message with sender, recipient, subject, text and html intact", async () => {
    const provider = createEmailProviderFromEnv(env());
    const result = await provider.send({
      to: "owner@example.test",
      subject: "Competitor Update — 16 September 2026",
      text: "Price changed from €49 to €59",
      html: "<p>Price changed from €49 to €59</p>",
    });

    expect(result.providerMessageId).toBeTruthy();
    expect(received).toHaveLength(1);
    const mail = received[0]!;
    expect(mail.subject).toBe("Competitor Update — 16 September 2026");
    expect(mail.from?.value[0]).toMatchObject({ name: "Competitor Monitor", address: "bot@example.test" });
    expect(mail.to).toMatchObject({ value: [{ address: "owner@example.test" }] });
    expect(mail.text?.trim()).toBe("Price changed from €49 to €59");
    expect(mail.html).toContain("<p>Price changed from €49 to €59</p>");
  });

  it("rejects wrong credentials, so the caller records FAILED instead of SENT", async () => {
    const provider = createEmailProviderFromEnv(env({ CMA_EMAIL_SMTP_PASS: "wrong" }));
    await expect(provider.send({ to: "owner@example.test", subject: "S", text: "t", html: "h" })).rejects.toThrow();
  });
});
