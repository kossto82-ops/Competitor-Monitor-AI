import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import {
  getAlertEmailActivity,
  getAlertEmailSettings,
  listAlertDeliveries,
  listOrganizationIdsWithOpenAlerts,
  markAlertDeliveriesFailed,
  markAlertDeliveriesSent,
  reserveAlertDeliveries,
} from "./alertDelivery.js";
import { updateOrganizationSettings } from "./organizations.js";

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

describe.skipIf(!reachable)("alert email deliveries (Phase 29 D5b)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrgWithAlerts(count = 2) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Alert email ${runId}-${counter}`,
      email: `alert-email-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: "Rival" });
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: `https://alert-email-${counter}.example.test/pricing`, category: "GENERAL" });
    const alerts = [];
    for (let i = 0; i < count; i += 1) {
      alerts.push(
        await prisma.alertEvent.create({
          data: {
            organizationId: organization.id,
            competitorId: competitor.id,
            monitoredUrlId: url.id,
            ruleKey: "r",
            ruleName: "Rule",
            level: "IMPORTANT",
            title: `Alert ${i}`,
            explanation: "because",
            importance: 70,
            confidence: 0.9,
            dedupeKey: `k${i}`,
            firstRaisedAt: new Date(),
            lastRaisedAt: new Date(),
          },
        }),
      );
    }
    return { organization, alerts };
  }

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("defaults to emailing important alerts, and the level can be changed", async () => {
    const { organization } = await makeOrgWithAlerts(0);
    expect(await getAlertEmailSettings(organization.id)).toMatchObject({ enabled: true, minLevel: "IMPORTANT" });
    await updateOrganizationSettings(organization.id, { alertEmailsEnabled: false, alertEmailMinLevel: "URGENT" });
    expect(await getAlertEmailSettings(organization.id)).toMatchObject({ enabled: false, minLevel: "URGENT" });
    expect(await getAlertEmailSettings("no-such-org")).toBeNull();
  });

  it("reserves one attempt per alert, and a second run that races the first gets nothing for the same attempt", async () => {
    const { organization, alerts } = await makeOrgWithAlerts();
    const items = alerts.map((a) => ({ alertId: a.id, level: "IMPORTANT" as const }));
    const first = await reserveAlertDeliveries(organization.id, "owner@acme.test", items);
    expect(first).toHaveLength(2);
    expect(await prisma.alertDelivery.count({ where: { organizationId: organization.id } })).toBe(2);

    // The second call computes the NEXT attempt, so it only reserves once the first one is finished with.
    const rows = await prisma.alertDelivery.findMany({ where: { organizationId: organization.id } });
    expect(rows.every((r) => r.attempt === 1 && r.status === "PENDING")).toBe(true);
    const second = await reserveAlertDeliveries(organization.id, "owner@acme.test", items);
    expect(second).toHaveLength(2);
    expect((await prisma.alertDelivery.findMany({ where: { organizationId: organization.id } })).map((r) => r.attempt).sort()).toEqual([1, 1, 2, 2]);
  });

  it("refuses a duplicate attempt number at the database, so two sends can never both win", async () => {
    const { organization, alerts } = await makeOrgWithAlerts(1);
    const data = { organizationId: organization.id, alertId: alerts[0]!.id, recipient: "o@a.test", levelSent: "IMPORTANT" as const, attempt: 1 };
    await prisma.alertDelivery.create({ data });
    await expect(prisma.alertDelivery.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });

  it("records sent and failed attempts, and reports them for the recipient only", async () => {
    const { organization, alerts } = await makeOrgWithAlerts();
    const reserved = await reserveAlertDeliveries(organization.id, "owner@acme.test", alerts.map((a) => ({ alertId: a.id, level: "IMPORTANT" as const })));
    const sentAt = new Date();
    await markAlertDeliveriesSent([reserved[0]!.id], sentAt);
    await markAlertDeliveriesFailed([reserved[1]!.id], "smtp down");

    const mine = await listAlertDeliveries(organization.id, "owner@acme.test", alerts.map((a) => a.id));
    expect(mine.map((d) => d.status).sort()).toEqual(["FAILED", "SENT"]);
    expect(await listAlertDeliveries(organization.id, "someone@else.test", alerts.map((a) => a.id))).toEqual([]);
    expect(await listAlertDeliveries("other-org", "owner@acme.test", alerts.map((a) => a.id))).toEqual([]);
    expect((await prisma.alertDelivery.findUniqueOrThrow({ where: { id: reserved[1]!.id } })).errorMessage).toBe("smtp down");
  });

  it("counts an email once however many alerts it carried, and finds the last one", async () => {
    const { organization, alerts } = await makeOrgWithAlerts(3);
    expect(await getAlertEmailActivity(organization.id)).toEqual({ lastEmailAt: null, emailsInLastHour: 0 });
    const reserved = await reserveAlertDeliveries(organization.id, "owner@acme.test", alerts.map((a) => ({ alertId: a.id, level: "IMPORTANT" as const })));
    const sentAt = new Date(Date.now() - 10 * 60_000);
    await markAlertDeliveriesSent(reserved.map((r) => r.id), sentAt); // one email, three alerts
    const activity = await getAlertEmailActivity(organization.id);
    expect(activity.emailsInLastHour).toBe(1);
    expect(activity.lastEmailAt?.getTime()).toBe(sentAt.getTime());
    expect((await getAlertEmailActivity(organization.id, new Date(Date.now() + 2 * 3_600_000))).emailsInLastHour).toBe(0);
  });

  it("finds the organizations that have an open alert, and not those whose alerts are all seen", async () => {
    const open = await makeOrgWithAlerts(1);
    const seen = await makeOrgWithAlerts(1);
    await prisma.alertEvent.updateMany({ where: { organizationId: seen.organization.id }, data: { status: "ACKNOWLEDGED" } });
    const ids = await listOrganizationIdsWithOpenAlerts();
    expect(ids).toContain(open.organization.id);
    expect(ids).not.toContain(seen.organization.id);
  });
});
