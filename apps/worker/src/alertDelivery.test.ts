import { describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@cma/notifications";
import { deliverAlertEmails, type AlertDeliveryDeps } from "./alertDelivery.js";

const now = new Date("2026-10-16T12:00:00Z");
const alert = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  level: "IMPORTANT",
  status: "OPEN",
  title: `Rival: ${id} price increased`,
  explanation: `Rule matched for ${id}.`,
  importance: 72,
  confidence: 0.9,
  occurrences: 1,
  competitorName: "Rival",
  url: "https://rival.test/pricing",
  ...overrides,
});

function makeDeps(overrides: Partial<AlertDeliveryDeps> = {}, provider?: Partial<EmailProvider>): { deps: AlertDeliveryDeps; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue({});
  const emailProvider = { name: "fake", send, ...provider } as EmailProvider;
  const deps = {
    getAlertEmailSettings: vi.fn().mockResolvedValue({ enabled: true, minLevel: "IMPORTANT", organizationName: "Acme" }),
    listAlerts: vi.fn().mockResolvedValue([alert("a1")]),
    listAlertDeliveries: vi.fn().mockResolvedValue([]),
    getAlertEmailActivity: vi.fn().mockResolvedValue({ lastEmailAt: null, emailsInLastHour: 0 }),
    reserveAlertDeliveries: vi.fn().mockImplementation(async (_org: string, _to: string, items: { alertId: string; level: string }[]) => items.map((i, n) => ({ id: `d${n}`, ...i }))),
    markAlertDeliveriesSent: vi.fn().mockResolvedValue(undefined),
    markAlertDeliveriesFailed: vi.fn().mockResolvedValue(undefined),
    getReportRecipientEmailForOrg: vi.fn().mockResolvedValue("owner@acme.test"),
    getEnabledSmtpConfigForOrg: vi.fn().mockResolvedValue(null),
    createTenantEmailProvider: vi.fn(),
    emailProvider,
    webAppBaseUrl: "https://app.test",
    now: () => now,
    ...overrides,
  } as unknown as AlertDeliveryDeps;
  return { deps, send };
}

describe("deliverAlertEmails (Phase 29 D5b)", () => {
  it("reserves, sends one email with the alert's own explanation, then records it as sent", async () => {
    const order: string[] = [];
    const { deps, send } = makeDeps({
      reserveAlertDeliveries: vi.fn().mockImplementation(async (_o: string, _t: string, items: { alertId: string; level: string }[]) => (order.push("reserve"), items.map((i, n) => ({ id: `d${n}`, ...i })))),
      markAlertDeliveriesSent: vi.fn().mockImplementation(async () => void order.push("sent")),
    });
    send.mockImplementation(async () => void order.push("send"));
    expect(await deliverAlertEmails("org-1", deps)).toBe("SENT");
    expect(order).toEqual(["reserve", "send", "sent"]);
    const message = send.mock.calls[0]![0];
    expect(message.to).toBe("owner@acme.test");
    expect(message.subject).toBe("[Important] Rival: a1 price increased");
    expect(message.text).toContain("Rule matched for a1.");
    expect(message.text).toContain("https://app.test/today");
    expect(deps.markAlertDeliveriesSent).toHaveBeenCalledWith(["d0"], now);
  });

  it("sends nothing and records nothing when alert emails are off, nothing is configured, or nobody would receive it", async () => {
    for (const [overrides, provider, outcome] of [
      [{ getAlertEmailSettings: vi.fn().mockResolvedValue({ enabled: false, minLevel: "IMPORTANT", organizationName: "Acme" }) }, undefined, "SKIPPED_DISABLED"],
      [{}, { configured: false }, "SKIPPED_NOT_CONFIGURED"],
      [{ getReportRecipientEmailForOrg: vi.fn().mockResolvedValue(null) }, undefined, "SKIPPED_NO_RECIPIENT"],
    ] as const) {
      const { deps, send } = makeDeps(overrides as Partial<AlertDeliveryDeps>, provider);
      expect(await deliverAlertEmails("org-1", deps)).toBe(outcome);
      expect(send).not.toHaveBeenCalled();
      expect(deps.reserveAlertDeliveries).not.toHaveBeenCalled();
    }
  });

  it("uses the organization's own SMTP account when it has one", async () => {
    const own = { name: "own", send: vi.fn().mockResolvedValue({}) };
    const { deps, send } = makeDeps({ getEnabledSmtpConfigForOrg: vi.fn().mockResolvedValue({ host: "smtp.acme.test" }), createTenantEmailProvider: vi.fn().mockReturnValue(own) });
    expect(await deliverAlertEmails("org-1", deps)).toBe("SENT");
    expect(own.send).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not email what was already sent, what is below the level, or what somebody already saw", async () => {
    const { deps, send } = makeDeps({
      listAlerts: vi.fn().mockResolvedValue([alert("sent"), alert("notice", { level: "NOTICE" })]),
      listAlertDeliveries: vi.fn().mockResolvedValue([{ alertId: "sent", levelSent: "IMPORTANT", status: "SENT", createdAt: new Date("2026-10-16T08:00:00Z") }]),
    });
    expect(await deliverAlertEmails("org-1", deps)).toBe("SKIPPED_NOTHING_TO_SEND");
    expect(send).not.toHaveBeenCalled();
  });

  it("marks the attempts as failed, and does not throw, when sending fails", async () => {
    const { deps, send } = makeDeps();
    send.mockRejectedValue(new Error("smtp down"));
    expect(await deliverAlertEmails("org-1", deps)).toBe("FAILED");
    expect(deps.markAlertDeliveriesFailed).toHaveBeenCalledWith(["d0"], "smtp down");
    expect(deps.markAlertDeliveriesSent).not.toHaveBeenCalled();
  });

  it("does not throw even when the database does, and leaves a race to the run that won it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = makeDeps({ listAlerts: vi.fn().mockRejectedValue(new Error("db gone")) });
    await expect(deliverAlertEmails("org-1", broken.deps)).resolves.toBe("FAILED");
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    const raced = makeDeps({ reserveAlertDeliveries: vi.fn().mockResolvedValue([]) });
    expect(await deliverAlertEmails("org-1", raced.deps)).toBe("SKIPPED_RACE");
    expect(raced.send).not.toHaveBeenCalled();
  });

  it("waits for the gap between emails, but sends an urgent alert straight away", async () => {
    const activity = { getAlertEmailActivity: vi.fn().mockResolvedValue({ lastEmailAt: new Date(now.getTime() - 5 * 60_000), emailsInLastHour: 1 }) };
    const waits = makeDeps(activity);
    expect(await deliverAlertEmails("org-1", waits.deps)).toBe("SKIPPED_NOTHING_TO_SEND");
    const urgent = makeDeps({ ...activity, listAlerts: vi.fn().mockResolvedValue([alert("u1", { level: "URGENT" })]) });
    expect(await deliverAlertEmails("org-1", urgent.deps)).toBe("SENT");
  });

  it("re-sends an alert that became more urgent since it was emailed, marked as such", async () => {
    const { deps, send } = makeDeps({
      listAlerts: vi.fn().mockResolvedValue([alert("a1", { level: "URGENT", occurrences: 2 })]),
      listAlertDeliveries: vi.fn().mockResolvedValue([{ alertId: "a1", levelSent: "IMPORTANT", status: "SENT", createdAt: new Date("2026-10-15T10:00:00Z") }]),
    });
    expect(await deliverAlertEmails("org-1", deps)).toBe("SENT");
    expect(send.mock.calls[0]![0].subject).toBe("[Urgent] Now more urgent: Rival: a1 price increased");
  });
});
