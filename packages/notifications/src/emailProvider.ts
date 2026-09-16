/**
 * Phase 4 (Section 15): email delivery is a swappable vendor detail,
 * same philosophy as @cma/ai's provider registry (Phase 3.1) - callers
 * depend on this interface, never on a specific vendor SDK.
 *
 * HONEST SCOPE NOTE: only `ConsoleEmailProvider` is implemented in this
 * phase. No real SMTP/HTTP email vendor is wired up - there is no
 * available credential or approved vendor to integrate against, and
 * fabricating one would be worse than not shipping it. This is
 * documented as a known simplification in PHASE4-VALIDATION.md, not
 * hidden. Everything downstream (idempotency, content building, retry
 * isolation) is written against this interface and works unchanged the
 * day a real provider is added - see `createEmailProviderFromEnv`.
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
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Deterministic, free, no network call - logs the message and returns
 * immediately. Used for local development, CI, and any environment
 * without a configured real provider. Never throws by itself; a caller
 * testing failure-isolation behavior (Section 17) should inject a
 * different EmailProvider that does throw, not rely on this one to fail.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: EmailMessage): Promise<EmailSendResult> {
    console.log(`[email:console] to=${message.to} subject="${message.subject}"`);
    return { providerMessageId: `console-${Date.now()}` };
  }
}

/**
 * Resolution order documented for symmetry with resolveAiProviderForOrg,
 * even though there is currently only one real option:
 *   1. A real vendor provider, if one is ever added and configured via
 *      env (e.g. CMA_EMAIL_PROVIDER=smtp) - NOT implemented yet.
 *   2. ConsoleEmailProvider, always available, used in every environment
 *      today including production - deliberately NOT a silent
 *      "pretend to send" hidden default: it is the only implementation
 *      that exists, and that fact is documented, not hidden.
 */
export function createEmailProviderFromEnv(): EmailProvider {
  return new ConsoleEmailProvider();
}
