import { resolveOrgLocalDayWindow } from "@cma/core";
import * as db from "@cma/db";
import type { DailyReportJobPayload } from "@cma/queue";
import { buildDailyReportEmail, createEmailProviderFromEnv, createTenantSmtpProvider, isEmailProviderConfigured, type EmailProvider, type ReportEmailChangeInput } from "@cma/notifications";

interface ChangeEventForEmailLike {
  id: string;
  changeType: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  detectedAt: Date;
  monitoredUrl: { label: string | null; competitorId: string; competitor: { id: string; name: string } };
  aiAnalysis: { status: string; summary: string | null; confidence: string | null } | null;
}

function toReportEmailChangeInput(event: ChangeEventForEmailLike): ReportEmailChangeInput {
  return {
    changeEventId: event.id,
    competitorId: event.monitoredUrl.competitor.id,
    competitorName: event.monitoredUrl.competitor.name,
    changeType: event.changeType,
    detectedAt: event.detectedAt,
    oldValue: event.oldValue,
    newValue: event.newValue,
    currency: event.currency,
    percentageChange: event.percentageChange,
    monitoredUrlLabel: event.monitoredUrl.label,
    // Section 7/8: AI is enrichment - only a COMPLETED analysis's summary is ever shown; a
    // missing or FAILED analysis renders no AI line at all (see buildDailyReportEmail).
    aiSummary: event.aiAnalysis?.status === "COMPLETED" ? (event.aiAnalysis.summary ?? null) : null,
    aiConfidence: event.aiAnalysis?.status === "COMPLETED" ? (event.aiAnalysis.confidence ?? null) : null,
  };
}

/** Renders a bare UTC-midnight "reportDate" marker as a human date label matching Section 1's example format: "16 September 2026". */
function formatReportDateLabel(reportDate: Date): string {
  return new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(reportDate);
}

export type ReportEmailOutcome = "SENT" | "FAILED" | "SKIPPED_ALREADY_SENT" | "SKIPPED_NO_RECIPIENT" | "SKIPPED_NOT_CONFIGURED";

export interface GenerateDailyReportResult {
  reportId: string;
  status: "COMPLETED" | "FAILED";
  changeCount: number;
  emailOutcome: ReportEmailOutcome;
}

/**
 * Injectable collaborators, same rationale as pipeline.ts's PipelineDeps
 * and aiPipeline.ts's AiAnalysisDeps: unit tested with fake db functions
 * and a fake EmailProvider, never against a live Postgres or a real
 * network call. Production code only ever uses
 * createDefaultReportPipelineDeps().
 */
export interface ReportPipelineDeps {
  getOrCreateReportPeriod: typeof db.getOrCreateReportPeriod;
  countActiveCompetitorsForOrg: typeof db.countActiveCompetitorsForOrg;
  listChangeEventsForReportWindow: typeof db.listChangeEventsForReportWindow;
  finalizeReport: typeof db.finalizeReport;
  markReportFailed: typeof db.markReportFailed;
  getReportWithItemsForOrg: typeof db.getReportWithItemsForOrg;
  getReportRecipientEmailForOrg: typeof db.getReportRecipientEmailForOrg;
  reserveReportEmailNotification: typeof db.reserveReportEmailNotification;
  markReportEmailSent: typeof db.markReportEmailSent;
  markReportEmailFailed: typeof db.markReportEmailFailed;
  getOrganizationById: typeof db.getOrganizationById;
  /** Stopped or stale sources, shown in the email as "Sources needing attention" (Phase 29 B4). */
  listSourcesNeedingAttention: typeof db.listSourcesNeedingAttention;
  /** The operator's default delivery (env). Used when the organization has no SMTP connection of its own. */
  emailProvider: EmailProvider;
  /** The organization's own SMTP account, if it configured and enabled one (A2b). */
  getEnabledSmtpConfigForOrg: typeof db.getEnabledSmtpConfigForOrg;
  createTenantEmailProvider: (config: db.DecryptedSmtpConfig) => EmailProvider;
  /** Base URL for the authenticated web app - used to build the "View full report" link (Section 15). */
  webAppBaseUrl: string;
}

export function createDefaultReportPipelineDeps(): ReportPipelineDeps {
  return {
    getOrCreateReportPeriod: db.getOrCreateReportPeriod,
    countActiveCompetitorsForOrg: db.countActiveCompetitorsForOrg,
    listChangeEventsForReportWindow: db.listChangeEventsForReportWindow,
    finalizeReport: db.finalizeReport,
    markReportFailed: db.markReportFailed,
    getReportWithItemsForOrg: db.getReportWithItemsForOrg,
    getReportRecipientEmailForOrg: db.getReportRecipientEmailForOrg,
    reserveReportEmailNotification: db.reserveReportEmailNotification,
    markReportEmailSent: db.markReportEmailSent,
    markReportEmailFailed: db.markReportEmailFailed,
    getOrganizationById: db.getOrganizationById,
    listSourcesNeedingAttention: db.listSourcesNeedingAttention,
    emailProvider: createEmailProviderFromEnv(),
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
    webAppBaseUrl: process.env["WEB_APP_BASE_URL"] ?? "http://localhost:3000",
  };
}

/**
 * Section 9's write step: aggregates verified ChangeEvents in the
 * organization-local window into the Report row. Only runs the actual
 * aggregation query when the period is not already COMPLETED - Section
 * 9's idempotency requirement ("running it twice must not duplicate
 * report items") is satisfied at two layers: this status check (skip
 * the work entirely for an already-finished report) AND
 * finalizeReport's own `skipDuplicates` createMany (belt-and-suspenders
 * if this function is ever called again for a COMPLETED-but-stale read).
 */
