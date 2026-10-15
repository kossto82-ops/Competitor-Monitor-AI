import { can, whoCan } from "@cma/core";
import { getOrganizationById, getReportRecipientEmailForOrg, getSmtpConnectionForOrg } from "@cma/db";
import { createEmailProviderFromEnv, isEmailProviderConfigured } from "@cma/notifications";
import { getSession } from "@/lib/currentSession";
import { NotificationSettingsForm } from "@/components/app/NotificationSettingsForm";
import { SmtpSettingsForm } from "@/components/app/SmtpSettingsForm";
import { Alert } from "@/components/ui/Alert";

export default async function NotificationSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  const canSettings = can(session.role, "manage_org_settings");
  const canSmtp = can(session.role, "manage_smtp");
  const [organization, effectiveRecipient, smtpConnection] = await Promise.all([
    getOrganizationById(session.organizationId),
    getReportRecipientEmailForOrg(session.organizationId),
    canSmtp ? getSmtpConnectionForOrg(session.organizationId) : Promise.resolve(null),
  ]);
  if (!organization) return null;

  // The owner's email, specifically - shown as the placeholder/fallback description,
  // distinct from `effectiveRecipient` which could already BE an override.
  const ownerEmail = organization.reportRecipientEmail ? null : effectiveRecipient;

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Notifications</h1>
        <p className="text-sm text-slate-500">Control who receives your daily competitor report and your alert emails, and in which timezone the report is generated.</p>
      </div>

      {canSettings ? (
      <NotificationSettingsForm
        initial={{
          dailyReportEnabled: organization.dailyReportEnabled,
          alertEmailsEnabled: organization.alertEmailsEnabled,
          alertEmailMinLevel: organization.alertEmailMinLevel,
          reportRecipientEmail: organization.reportRecipientEmail,
          ownerEmail,
          timezone: organization.timezone,
        }}
      />
      ) : (
        <Alert tone="info">Only {whoCan("manage_org_settings")} can change who receives the reports and alert emails, and when. They are sent to {effectiveRecipient ?? "the account owner"}.</Alert>
      )}

      {canSmtp ? (
      <SmtpSettingsForm
        initial={
          smtpConnection
            ? {
                host: smtpConnection.host,
                port: smtpConnection.port,
                security: smtpConnection.security,
                username: smtpConnection.username,
                hasPassword: smtpConnection.hasPassword,
                fromAddress: smtpConnection.fromAddress,
                fromName: smtpConnection.fromName,
                enabled: smtpConnection.enabled,
              }
            : null
        }
        serverDefaultConfigured={isEmailProviderConfigured(createEmailProviderFromEnv())}
      />
      ) : (
        <Alert tone="info">Only {whoCan("manage_smtp")} can set up the mail account that sends them.</Alert>
      )}
    </div>
  );
}
