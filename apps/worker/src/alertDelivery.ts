import { planAlertEmail, type AlertLevel } from "@cma/core";
import * as db from "@cma/db";
import { buildAlertEmail, createEmailProviderFromEnv, createTenantSmtpProvider, isEmailProviderConfigured, type EmailProvider } from "@cma/notifications";

/**
 * Phase 29 D5b: emails the alerts that are ready. The rules (what goes out, when, how many per email) are the
 * pure `planAlertEmail` in `@cma/core`; this fetches what it needs, reserves the attempts, sends and records.
 *
 * Fully isolated from everything else: it never throws, so a mail problem can neither fail a scan nor stop the
 * scheduler. Nothing leaves the machine when no mail channel is configured, and nothing is recorded as sent
 * unless it was.
 */
export type AlertEmailOutcome =
  | "SENT"
  | "FAILED"
  | "SKIPPED_NOTHING_TO_SEND"
  | "SKIPPED_DISABLED"
  | "SKIPPED_NOT_CONFIGURED"
  | "SKIPPED_NO_RECIPIENT"
  | "SKIPPED_RACE";

export interface AlertDeliveryDeps {
  getAlertEmailSettings: typeof db.getAlertEmailSettings;
  listAlerts: typeof db.listAlerts;
  listAlertDeliveries: typeof db.listAlertDeliveries;
  getAlertEmailActivity: typeof db.getAlertEmailActivity;
  reserveAlertDeliveries: typeof db.reserveAlertDeliveries;
  markAlertDeliveriesSent: typeof db.markAlertDeliveriesSent;
  markAlertDeliveriesFailed: typeof db.markAlertDeliveriesFailed;
  getReportRecipientEmailForOrg: typeof db.getReportRecipientEmailForOrg;
  /** The organization's own SMTP account wins over the operator's default, as for the daily report. */
  getEnabledSmtpConfigForOrg: typeof db.getEnabledSmtpConfigForOrg;
  createTenantEmailProvider: (config: db.DecryptedSmtpConfig) => EmailProvider;
  emailProvider: EmailProvider;
  webAppBaseUrl: string;
  now: () => Date;
}

export function createDefaultAlertDeliveryDeps(): AlertDeliveryDeps {
  return {
    getAlertEmailSettings: db.getAlertEmailSettings,
    listAlerts: db.listAlerts,
    listAlertDeliveries: db.listAlertDeliveries,
    getAlertEmailActivity: db.getAlertEmailActivity,
    reserveAlertDeliveries: db.reserveAlertDeliveries,
    markAlertDeliveriesSent: db.markAlertDeliveriesSent,
    markAlertDeliveriesFailed: db.markAlertDeliveriesFailed,
    getReportRecipientEmailForOrg: db.getReportRecipientEmailForOrg,
    getEnabledSmtpConfigForOrg: db.getEnabledSmtpConfigForOrg,
    createTenantEmailProvider: (config) =>
      createTenantSmtpProvider({
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        password: config.password,
        fromAddress: config.fromAddress,
        fromName: config.fromName,
      }),
    emailProvider: createEmailProviderFromEnv(),
    webAppBaseUrl: process.env["WEB_APP_BASE_URL"] ?? "http://localhost:3000",
    now: () => new Date(),
  };
}

export async function deliverAlertEmails(organizationId: string, deps: AlertDeliveryDeps = createDefaultAlertDeliveryDeps()): Promise<AlertEmailOutcome> {
  try {
    const settings = await deps.getAlertEmailSettings(organizationId);
    if (!settings || !settings.enabled) return "SKIPPED_DISABLED";

    // No channel: nothing can leave, so nothing is reserved or recorded. The alerts stay on the Today page.
    const orgSmtp = await deps.getEnabledSmtpConfigForOrg(organizationId);
    const provider = orgSmtp ? deps.createTenantEmailProvider(orgSmtp) : deps.emailProvider;
    if (!isEmailProviderConfigured(provider)) return "SKIPPED_NOT_CONFIGURED";

    const recipient = await deps.getReportRecipientEmailForOrg(organizationId);
    if (!recipient) return "SKIPPED_NO_RECIPIENT";

    const now = deps.now();
    const alerts = await deps.listAlerts(organizationId, { status: "OPEN", limit: 100 });
    const [deliveries, activity] = await Promise.all([
      deps.listAlertDeliveries(organizationId, recipient, alerts.map((a) => a.id)),
      deps.getAlertEmailActivity(organizationId, now),
    ]);
    const plan = planAlertEmail({
      enabled: settings.enabled,
      minLevel: settings.minLevel,
      alerts: alerts.map((a) => ({ id: a.id, level: a.level, status: a.status, importance: a.importance, occurrences: a.occurrences })),
      deliveries,
      lastEmailAt: activity.lastEmailAt,
      emailsInLastHour: activity.emailsInLastHour,
      now,
    });
    if (!plan.send) return "SKIPPED_NOTHING_TO_SEND";

    const reserved = await deps.reserveAlertDeliveries(
      organizationId,
      recipient,
      plan.alerts.map((a) => ({ alertId: a.alertId, level: a.level as AlertLevel })),
    );
    if (reserved.length === 0) return "SKIPPED_RACE";

    const byId = new Map(alerts.map((a) => [a.id, a]));
    const upgraded = new Map(plan.alerts.map((a) => [a.alertId, a.upgraded]));
    const reservedIds = reserved.map((r) => r.id);
    try {
      const email = buildAlertEmail({
        organizationName: settings.organizationName,
        recipientEmail: recipient,
        todayUrl: `${deps.webAppBaseUrl}/today`,
        alerts: reserved.map((r) => {
          const alert = byId.get(r.alertId)!;
          return {
            level: alert.level,
            title: alert.title,
            explanation: alert.explanation,
            importance: alert.importance,
            confidence: alert.confidence,
            competitorName: alert.competitorName,
            url: alert.url,
            occurrences: alert.occurrences,
            upgraded: upgraded.get(r.alertId) ?? false,
          };
        }),
      });
      await provider.send(email);
      await deps.markAlertDeliveriesSent(reservedIds, now);
      return "SENT";
    } catch (error) {
      await deps.markAlertDeliveriesFailed(reservedIds, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      return "FAILED";
    }
  } catch (error) {
    console.error("[alerts] delivering alert emails failed:", error instanceof Error ? error.message : error);
    return "FAILED";
  }
}
