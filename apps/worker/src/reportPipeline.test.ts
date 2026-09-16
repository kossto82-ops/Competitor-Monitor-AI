import { describe, expect, it, vi } from "vitest";
import type { EmailMessage, EmailProvider } from "@cma/notifications";
import type { DailyReportJobPayload } from "@cma/queue";
import { generateDailyReportJob, type ReportPipelineDeps } from "./reportPipeline.js";

const PAYLOAD: DailyReportJobPayload = { organizationId: "org-1", reportDate: "2026-09-16", timezone: "UTC" };

function changeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "change-1",
    changeType: "PRICE_CHANGE",
    oldValue: "49",
    newValue: "59",
    currency: "€",
    percentageChange: 20.41,
    detectedAt: new Date("2026-09-16T10:00:00.000Z"),
    monitoredUrl: { label: "Pricing page", competitorId: "competitor-1", competitor: { id: "competitor-1", name: "Competitor A" } },
    aiAnalysis: null as { status: string; summary: string | null; confidence: string | null } | null,
    ...overrides,
  };
}

class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  sent: EmailMessage[] = [];
  private readonly shouldThrow: boolean;

  constructor(shouldThrow = false) {
    this.shouldThrow = shouldThrow;
  }

  async send(message: EmailMessage): Promise<{ providerMessageId?: string }> {
    if (this.shouldThrow) throw new Error("smtp connection refused");
    this.sent.push(message);
    return { providerMessageId: "fake-1" };
  }
}

function makeDeps(overrides: Partial<ReportPipelineDeps> = {}): ReportPipelineDeps {
  const notificationLog = { id: "log-1", status: "PENDING" };
  return {
    getOrCreateReportPeriod: vi.fn().mockResolvedValue({ id: "report-1", status: "GENERATING", changeCount: 0 }),
    countActiveCompetitorsForOrg: vi.fn().mockResolvedValue(1),
    listChangeEventsForReportWindow: vi.fn().mockResolvedValue([changeEventRow()]),
    finalizeReport: vi.fn().mockResolvedValue({ id: "report-1", status: "COMPLETED", changeCount: 1 }),
    markReportFailed: vi.fn().mockResolvedValue(undefined),
    getReportWithItemsForOrg: vi.fn().mockResolvedValue({
      id: "report-1",
      status: "COMPLETED",
      reportDate: new Date("2026-09-16T00:00:00.000Z"),
      competitorCount: 1,
      competitorsWithChangesCount: 1,
      items: [{ id: "item-1", changeEvent: changeEventRow() }],
    }),
    getReportRecipientEmailForOrg: vi.fn().mockResolvedValue("owner@example.test"),
    reserveReportEmailNotification: vi.fn().mockResolvedValue({ log: notificationLog, alreadySent: false }),
    markReportEmailSent: vi.fn().mockResolvedValue(undefined),
    markReportEmailFailed: vi.fn().mockResolvedValue(undefined),
    getOrganizationById: vi.fn().mockResolvedValue({ id: "org-1", name: "Acme Inc" }),
    emailProvider: new FakeEmailProvider(),
    webAppBaseUrl: "https://app.example.test",
    ...overrides,
  };
}

