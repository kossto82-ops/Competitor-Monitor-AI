import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { updateOrganizationSettings } from "./organizations.js";
import { getReportRecipientEmailForOrg } from "./dailyReports.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { getProductUsageSummaryForOrg } from "./usage.js";

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

describe.skipIf(!reachable)("organization settings & usage (Phase 5)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Org Settings ${label} ${runId}-${counter}`,
      email: `org-settings-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("updateOrganizationSettings updates timezone and dailyReportEnabled", async () => {
    const org = await makeOrg("update");
    const updated = await updateOrganizationSettings(org.id, { timezone: "Europe/Berlin", dailyReportEnabled: false });
    expect(updated.timezone).toBe("Europe/Berlin");
    expect(updated.dailyReportEnabled).toBe(false);
  });

  it("Section 18: getReportRecipientEmailForOrg falls back to the OWNER's email when no override is set", async () => {
    const org = await makeOrg("recipient-default");
    const recipient = await getReportRecipientEmailForOrg(org.id);
    expect(recipient).toMatch(/^org-settings-recipient-default-/);
  });

  it("Section 18: a configured reportRecipientEmail override takes precedence over the OWNER's email", async () => {
    const org = await makeOrg("recipient-override");
    await updateOrganizationSettings(org.id, { reportRecipientEmail: "reports@customer.example.test" });
    const recipient = await getReportRecipientEmailForOrg(org.id);
    expect(recipient).toBe("reports@customer.example.test");
  });

  it("Section 18: an empty-string reportRecipientEmail clears the override, reverting to the OWNER's email", async () => {
    const org = await makeOrg("recipient-clear");
    await updateOrganizationSettings(org.id, { reportRecipientEmail: "reports@customer.example.test" });
    await updateOrganizationSettings(org.id, { reportRecipientEmail: "" });
    const recipient = await getReportRecipientEmailForOrg(org.id);
    expect(recipient).toMatch(/^org-settings-recipient-clear-/);
  });

  it("tenant isolation: updating organization A's settings never affects organization B", async () => {
    const a = await makeOrg("tenant-a");
    const b = await makeOrg("tenant-b");
    await updateOrganizationSettings(a.id, { timezone: "Asia/Tokyo" });

    const bFresh = await prisma.organization.findUniqueOrThrow({ where: { id: b.id } });
    expect(bFresh.timezone).toBe("UTC");
  });

  it("getProductUsageSummaryForOrg counts competitors/URLs correctly and is organization-scoped", async () => {
    const a = await makeOrg("usage-a");
    const b = await makeOrg("usage-b");
    const competitorA = await createCompetitor(a.id, { name: "A1" });
    await createMonitoredUrl(a.id, competitorA.id, { url: "https://usage-a.example.test/pricing", category: "GENERAL" });
    await createCompetitor(b.id, { name: "B1" });

    const usageA = await getProductUsageSummaryForOrg(a.id, new Date(0));
    expect(usageA.competitors).toBe(1);
    expect(usageA.monitoredUrls).toBe(1);

    const usageB = await getProductUsageSummaryForOrg(b.id, new Date(0));
    expect(usageB.competitors).toBe(1);
    expect(usageB.monitoredUrls).toBe(0);
  });
});
