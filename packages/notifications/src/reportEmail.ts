import { describeChangeEvent, groupChangesByCompetitor, type ReportChangeSummary } from "@cma/core";
import type { EmailMessage } from "./emailProvider.js";

/**
 * Phase 4 (Section 15/19): everything this function needs to build an
 * email, already computed/persisted by report generation - it makes NO
 * additional AI call (Section 15: "must not depend on a second AI
 * generation call") and invents nothing: every sentence below is either
 * a literal deterministic fact (via describeChangeEvent, Section 18) or
 * an already-persisted AI summary, never generated here.
 */
export interface ReportEmailChangeInput extends ReportChangeSummary {
  changeEventId: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  monitoredUrlLabel: string | null;
  /** null when AiAnalysis is missing/FAILED - Section 7/8: the deterministic fact still renders regardless. */
  aiSummary: string | null;
  aiConfidence: string | null;
}

export interface BuildReportEmailInput {
  organizationName: string;
  /** Human-formatted date, e.g. "16 September 2026" - already localized by the caller. */
  reportDateLabel: string;
  competitorCount: number;
  competitorsWithChangesCount: number;
  changes: ReportEmailChangeInput[];
  /** Absolute URL to the authenticated web report - Section 15: the email links to it, never embeds credentials. */
  webReportUrl: string;
  recipientEmail: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildDailyReportEmail(input: BuildReportEmailInput): EmailMessage {
  const subject = `Competitor Update — ${input.reportDateLabel}`;
  const groups = groupChangesByCompetitor(input.changes);

  const textLines: string[] = [
    `Competitor Update — ${input.reportDateLabel}`,
    "",
    `${input.competitorCount} competitor${input.competitorCount === 1 ? "" : "s"} monitored`,
    `${input.competitorsWithChangesCount} competitor${input.competitorsWithChangesCount === 1 ? "" : "s"} changed`,
    `${input.changes.length} change${input.changes.length === 1 ? "" : "s"} detected`,
    "",
  ];

  const htmlSections: string[] = [];

  if (groups.length === 0) {
    textLines.push("No verified competitor changes detected.");
    htmlSections.push(`<p>No verified competitor changes detected.</p>`);
  } else {
    for (const group of groups) {
      textLines.push(group.competitorName.toUpperCase(), "");
      const rows: string[] = [];
      for (const change of group.changes) {
        // Section 18: the deterministic fact leads, on its own line.
        textLines.push(describeChangeEvent(change));
        if (change.aiSummary) {
          textLines.push(`AI interpretation: ${change.aiSummary}`);
        } else {
          textLines.push("AI interpretation unavailable.");
        }
        textLines.push("");

        rows.push(
          `<li><strong>${escapeHtml(describeChangeEvent(change))}</strong><br/>` +
            (change.aiSummary
              ? `<span>AI interpretation: ${escapeHtml(change.aiSummary)}</span>`
              : `<span style="color:#94a3b8">AI interpretation unavailable.</span>`) +
            `</li>`,
        );
      }
      htmlSections.push(`<h3>${escapeHtml(group.competitorName)}</h3><ul>${rows.join("")}</ul>`);
    }
  }

  textLines.push(`View full report: ${input.webReportUrl}`);

  const html = [
    `<div style="font-family:sans-serif;color:#0f172a">`,
    `<h2>Competitor Update — ${escapeHtml(input.reportDateLabel)}</h2>`,
    `<p>${input.competitorCount} competitor${input.competitorCount === 1 ? "" : "s"} monitored · ` +
      `${input.competitorsWithChangesCount} changed · ${input.changes.length} change${input.changes.length === 1 ? "" : "s"} detected</p>`,
    ...htmlSections,
    `<p><a href="${escapeHtml(input.webReportUrl)}">View full report</a></p>`,
    `</div>`,
  ].join("\n");

  return {
    to: input.recipientEmail,
    subject,
    text: textLines.join("\n"),
    html,
  };
}
