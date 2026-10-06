import nodemailer from "nodemailer";
import { SsrfBlockedError, resolveAndValidateHost, type ResolveFn } from "@cma/security";

/**
 * Email delivery is a swappable detail: callers depend on this
 * interface, never on a specific vendor or library.
 *
 * Providers:
 *   - SmtpEmailProvider: any standard SMTP account (a company mail
 *     server, a personal mailbox, or any transactional service that
 *     exposes SMTP). Configured only through environment variables.
 *   - ConsoleEmailProvider: logs and sends nothing. Never chosen by
 *     default; only when CMA_EMAIL_PROVIDER=console is set explicitly
 *     (local development).
 *   - NotConfiguredEmailProvider: the default when nothing is
 *     configured. It reports `configured: false` so callers skip
 *     delivery and never record a report as SENT when nothing left the
 *     machine.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendResult {
  providerMessageId?: string;
}

export interface EmailProvider {
  readonly name: string;
  /** false = delivery is impossible; callers must skip instead of calling send(). Undefined means configured. */
  readonly configured?: boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export function isEmailProviderConfigured(provider: EmailProvider): boolean {
  return provider.configured !== false;
}

/** Dev only: logs the message and returns immediately. Sends nothing. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: EmailMessage): Promise<EmailSendResult> {
    console.log(`[email:console] to=${message.to} subject="${message.subject}"`);
    return { providerMessageId: `console-${Date.now()}` };
  }
}

export class NotConfiguredEmailProvider implements EmailProvider {
  readonly name = "not-configured";
  readonly configured = false;

  constructor(readonly reason: string) {}

  async send(): Promise<EmailSendResult> {
    throw new Error(`Email delivery is not configured: ${this.reason}`);
  }
}

export type SmtpSecurity = "ssl" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string;
  pass?: string;
  from: string;
}

export type SmtpConfigResult = { ok: true; config: SmtpConfig } | { ok: false; reason: string };

const EMAIL_ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function parseSecurity(raw: string | undefined, port: number): SmtpSecurity | null {
  if (raw === undefined || raw.trim() === "") return port === 465 ? "ssl" : "starttls";
  switch (raw.trim().toLowerCase()) {
    case "ssl":
    case "tls":
    case "true":
      return "ssl";
    case "starttls":
      return "starttls";
    case "none":
    case "false":
      return "none";
    default:
      return null;
  }
}

export function formatFromHeader(address: string, displayName?: string | null): string {
  const name = displayName?.trim().replace(/["\r\n<>]/g, "");
  return name ? `"${name}" <${address}>` : address;
}

/**
 * Parses the SMTP settings. Pure (takes the env as an argument) so it is
 * unit-testable; returns a reason instead of throwing, so a half-filled
 * configuration degrades to "not configured" with an explanation rather
 * than crashing every report job.
 *
 *   CMA_EMAIL_SMTP_HOST      required
 *   CMA_EMAIL_SMTP_PORT      default 587 (465 when SECURE=ssl)
 *   CMA_EMAIL_SMTP_SECURE    ssl | starttls | none (default: ssl on 465, else starttls)
 *   CMA_EMAIL_SMTP_USER      optional, must be paired with PASS
 *   CMA_EMAIL_SMTP_PASS      optional, must be paired with USER
 *   CMA_EMAIL_FROM           required, the sender address
 *   CMA_EMAIL_FROM_NAME      optional display name
 */
