import { alertEmailSubject, type AlertLevel } from "@cma/core";
import type { EmailMessage } from "./emailProvider.js";

/**
 * Phase 29 D5b: the email for one or more alerts. It says exactly what the alert says on the Today page, with
 * the same explanation (the rule that matched and its numbers, the strongest reasons, the evidence behind it),
 * and links to the page for the full breakdown. Nothing here is written by a model or invented: every sentence
 * is the alert's own stored text.
 */
export interface AlertEmailItem {
  level: AlertLevel;
  title: string;
  explanation: string;
  importance: number;
  confidence: number;
  competitorName: string;
  /** The page that changed, so the reader can open it. */
  url: string;
  occurrences: number;
  /** Emailed before at a lower level and now more urgent. */
  upgraded: boolean;
}

export interface BuildAlertEmailInput {
  organizationName: string;
  alerts: AlertEmailItem[];
  /** Absolute link to the Today page of the authenticated web app; never carries credentials. */
  todayUrl: string;
  recipientEmail: string;
}

const LEVEL_LABEL: Record<AlertLevel, string> = { URGENT: "Urgent", IMPORTANT: "Important", NOTICE: "Notice" };
const LEVEL_COLOR: Record<AlertLevel, string> = { URGENT: "#b91c1c", IMPORTANT: "#b45309", NOTICE: "#1d4ed8" };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function buildAlertEmail(input: BuildAlertEmailInput): EmailMessage {
  const subject = alertEmailSubject(input.alerts);
  const count = input.alerts.length;

  const text = [
    `${input.organizationName}: ${count} competitor alert${count === 1 ? "" : "s"}`,
    "",
    ...input.alerts.flatMap((a) => [
      `[${LEVEL_LABEL[a.level]}] ${a.upgraded ? "(now more urgent) " : ""}${a.title}`,
      `Importance ${a.importance}/100, confidence ${pct(a.confidence)}${a.occurrences > 1 ? `, seen ${a.occurrences} times` : ""}`,
      a.explanation,
      `Page: ${a.url}`,
      "",
    ]),
    `See every alert, with the evidence and how each was scored: ${input.todayUrl}`,
    "",
    "You are receiving this because alert emails are on for your organization. You can change the level or turn them off in Settings > Notifications.",
  ].join("\n");

  const items = input.alerts
    .map(
      (a) => `
    <div style="margin:0 0 20px;padding:14px 16px;border:1px solid #e2e8f0;border-left:4px solid ${LEVEL_COLOR[a.level]};border-radius:6px;">
      <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:${LEVEL_COLOR[a.level]};text-transform:uppercase;">${LEVEL_LABEL[a.level]}${a.upgraded ? " &middot; now more urgent" : ""}</p>
      <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#0f172a;">${escapeHtml(a.title)}</p>
      <p style="margin:0 0 8px;font-size:12px;color:#64748b;">Importance ${a.importance}/100 &middot; confidence ${pct(a.confidence)}${a.occurrences > 1 ? ` &middot; seen ${a.occurrences} times` : ""}</p>
      <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#334155;">${escapeHtml(a.explanation)}</p>
      <p style="margin:0;font-size:12px;"><a href="${escapeHtml(a.url)}" style="color:#4338ca;">${escapeHtml(a.url)}</a></p>
    </div>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px;">
    <h1 style="margin:0 0 16px;font-size:18px;color:#0f172a;">${escapeHtml(input.organizationName)}: ${count} competitor alert${count === 1 ? "" : "s"}</h1>${items}
    <p style="margin:16px 0 0;"><a href="${escapeHtml(input.todayUrl)}" style="display:inline-block;padding:10px 16px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">See every alert and how it was scored</a></p>
    <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;">You are receiving this because alert emails are on for your organization. You can change the level or turn them off in Settings &gt; Notifications.</p>
  </div>
</body></html>`;

  return { to: input.recipientEmail, subject, text, html };
}
