import { describe, expect, it } from "vitest";
import { buildAlertEmail, type AlertEmailItem } from "./alertEmail.js";

const item = (overrides: Partial<AlertEmailItem> = {}): AlertEmailItem => ({
  level: "URGENT",
  title: "Alpha: Pro: price increased",
  explanation: 'Rule "Very large price change" matched: importance 91 (at least 80 needed) and confidence 90% (at least 70% needed). What happened: Price changed from EUR49.00 to EUR72.00 (+46.94%).',
  importance: 91,
  confidence: 0.9,
  competitorName: "Alpha",
  url: "https://alpha.example.test/pricing",
  occurrences: 1,
  upgraded: false,
  ...overrides,
});
const build = (alerts: AlertEmailItem[]) => buildAlertEmail({ organizationName: "Acme", alerts, todayUrl: "https://app.test/today", recipientEmail: "owner@acme.test" });

describe("buildAlertEmail (Phase 29 D5b)", () => {
  it("says what the alert says on the Today page: the level, the numbers, the explanation and the page", () => {
    const email = build([item()]);
    expect(email.to).toBe("owner@acme.test");
    expect(email.subject).toBe("[Urgent] Alpha: Pro: price increased");
    for (const part of ["Acme: 1 competitor alert", "[Urgent] Alpha: Pro: price increased", "Importance 91/100, confidence 90%", "Rule \"Very large price change\" matched", "https://alpha.example.test/pricing", "https://app.test/today"]) {
      expect(email.text).toContain(part);
    }
    expect(email.html).toContain("Importance 91/100");
    expect(email.html).toContain("See every alert and how it was scored");
  });

  it("puts several alerts in one email and leads the subject with the most urgent", () => {
    const email = build([item({ level: "IMPORTANT", title: "Beta: Starter: price increased", importance: 74 }), item()]);
    expect(email.subject).toBe("[Urgent] Alpha: Pro: price increased (+1 more)");
    expect(email.text).toContain("Acme: 2 competitor alerts");
    expect(email.text.indexOf("Beta: Starter")).toBeGreaterThan(-1);
  });

  it("marks an alert that became more urgent, and a repeated one", () => {
    const email = build([item({ upgraded: true, occurrences: 3 })]);
    expect(email.subject).toBe("[Urgent] Now more urgent: Alpha: Pro: price increased");
    expect(email.text).toContain("(now more urgent)");
    expect(email.text).toContain("seen 3 times");
  });

  it("escapes everything that comes from a competitor's page in the HTML", () => {
    const email = build([item({ title: "Evil <script>alert(1)</script>", explanation: 'x "quoted" & <b>bold</b>', url: 'https://x.test/?a="1"&b=<2>' })]);
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>bold</b>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("x &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(email.html).toContain("a=&quot;1&quot;&amp;b=&lt;2&gt;");
  });

  it("tells the reader how to change or stop these emails, and carries no credentials", () => {
    const email = build([item()]);
    expect(email.text).toContain("Settings > Notifications");
    expect(email.html).not.toMatch(/password|token|secret/i);
  });
});