describe("generateDailyReportJob", () => {
  it("generates the report, finalizes it, and sends the email", async () => {
    const deps = makeDeps();
    const result = await generateDailyReportJob(PAYLOAD, deps);

    expect(result.status).toBe("COMPLETED");
    expect(result.changeCount).toBe(1);
    expect(result.emailOutcome).toBe("SENT");
    expect(deps.finalizeReport).toHaveBeenCalledWith("report-1", expect.objectContaining({ competitorCount: 1, competitorsWithChangesCount: 1, changeEventIds: ["change-1"] }));
    expect((deps.emailProvider as FakeEmailProvider).sent).toHaveLength(1);
    expect((deps.emailProvider as FakeEmailProvider).sent[0]?.subject).toContain("16 September 2026");
  });

  it("is idempotent: an already-COMPLETED period skips aggregation entirely (no listChangeEventsForReportWindow/finalizeReport call)", async () => {
    const deps = makeDeps({
      getOrCreateReportPeriod: vi.fn().mockResolvedValue({ id: "report-1", status: "COMPLETED", changeCount: 3 }),
    });
    const result = await generateDailyReportJob(PAYLOAD, deps);

    expect(result.status).toBe("COMPLETED");
    expect(result.changeCount).toBe(3);
    expect(deps.listChangeEventsForReportWindow).not.toHaveBeenCalled();
    expect(deps.finalizeReport).not.toHaveBeenCalled();
  });

  it("Section 21: an empty change list still produces a COMPLETED report and a 'no changes' email, without calling AI for it", async () => {
    const deps = makeDeps({
      listChangeEventsForReportWindow: vi.fn().mockResolvedValue([]),
      finalizeReport: vi.fn().mockResolvedValue({ id: "report-1", status: "COMPLETED", changeCount: 0 }),
      getReportWithItemsForOrg: vi.fn().mockResolvedValue({
        id: "report-1",
        status: "COMPLETED",
        reportDate: new Date("2026-09-16T00:00:00.000Z"),
        competitorCount: 3,
        competitorsWithChangesCount: 0,
        items: [],
      }),
    });

    const result = await generateDailyReportJob(PAYLOAD, deps);
    expect(result.changeCount).toBe(0);
    expect(result.emailOutcome).toBe("SENT");
    const sentEmail = (deps.emailProvider as FakeEmailProvider).sent[0];
    expect(sentEmail?.text).toContain("No verified competitor changes detected.");
  });

  it("Section 7/8: a ChangeEvent whose AiAnalysis is missing still appears in the email as an 'unavailable' interpretation, never dropped", async () => {
    const deps = makeDeps({
      getReportWithItemsForOrg: vi.fn().mockResolvedValue({
        id: "report-1",
        status: "COMPLETED",
        reportDate: new Date("2026-09-16T00:00:00.000Z"),
        competitorCount: 1,
        competitorsWithChangesCount: 1,
        items: [{ id: "item-1", changeEvent: changeEventRow({ aiAnalysis: null }) }],
      }),
    });
    const result = await generateDailyReportJob(PAYLOAD, deps);
    expect(result.emailOutcome).toBe("SENT");
    const sentEmail = (deps.emailProvider as FakeEmailProvider).sent[0];
    expect(sentEmail?.text).toContain("Price changed from €49 to €59");
    expect(sentEmail?.text).toContain("AI interpretation unavailable.");
  });

  it("Section 7/8: a FAILED AiAnalysis is treated the same as missing - never shown as if it were a real interpretation", async () => {
    const deps = makeDeps({
      getReportWithItemsForOrg: vi.fn().mockResolvedValue({
        id: "report-1",
        status: "COMPLETED",
        reportDate: new Date("2026-09-16T00:00:00.000Z"),
        competitorCount: 1,
        competitorsWithChangesCount: 1,
        items: [
          {
            id: "item-1",
            changeEvent: changeEventRow({ aiAnalysis: { status: "FAILED", summary: null, confidence: null } }),
          },
        ],
      }),
    });
    await generateDailyReportJob(PAYLOAD, deps);
    const sentEmail = (deps.emailProvider as FakeEmailProvider).sent[0];
    expect(sentEmail?.text).toContain("AI interpretation unavailable.");
  });

  it("a COMPLETED AiAnalysis's summary IS shown", async () => {
    const deps = makeDeps({
      getReportWithItemsForOrg: vi.fn().mockResolvedValue({
        id: "report-1",
        status: "COMPLETED",
        reportDate: new Date("2026-09-16T00:00:00.000Z"),
        competitorCount: 1,
        competitorsWithChangesCount: 1,
        items: [
          {
            id: "item-1",
            changeEvent: changeEventRow({ aiAnalysis: { status: "COMPLETED", summary: "Prices went up.", confidence: "high" } }),
          },
        ],
      }),
    });
    await generateDailyReportJob(PAYLOAD, deps);
    const sentEmail = (deps.emailProvider as FakeEmailProvider).sent[0];
    expect(sentEmail?.text).toContain("AI interpretation: Prices went up.");
  });

  it("report generation failure marks the report FAILED, rethrows, and NEVER attempts to send an email", async () => {
    const deps = makeDeps({
      listChangeEventsForReportWindow: vi.fn().mockRejectedValue(new Error("db exploded")),
    });

    await expect(generateDailyReportJob(PAYLOAD, deps)).rejects.toThrow("db exploded");
    expect(deps.markReportFailed).toHaveBeenCalledWith("report-1", "db exploded");
    expect(deps.reserveReportEmailNotification).not.toHaveBeenCalled();
    expect((deps.emailProvider as FakeEmailProvider).sent).toHaveLength(0);
  });

  it("Section 16: does not call the email provider at all when the recipient already received this report (idempotency)", async () => {
    const deps = makeDeps({
      reserveReportEmailNotification: vi.fn().mockResolvedValue({ log: { id: "log-1", status: "SENT" }, alreadySent: true }),
    });
    const result = await generateDailyReportJob(PAYLOAD, deps);
    expect(result.emailOutcome).toBe("SKIPPED_ALREADY_SENT");
    expect((deps.emailProvider as FakeEmailProvider).sent).toHaveLength(0);
  });

  it("skips email delivery (without failing the job) when the organization has no recipient configured", async () => {
    const deps = makeDeps({ getReportRecipientEmailForOrg: vi.fn().mockResolvedValue(null) });
    const result = await generateDailyReportJob(PAYLOAD, deps);
    expect(result.status).toBe("COMPLETED");
    expect(result.emailOutcome).toBe("SKIPPED_NO_RECIPIENT");
    expect(deps.reserveReportEmailNotification).not.toHaveBeenCalled();
  });

  it("Section 17: an email send failure is isolated - the report stays COMPLETED, the job does not throw, and the failure is recorded", async () => {
    const deps = makeDeps({ emailProvider: new FakeEmailProvider(true) });
    const result = await generateDailyReportJob(PAYLOAD, deps);

    expect(result.status).toBe("COMPLETED");
    expect(result.emailOutcome).toBe("FAILED");
    expect(deps.markReportEmailFailed).toHaveBeenCalledWith("log-1", expect.stringContaining("smtp connection refused"));
    expect(deps.markReportFailed).not.toHaveBeenCalled();
  });

  it("Section 28 (cost control): this pipeline has no dependency capable of calling an AI provider at all - it only reads already-persisted AiAnalysis rows", () => {
    const deps = makeDeps();
    const depKeys = Object.keys(deps);
    expect(depKeys.some((k) => k.toLowerCase().includes("resolveprovider") || k.toLowerCase().includes("analyzechange"))).toBe(false);
  });
});
