import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, type ComparisonResult, type ExtractedEntity, type ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { createRunningMonitoringJob, persistMonitoringResult } from "./monitoringPipeline.js";
import { getActiveAlertRules, InvalidAlertRulesError, listAlerts, raiseAlerts, replaceAlertRules, setAlertStatus } from "./alerts.js";

async function databaseIsReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();
const createdOrgIds: string[] = [];
const usage = { browserEscalated: false, aiCallMade: false };
type Draft = ComparisonResult["changeEvents"][number];

const plan = (key: string, label: string, value: string): ExtractedEntity => ({ type: "PRICE", key, label, value, currency: "EUR", raw: `${value} EUR` });
const priceEvent = (key: string, oldValue: string, newValue: string, percentageChange: number): Draft => ({
  changeType: "PRICE_CHANGE",
  severity: "MEDIUM",
  confidence: 0.9,
  entityKey: key,
  fieldPath: key,
  oldValue,
  newValue,
  currency: "EUR",
  percentageChange,
  evidenceExcerpt: "price changed",
});
const textEvent: Draft = {
  changeType: "CONTENT_CHANGE",
  severity: "LOW",
  confidence: 0.6,
  entityKey: null,
  fieldPath: "page.visibleText",
  oldValue: null,
  newValue: null,
  currency: null,
  percentageChange: null,
  evidenceExcerpt: "Changed text",
};

