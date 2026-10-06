import { getOrganizationById, getReportRecipientEmailForOrg, getSmtpConnectionForOrg } from "@cma/db";
import { createEmailProviderFromEnv, isEmailProviderConfigured } from "@cma/notifications";
import { getSession } from "@/lib/currentSession";
import { NotificationSettingsForm } from "@/components/app/NotificationSettingsForm";
import { SmtpSettingsForm } from "@/components/app/SmtpSettingsForm";

export default async function NotificationSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  const [organization, effectiveRecipient, smtpConnection] = await Promise.all([
    getOrganizationById(session.organizationId),
    getReportRecipientEmailForOrg(session.organizationId),
    getSmtpConnectionForOrg(session.organizationId),
  ]);
  if (!organization) return null;

  // The owner's email, specifically - shown as the placeholder/fallback description,
  // distinct from `effectiveRecipient` which could already BE an override.
  const ownerEmail = organization.reportRecipientEmail ? null : effectiveRecipient;

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Notifications</h1>
        <p className="text-sm text-slate-500">Control who receives your daily competitor report, and in which timezone it's generated.</p>
      </div>

      <NotificationSettingsForm
        initial={{
          dailyReportEnabled: organization.dailyReportEnabled,
          reportRecipientEmail: organization.reportRecipientEmail,
          ownerEmail,
          timezone: organization.timezone,
        }}
      />

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
    </div>
  );
}
