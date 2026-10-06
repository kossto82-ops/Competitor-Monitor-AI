import { NextResponse } from "next/server";
import { getEnabledSmtpConfigForOrg, getReportRecipientEmailForOrg } from "@cma/db";
import { classifyEmailSendError, createTenantSmtpProvider } from "@cma/notifications";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";
import { readLimits } from "@/lib/limits";
import { checkLimit } from "@/lib/limitResponse";

/**
 * Sends one test message through the organization's SAVED, enabled SMTP
 * account. The recipient is never taken from the request: it is always
 * the organization's own report recipient, so this cannot be used to
 * send mail to arbitrary addresses. The host is SSRF-validated by the
 * transport itself, and the customer only ever sees a classified,
 * non-revealing error message.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const limited = await checkLimit(`smtp-test:${session.organizationId}`, readLimits().smtpTestPerHour, 3600, "Too many test emails. Please try again later.");
    if (limited) return limited;
    const config = await getEnabledSmtpConfigForOrg(session.organizationId);
    if (!config) {
      return NextResponse.json(
        { status: "FAILED", code: "NOT_CONFIGURED", message: "Save and enable an SMTP account first." },
        { status: 409 },
      );
    }
    const recipient = await getReportRecipientEmailForOrg(session.organizationId);
    if (!recipient) {
      return NextResponse.json(
        { status: "FAILED", code: "NO_RECIPIENT", message: "There is no report recipient to send the test to." },
        { status: 409 },
      );
    }

    try {
      await createTenantSmtpProvider({
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        password: config.password,
        fromAddress: config.fromAddress,
        fromName: config.fromName,
      }).send({
        to: recipient,
        subject: "Competitor Monitor — test email",
        text: "This is a test message from Competitor Monitor. Your SMTP settings work; daily reports will be sent from this account.",
        html: "<p>This is a test message from Competitor Monitor. Your SMTP settings work; daily reports will be sent from this account.</p>",
      });
      return NextResponse.json({ status: "SUCCESS", message: `Test email sent to ${recipient}.` });
    } catch (sendErr) {
      const failure = classifyEmailSendError(sendErr);
      return NextResponse.json({ status: "FAILED", code: failure.code, message: failure.message });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
