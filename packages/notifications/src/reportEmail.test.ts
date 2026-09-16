import { describe, expect, it } from "vitest";
import { buildDailyReportEmail, type ReportEmailChangeInput } from "./reportEmail.js";

function change(overrides: Partial<ReportEmailChangeInput> = {}): ReportEmailChangeInput {
  return {
    changeEventId: "ce-1",
    competitorId: "c1",
    competitorName: "Competitor A",
    changeType: "PRICE_CHANGE",
    detectedAt: "2026-09-16T10:00:00Z",
    oldValue: "49",
    newValue: "59",
    currency: "€",
    percentageChange: 20.41,
    monitoredUrlLabel: "Pricing page",
    aiSummary: null,
    aiConfidence: null,
    ...overrides,
  };
}

describe("buildDailyReportEmail", () => {
  it("builds a subject with the report date", () => {
    const email = buildDailyReportEmail({
      organizationName: "Acme Inc",
      reportDateLabel: "16 September 2026",
      competitorCount: 5,
      competitorsWithChangesCount: 1,
      changes: [change()],
      webReportUrl: "https://app.example.test/reports/r1",
      recipientEmail: "owner@example.test",
    });

    expect(email.subject).toBe("Competitor Update — 16 September 2026");
    expect(email.to).toBe("owner@example.test");
  });

  it("leads with the deterministic fact and shows the AI summary when present (Section 18)", () => {
    const email = buildDailyReportEmail({
      organizationName: "Acme Inc",
      reportDateLabel: "16 September 2026",
      competitorCount: 1,
      competitorsWithChangesCount: 1,
      changes: [change({ aiSummary: "The competitor raised its Pro plan price." })],
      webReportUrl: "https://app.example.test/reports/r1",
      recipientEmail: "owner@example.test",
    });

    expect(email.text).toContain("Price changed from €49 to €59 (+20.41%)");
    expect(email.text).toContain("AI interpretation: The competitor raised its Pro plan price.");
    expect(email.html).toContain("Price changed from €49 to €59 (+20.41%)");
  });

  it("shows 'AI interpretation unavailable' rather than omitting the change when aiSummary is null (Section 7/8)", () => {
    const email = buildDailyReportEmail({
      organizationName: "Acme Inc",
      reportDateLabel: "16 September 2026",
      competitorCount: 1,
      competitorsWithChangesCount: 1,
      changes: [change({ aiSummary: null })],
      webReportUrl: "https://app.example.test/reports/r1",
      recipientEmail: "owner@example.test",
    });

    expect(email.text).toContain("Price changed from €49 to €59 (+20.41%)");
    expect(email.text).toContain("AI interpretation unavailable.");
  });

  it("renders 'no verified changes' content, without any per-change section, when the change list is empty (Section 21)", () => {
    const email = buildDailyReportEmail({
      organizationName: "Acme Inc",
      reportDateLabel: "16 September 2026",
      competitorCount: 5,
      competitorsWithChangesCount: 0,
      changes: [],
      webReportUrl: "https://app.example.test/reports/r1",
      recipientEmail: "owner@example.test",
    });

    expect(email.text).toContain("No verified competitor changes detected.");
    expect(email.html).toContain("No verified competitor changes detected.");
  });

  it("groups multiple competitors deterministically (delegates to @cma/core's groupChangesByCompetitor)", () => {
    const email = buildDailyReportEmail({
      organizationName: "Acme Inc",
      reportDateLabel: "16 September 2026",
      competitorCount: 2,
      competitorsWithChangesCount: 2,
      changes: [
        change({ competitorId: "c2", competitorName: "Zeta Corp" }),
        change({ competitorId: "c1", competitorName: "Alpha Corp" }),
      ],
      webReportUrl: "https://app.example.test/reports/r1",
      recipientEmail: "owner@example.test",
    });

    const alphaIndex = email.text.indexOf("ALPHA CORP");
    const zetaIndex = email.text.indexOf("ZETA CORP");
    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(alphaIndex).toBeLessThan(zetaIndex);
  });

  it("includes a link to the web report, never any credential", () => {
    const email = buildDailyReportEmail({
      organizationName: "Acme Inc",
      reportDateLabel: "16 September 2026",
      competitorCount: 1,
      competitorsWithChangesCount: 1,
      changes: [change()],
      webReportUrl: "https://app.example.test/reports/r1",
      recipientEmail: "owner@example.test",
    });

    expect(email.text).toContain("https://app.example.test/reports/r1");
    expect(email.html).toContain("https://app.example.test/reports/r1");
    expect(email.text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(email.html).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("escapes HTML in AI-provided text so the email body can never inject markup", () => {
    const email = buildDailyReportEmail({
      organizationName: "Acme Inc",
      reportDateLabel: "16 September 2026",
      competitorCount: 1,
      competitorsWithChangesCount: 1,
      changes: [change({ aiSummary: "<script>alert(1)</script>" })],
      webReportUrl: "https://app.example.test/reports/r1",
      recipientEmail: "owner@example.test",
    });

    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
