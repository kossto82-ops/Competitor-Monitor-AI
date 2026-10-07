import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { listRecentChangeEventsForUrl } from "./changeEvents.js";

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
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe.skipIf(!reachable)("listRecentChangeEventsForUrl (Phase 29 C4)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeUrl(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Recent events ${label} ${runId}-${counter}`,
      email: `recent-events-${label}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: "Rival" });
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: `https://recent-${label}-${runId}-${counter}.example.test`, category: "GENERAL" });
    return { organization, url };
  }

  async function addEvent(orgId: string, urlId: string, detectedAt: Date, newValue: string) {
    const job = await prisma.monitoringJob.create({ data: { organizationId: orgId, monitoredUrlId: urlId, status: "COMPLETED" } });
    const snapshot = await prisma.snapshot.create({
      data: { organizationId: orgId, monitoredUrlId: urlId, monitoringJobId: job.id, extractionMethod: "CHEERIO", verificationState: "CHANGED", normalizedContent: "x", confidence: 1 },
    });
    return prisma.changeEvent.create({
      data: {
        organizationId: orgId,
        monitoredUrlId: urlId,
        currentSnapshotId: snapshot.id,
        changeType: "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.9,
        entityKey: "plan:pro:month",
        fieldPath: "plan:pro:month",
        oldValue: "10.00",
        newValue,
        currency: "USD",
        percentageChange: 10,
        evidenceExcerpt: "e",
        detectedAt,
      },
    });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("returns only this URL's changes inside the window, newest first, with just the fields the detector needs", async () => {
    const { organization, url } = await makeUrl("window");
    await addEvent(organization.id, url.id, hoursAgo(30), "11.00");
    await addEvent(organization.id, url.id, hoursAgo(2), "12.00");
    await addEvent(organization.id, url.id, hoursAgo(100), "13.00"); // outside 48h

    const rows = await listRecentChangeEventsForUrl(organization.id, url.id, 48 * 3_600_000);
    expect(rows.map((r) => r.newValue)).toEqual(["12.00", "11.00"]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["changeType", "currency", "detectedAt", "entityKey", "newValue", "oldValue"]);
  });

  it("is tenant-scoped: another organization's id returns nothing for the same URL id", async () => {
    const a = await makeUrl("iso-a");
    const b = await makeUrl("iso-b");
    await addEvent(a.organization.id, a.url.id, hoursAgo(1), "11.00");
    expect(await listRecentChangeEventsForUrl(b.organization.id, a.url.id, 48 * 3_600_000)).toEqual([]);
  });
});