export function parseSmtpConfig(env: Record<string, string | undefined>): SmtpConfigResult {
  const host = env["CMA_EMAIL_SMTP_HOST"]?.trim();
  if (!host) return { ok: false, reason: "CMA_EMAIL_SMTP_HOST is not set" };

  const securityRaw = env["CMA_EMAIL_SMTP_SECURE"];
  const portRaw = env["CMA_EMAIL_SMTP_PORT"]?.trim();
  let port: number;
  if (portRaw) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: `CMA_EMAIL_SMTP_PORT "${portRaw}" is not a valid port` };
    }
  } else {
    port = securityRaw && ["ssl", "tls", "true"].includes(securityRaw.trim().toLowerCase()) ? 465 : 587;
  }

  const security = parseSecurity(securityRaw, port);
  if (security === null) {
    return { ok: false, reason: `CMA_EMAIL_SMTP_SECURE "${securityRaw}" must be one of ssl, starttls, none` };
  }

  const user = env["CMA_EMAIL_SMTP_USER"]?.trim() || undefined;
  const pass = env["CMA_EMAIL_SMTP_PASS"] || undefined;
  if ((user && !pass) || (!user && pass)) {
    return { ok: false, reason: "CMA_EMAIL_SMTP_USER and CMA_EMAIL_SMTP_PASS must be set together" };
  }

  const fromAddress = env["CMA_EMAIL_FROM"]?.trim();
  if (!fromAddress) return { ok: false, reason: "CMA_EMAIL_FROM is not set" };
  if (!EMAIL_ADDRESS.test(fromAddress)) return { ok: false, reason: "CMA_EMAIL_FROM is not a valid email address" };
  const fromName = env["CMA_EMAIL_FROM_NAME"]?.trim().replace(/["\r\n]/g, "");
  const from = fromName ? `"${fromName}" <${fromAddress}>` : fromAddress;

  return { ok: true, config: { host, port, security, ...(user ? { user, pass } : {}), from } };
}

/** The slice of a nodemailer transport this provider uses; injectable for tests. */
export interface SmtpTransport {
  sendMail(options: { from: string; to: string; subject: string; text: string; html: string }): Promise<{ messageId?: string }>;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";

  constructor(
    private readonly config: SmtpConfig,
    private readonly transport: SmtpTransport = createSmtpTransport(config),
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return info.messageId ? { providerMessageId: info.messageId } : {};
  }
}

export function createSmtpTransport(config: SmtpConfig): SmtpTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "ssl",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Resolution:
 *   1. CMA_EMAIL_PROVIDER=console -> ConsoleEmailProvider (explicit, dev).
 *   2. SMTP settings present and valid -> SmtpEmailProvider.
 *   3. Anything else -> NotConfiguredEmailProvider with the reason
 *      (a partially filled SMTP block reports what is wrong).
 */
export function createEmailProviderFromEnv(env: Record<string, string | undefined> = process.env): EmailProvider {
  if (env["CMA_EMAIL_PROVIDER"]?.trim().toLowerCase() === "console") return new ConsoleEmailProvider();

  const parsed = parseSmtpConfig(env);
  if (parsed.ok) return new SmtpEmailProvider(parsed.config);
  return new NotConfiguredEmailProvider(parsed.reason);
}

/** An organization's own SMTP account (customer-supplied, therefore untrusted input). */
export interface TenantSmtpConfig {
  host: string;
  port: number;
  security: "ssl" | "starttls";
  username?: string | null;
  password?: string | null;
  fromAddress: string;
  fromName?: string | null;
}

/**
 * A transport for a customer-supplied SMTP host. The operator's own SMTP
 * settings (env) are trusted; this host is not - the customer could
 * point it at localhost, the cloud metadata service or an internal
 * mail relay and use delivery as a port scanner. So, exactly like page
 * fetching (see @cma/security), every send first resolves the host,
 * validates EVERY returned address against the SSRF allowlist, and then
 * connects to that validated IP (never re-resolving the name, which
 * would reopen the DNS-rebinding window). TLS certificate validation
 * stays on, checked against the original hostname via `servername`.
 */
export function createGuardedSmtpTransport(config: TenantSmtpConfig, resolveFn?: ResolveFn): SmtpTransport {
  return {
    async sendMail(options) {
      const pinnedAddress = await resolveAndValidateHost(config.host, resolveFn);
      const transporter = nodemailer.createTransport({
        host: pinnedAddress,
        port: config.port,
        secure: config.security === "ssl",
        requireTLS: config.security === "starttls",
        tls: { servername: config.host },
        ...(config.username ? { auth: { user: config.username, pass: config.password ?? "" } } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
      try {
        return await transporter.sendMail(options);
      } finally {
        transporter.close();
      }
    },
  };
}

export function createTenantSmtpProvider(config: TenantSmtpConfig, resolveFn?: ResolveFn): EmailProvider {
  return new SmtpEmailProvider(
    {
      host: config.host,
      port: config.port,
      security: config.security,
      ...(config.username ? { user: config.username, pass: config.password ?? "" } : {}),
      from: formatFromHeader(config.fromAddress, config.fromName),
    },
    createGuardedSmtpTransport(config, resolveFn),
  );
}

export interface EmailSendFailure {
  code: "BLOCKED_HOST" | "AUTH_FAILED" | "CONNECTION_FAILED" | "TLS_FAILED" | "REJECTED" | "UNKNOWN";
  /** Safe to show to the customer: never echoes the server's raw reply, banner or resolved address. */
  message: string;
}

/**
 * Turns a failed send into a short, customer-safe explanation. A
 * customer-supplied host must not become an oracle for what is inside
 * our network, so the raw SMTP reply and any resolved address are never
 * returned - only a classification.
 */
export function classifyEmailSendError(err: unknown): EmailSendFailure {
  if (err instanceof SsrfBlockedError) {
    return { code: "BLOCKED_HOST", message: "This host resolves to a private or internal address, which is not allowed." };
  }
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
  const text = err instanceof Error ? err.message : "";

  if (code === "EAUTH") return { code: "AUTH_FAILED", message: "The server rejected the username or password." };
  if (/certificate|self[- ]signed|hostname\/ip does not match|altnames|wrong version number|ssl|tls/i.test(text) || code.startsWith("ERR_TLS") || code === "ETLS") {
    return { code: "TLS_FAILED", message: "The secure connection could not be established. Check the port and the SSL/STARTTLS setting, and that the server certificate is valid for this host." };
  }
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "ENOTFOUND", "EDNS", "ECONNRESET", "EHOSTUNREACH"].includes(code) || /timed? ?out|ENOTFOUND|ECONNREFUSED/i.test(text)) {
    return { code: "CONNECTION_FAILED", message: "Could not connect to the SMTP server. Check the host and port." };
  }
  if (code === "EENVELOPE" || code === "EMESSAGE") {
    return { code: "REJECTED", message: "The server rejected the message (sender or recipient not accepted)." };
  }
  return { code: "UNKNOWN", message: "The email could not be sent." };
}
