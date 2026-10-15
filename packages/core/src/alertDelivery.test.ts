import { describe, expect, it } from "vitest";
import { alertEmailSubject, ALERT_EMAIL_MAX_ALERTS_PER_EMAIL, ALERT_EMAIL_MAX_ATTEMPTS, ALERT_EMAIL_MAX_PER_HOUR, planAlertEmail, type AlertForDelivery, type PlanAlertEmailInput } from "./alertDelivery.js";

const now = new Date("2026-10-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const delivery = (alertId: string, levelSent: "URGENT" | "IMPORTANT" | "NOTICE", status: "PENDING" | "SENT" | "FAILED", createdAt: Date = minutesAgo(60)) => ({ alertId, levelSent, status, createdAt });
const alert = (id: string, overrides: Partial<AlertForDelivery> = {}): AlertForDelivery => ({ id, level: "IMPORTANT", status: "OPEN", importance: 70, occurrences: 1, ...overrides });
const plan = (overrides: Partial<PlanAlertEmailInput> = {}) =>
  planAlertEmail({ enabled: true, minLevel: "IMPORTANT", alerts: [alert("a1")], deliveries: [], lastEmailAt: null, emailsInLastHour: 0, now, ...overrides });

describe("planAlertEmail (Phase 29 D5b)", () => {
  it("sends a new important alert, and says so", () => {
    const result = plan();
    expect(result.send).toBe(true);
    expect(result.alerts).toEqual([{ alertId: "a1", level: "IMPORTANT", upgraded: false }]);
    expect(result.reason).toContain("1 alert in this email");
  });

  it("sends nothing when emails are off, or when nothing is waiting, and always gives a reason", () => {
    for (const result of [plan({ enabled: false }), plan({ alerts: [] }), plan({ alerts: [alert("a1", { level: "NOTICE" })] })]) {
      expect(result.send).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("follows the organization's minimum level", () => {
    expect(plan({ minLevel: "URGENT" }).send).toBe(false);
    expect(plan({ minLevel: "URGENT", alerts: [alert("a1", { level: "URGENT" })] }).send).toBe(true);
    expect(plan({ minLevel: "NOTICE", alerts: [alert("a1", { level: "NOTICE" })] }).send).toBe(true);
  });

  it("never emails an alert somebody already saw or dismissed", () => {
    expect(plan({ alerts: [alert("a1", { status: "ACKNOWLEDGED" })] }).send).toBe(false);
    expect(plan({ alerts: [alert("a1", { status: "DISMISSED" })] }).send).toBe(false);
  });

  it("emails an alert once per level: a repeat does not re-send, a rise to URGENT does and is marked as an upgrade", () => {
    const sent = [delivery("a1", "IMPORTANT", "SENT")];
    expect(plan({ deliveries: sent, alerts: [alert("a1", { occurrences: 5 })] }).send).toBe(false);
    const upgraded = plan({ deliveries: sent, alerts: [alert("a1", { level: "URGENT" })] });
    expect(upgraded.alerts).toEqual([{ alertId: "a1", level: "URGENT", upgraded: true }]);
    const higherAlreadySent = [delivery("a1", "URGENT", "SENT")];
    expect(plan({ deliveries: higherAlreadySent, alerts: [alert("a1")] }).send).toBe(false);
  });

  it("retries a failed delivery a limited number of times, then gives up", () => {
    const failed = (n: number) => Array.from({ length: n }, () => delivery("a1", "IMPORTANT", "FAILED"));
    expect(plan({ deliveries: failed(ALERT_EMAIL_MAX_ATTEMPTS - 1) }).send).toBe(true);
    expect(plan({ deliveries: failed(ALERT_EMAIL_MAX_ATTEMPTS) }).send).toBe(false);
  });

  it("waits for a delivery another run is still sending, and retries one that never finished", () => {
    expect(plan({ deliveries: [delivery("a1", "IMPORTANT", "PENDING", minutesAgo(1))] }).send).toBe(false);
    expect(plan({ deliveries: [delivery("a1", "IMPORTANT", "PENDING", minutesAgo(30))] }).send).toBe(true);
  });

  it("puts alerts that are ready together in one email, most urgent first", () => {
    const result = plan({ alerts: [alert("low", { importance: 66 }), alert("urgent", { level: "URGENT", importance: 90 }), alert("high", { importance: 80 })] });
    expect(result.alerts.map((a) => a.alertId)).toEqual(["urgent", "high", "low"]);
    expect(result.reason).toContain("3 alerts in this email");
  });

  it("makes important alerts wait for the gap between emails, but lets an urgent one through", () => {
    const recent = { lastEmailAt: minutesAgo(5) };
    const waits = plan(recent);
    expect(waits.send).toBe(false);
    expect(waits.reason).toContain("wait and go out together");
    expect(plan({ ...recent, alerts: [alert("a1", { level: "URGENT" })] }).send).toBe(true);
    expect(plan({ lastEmailAt: minutesAgo(20) }).send).toBe(true);
  });

  it("stops at the hourly cap, urgent or not", () => {
    const capped = plan({ emailsInLastHour: ALERT_EMAIL_MAX_PER_HOUR, alerts: [alert("a1", { level: "URGENT" })] });
    expect(capped.send).toBe(false);
    expect(capped.reason).toContain("per hour");
  });

  it("caps the alerts in one email and says how many are left", () => {
    const many = Array.from({ length: ALERT_EMAIL_MAX_ALERTS_PER_EMAIL + 5 }, (_, i) => alert(`a${i}`));
    const result = plan({ alerts: many });
    expect(result.alerts).toHaveLength(ALERT_EMAIL_MAX_ALERTS_PER_EMAIL);
    expect(result.reason).toContain("5 more go out next");
  });
});

describe("alertEmailSubject", () => {
  it("leads with the most urgent level and counts the rest", () => {
    expect(alertEmailSubject([{ level: "IMPORTANT", title: "B: Starter: price increased" }, { level: "URGENT", title: "A: Pro: price increased" }])).toBe("[Urgent] A: Pro: price increased (+1 more)");
    expect(alertEmailSubject([{ level: "IMPORTANT", title: "B: Plan added" }])).toBe("[Important] B: Plan added");
    expect(alertEmailSubject([{ level: "URGENT", title: "A: Pro: price increased", upgraded: true }])).toBe("[Urgent] Now more urgent: A: Pro: price increased");
    expect(alertEmailSubject([])).toBe("Competitor alert");
  });
});
