import { getOrganizationById, getReportRecipientEmailForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { NotificationSettingsForm } from "@/components/app/NotificationSettingsForm";

export default async function NotificationSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  const [organization, effectiveRecipient] = await Promise.all([
    getOrganizationById(session.organizationId),
    getReportRecipientEmailForOrg(session.organizationId),
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
    </div>
  );
}