async function ensureReportGenerated(
  payload: DailyReportJobPayload,
  period: { id: string; status: string; changeCount: number },
  deps: ReportPipelineDeps,
): Promise<{ status: "COMPLETED" | "FAILED"; changeCount: number }> {
  if (period.status === "COMPLETED") {
    return { status: "COMPLETED", changeCount: period.changeCount };
  }

  const window = resolveOrgLocalDayWindow(payload.reportDate, payload.timezone);
  try {
    const [competitorCount, changeEvents] = await Promise.all([
      deps.countActiveCompetitorsForOrg(payload.organizationId),
      deps.listChangeEventsForReportWindow(payload.organizationId, window.startUtc, window.endUtc),
    ]);

    // Section 1: "N competitors changed" - distinct competitors among the verified changes, not a count of change rows.
    const competitorsWithChangesCount = new Set(changeEvents.map((e) => e.monitoredUrl.competitorId)).size;

    const completed = await deps.finalizeReport(period.id, {
      organizationId: payload.organizationId,
      competitorCount,
      competitorsWithChangesCount,
      changeEventIds: changeEvents.map((e) => e.id),
    });

    return { status: "COMPLETED", changeCount: completed.changeCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort, same pattern as pipeline.ts/aiPipeline.ts: if even this update fails, the
    // original error is still what's thrown below for BullMQ's retry/backoff to see.
    await deps.markReportFailed(period.id, message).catch(() => undefined);
    throw err;
  }
}

/**
 * Section 15/16/17: attempts to deliver the report by email, fully
 * isolated from report generation - a missing recipient, a disabled
 * mailer, or a thrown send() NEVER marks the Report itself as FAILED and
 * NEVER causes generateDailyReportJob to throw (Section 17: "email
 * failure isolated"). Section 16's idempotency is enforced by
 * reserveReportEmailNotification's unique-constraint reservation before
 * any send is attempted - a job retried after a crash mid-send re-enters
 * here, sees `alreadySent` only if a PRIOR attempt actually completed
 * `markReportEmailSent`, and otherwise safely retries the send.
 */
async function attemptReportEmailDelivery(
  organizationId: string,
  reportId: string,
  deps: ReportPipelineDeps,
): Promise<ReportEmailOutcome> {
  // No delivery channel configured: nothing can leave the machine, so no
  // NotificationLog row is written and the report is never recorded as SENT.
  // The report itself stays fully available in the web app.
  // An organization's own SMTP account wins over the operator's default.
  const orgSmtp = await deps.getEnabledSmtpConfigForOrg(organizationId);
  const emailProvider = orgSmtp ? deps.createTenantEmailProvider(orgSmtp) : deps.emailProvider;
  if (!isEmailProviderConfigured(emailProvider)) return "SKIPPED_NOT_CONFIGURED";

  const recipient = await deps.getReportRecipientEmailForOrg(organizationId);
  if (!recipient) return "SKIPPED_NO_RECIPIENT";

  const reservation = await deps.reserveReportEmailNotification(organizationId, reportId, recipient);
  if (reservation.alreadySent) return "SKIPPED_ALREADY_SENT";

  try {
    const reportWithItems = await deps.getReportWithItemsForOrg(organizationId, reportId);
    const organization = await deps.getOrganizationById(organizationId);
    // A failure to compute the alerts must never stop the report from being delivered.
    const sourceAlerts = await deps.listSourcesNeedingAttention(organizationId).catch(() => []);

    const email = buildDailyReportEmail({
      organizationName: organization?.name ?? "Your organization",
      reportDateLabel: formatReportDateLabel(reportWithItems.reportDate),
      competitorCount: reportWithItems.competitorCount,
      competitorsWithChangesCount: reportWithItems.competitorsWithChangesCount,
      changes: reportWithItems.items.map((item) => toReportEmailChangeInput(item.changeEvent)),
      sourceAlerts: sourceAlerts.map((a) => ({ competitorName: a.competitorName, label: a.label, url: a.url, state: a.state, reason: a.reason })),
      webReportUrl: `${deps.webAppBaseUrl}/reports/${reportId}`,
      recipientEmail: recipient,
    });

    await emailProvider.send(email);
    await deps.markReportEmailSent(reservation.log.id);
    return "SENT";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.markReportEmailFailed(reservation.log.id, message).catch(() => undefined);
    return "FAILED";
  }
}

/**
 * The Phase 4 pipeline: resolve the organization-local reporting window
 * -> aggregate verified ChangeEvents (deterministic, Section 6) ->
 * persist the Report + ReportItems (Section 9) -> attempt email
 * delivery (Section 15-17, fully isolated from the report's own
 * validity). Never re-crawls, never calls a website, and never triggers
 * a second AI analysis for an already-analyzed ChangeEvent (Section 28) -
 * this function ONLY reads what monitoring + AI analysis already
 * persisted.
 */
export async function generateDailyReportJob(
  payload: DailyReportJobPayload,
  deps: ReportPipelineDeps = createDefaultReportPipelineDeps(),
): Promise<GenerateDailyReportResult> {
  const period = await deps.getOrCreateReportPeriod(payload.organizationId, payload.reportDate, payload.timezone);
  const generated = await ensureReportGenerated(payload, period, deps);
  const emailOutcome = await attemptReportEmailDelivery(payload.organizationId, period.id, deps);

  return { reportId: period.id, status: generated.status, changeCount: generated.changeCount, emailOutcome };
}