describe.skipIf(!reachable)("alerts (Phase 29 D4)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeSource(name = "Rival") {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Alerts ${runId}-${counter}`,
      email: `alerts-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name });
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: `https://alerts-${counter}.example.test/pricing`, category: "GENERAL" });
    return { organization, competitor, url };
  }
  async function scan(orgId: string, urlId: string, entities: ExtractedEntity[], state: ComparisonResult["verificationState"], events: Draft[]) {
    const job = await createRunningMonitoringJob(orgId, urlId);
    await persistMonitoringResult(job.id, {
      organizationId: orgId,
      monitoredUrlId: urlId,
      previousSnapshotId: null,
      extraction: {
        method: "CHEERIO",
        requestedUrl: "https://x.test/",
        finalUrl: "https://x.test/",
        httpStatus: 200,
        errorMessage: null,
        normalizedContent: "x",
        contentHash: "h",
        structuredDataHash: null,
        extractedEntities: entities,
        confidence: 1,
        warnings: [],
        durationMs: 1,
      } as ExtractionResult,
      comparison: { verificationState: state, changeEvents: events } as ComparisonResult,
      usage,
    });
  }
  async function priceChange(orgId: string, urlId: string, key: string, label: string, from: string, to: string, pct: number) {
    await scan(orgId, urlId, [plan(key, label, from)], "NO_CHANGE", []);
    await scan(orgId, urlId, [plan(key, label, to)], "CHANGED", [priceEvent(key, from, to, pct)]);
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.alertRule.deleteMany({ where: { organizationId: id } });
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("raises an alert for a large price change, with the explanation of the rule that matched and its numbers", async () => {
    const { organization, url } = await makeSource();
    await priceChange(organization.id, url.id, "plan:pro", "Pro (per month)", "49.00", "72.00", 46.94);

    expect(await raiseAlerts(organization.id)).toEqual({ evaluated: 1, created: 1, merged: 0 });
    const [alert] = await listAlerts(organization.id);
    expect(alert).toMatchObject({ level: "URGENT", status: "OPEN", title: "Rival: Pro: price increased", ruleName: "Very large price change", occurrences: 1 });
    expect(alert!.explanation).toContain('Rule "Very large price change" matched');
    expect(alert!.explanation).toMatch(/importance \d+ \(at least 80 needed\)/);
    expect(alert!.explanation).toContain("Strongest reasons:");
    expect(alert!.explanation.length).toBeGreaterThan(100);
    expect(alert!.signalIds).toHaveLength(1);
  });

  it("does not alert for a small price change or for text changes, and handles each signal once", async () => {
    const { organization, url } = await makeSource();
    await priceChange(organization.id, url.id, "plan:pro", "Pro", "49.00", "50.00", 2.04);
    await scan(organization.id, url.id, [], "CHANGED", [textEvent]);

    const first = await raiseAlerts(organization.id);
    expect(first.created).toBe(0);
    expect(await listAlerts(organization.id)).toEqual([]);
    expect((await raiseAlerts(organization.id)).created).toBe(0);
  });

  it("is idempotent: raising again changes nothing", async () => {
    const { organization, url } = await makeSource();
    await priceChange(organization.id, url.id, "plan:pro", "Pro", "49.00", "72.00", 46.94);
    await raiseAlerts(organization.id);
    expect(await raiseAlerts(organization.id)).toEqual({ evaluated: 0, created: 0, merged: 0 });
    expect(await listAlerts(organization.id)).toHaveLength(1);
  });

  it("joins a repeat of the same page, plan and kind to the open alert, and only ever upgrades its level", async () => {
    const { organization, url } = await makeSource();
    await priceChange(organization.id, url.id, "plan:pro", "Pro", "49.00", "59.00", 20.41); // IMPORTANT
    await raiseAlerts(organization.id);
    expect((await listAlerts(organization.id))[0]).toMatchObject({ level: "IMPORTANT", occurrences: 1 });

    await scan(organization.id, url.id, [plan("plan:pro", "Pro", "89.00")], "CHANGED", [priceEvent("plan:pro", "59.00", "89.00", 50.85)]); // URGENT
    expect(await raiseAlerts(organization.id)).toMatchObject({ created: 0, merged: 1 });
    const alerts = await listAlerts(organization.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: "URGENT", occurrences: 2, ruleName: "Very large price change" });
    expect(alerts[0]!.signalIds).toHaveLength(2);

    await scan(organization.id, url.id, [plan("plan:pro", "Pro", "90.00")], "CHANGED", [priceEvent("plan:pro", "89.00", "90.00", 1.12)]);
    await raiseAlerts(organization.id);
    expect((await listAlerts(organization.id))[0]).toMatchObject({ level: "URGENT", occurrences: 2 }); // a small repeat does not downgrade or add
  });

  it("keeps different plans apart, and a dismissed alert is not reopened by the next change", async () => {
    const { organization, url } = await makeSource();
    await priceChange(organization.id, url.id, "plan:pro", "Pro", "49.00", "72.00", 46.94);
    await priceChange(organization.id, url.id, "plan:team", "Team", "99.00", "150.00", 51.5);
    await raiseAlerts(organization.id);
    const alerts = await listAlerts(organization.id);
    expect(alerts).toHaveLength(2);

    await setAlertStatus(organization.id, alerts[0]!.id, "DISMISSED");
    await scan(organization.id, url.id, [plan("plan:pro", "Pro", "110.00"), plan("plan:team", "Team", "150.00")], "CHANGED", [priceEvent("plan:pro", "72.00", "110.00", 52.78), priceEvent("plan:team", "150.00", "150.00", 0)].slice(0, 1));
    await raiseAlerts(organization.id);
    const dismissedKey = alerts[0]!.title;
    const after = (await listAlerts(organization.id)).filter((a) => a.title === dismissedKey);
    expect(after.some((a) => a.status === "DISMISSED")).toBe(true);
  });

  it("uses the organization's own rules when it has them, validates them, and goes back to the defaults when emptied", async () => {
    const { organization, url } = await makeSource();
    expect(await getActiveAlertRules(organization.id)).toEqual(DEFAULT_ALERT_RULES);
    await expect(replaceAlertRules(organization.id, [{ ...DEFAULT_ALERT_RULES[0]!, minImportance: 500 }])).rejects.toBeInstanceOf(InvalidAlertRulesError);
    expect(await prisma.alertRule.count({ where: { organizationId: organization.id } })).toBe(0);

    await replaceAlertRules(organization.id, [{ id: "text", name: "Any text change", level: "NOTICE", minImportance: 10, minConfidence: 0, kinds: ["CONTENT_UPDATE"], enabled: true }]);
    await scan(organization.id, url.id, [], "CHANGED", [textEvent]);
    expect(await raiseAlerts(organization.id)).toMatchObject({ created: 1 });
    expect((await listAlerts(organization.id))[0]).toMatchObject({ level: "NOTICE", ruleName: "Any text change" });

    await replaceAlertRules(organization.id, []);
    expect(await getActiveAlertRules(organization.id)).toEqual(DEFAULT_ALERT_RULES);
  });

  it("is tenant-scoped", async () => {
    const mine = await makeSource();
    const other = await makeSource();
    await priceChange(mine.organization.id, mine.url.id, "plan:pro", "Pro", "49.00", "72.00", 46.94);
    await raiseAlerts(mine.organization.id);
    const alert = (await listAlerts(mine.organization.id))[0]!;
    expect(await listAlerts(other.organization.id)).toEqual([]);
    await expect(setAlertStatus(other.organization.id, alert.id, "ACKNOWLEDGED")).rejects.toThrow(/not found/);
    expect((await listAlerts(mine.organization.id))[0]!.status).toBe("OPEN");
    await setAlertStatus(mine.organization.id, alert.id, "ACKNOWLEDGED");
    expect((await listAlerts(mine.organization.id))[0]!.status).toBe("ACKNOWLEDGED");
  });
});
