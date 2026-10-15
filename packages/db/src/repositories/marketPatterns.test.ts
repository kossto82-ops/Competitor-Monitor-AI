import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { getMarketPatternOverview, refreshMarketPatterns } from "./marketPatterns.js";

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
const DAY = 24 * 60 * 60_000;

describe.skipIf(!reachable)("market patterns (Phase 29 E1)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeMarket(historyDays: number, names = ["Alpha", "Beta", "Gamma", "Delta"]) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Patterns ${runId}-${counter}`,
      email: `patterns-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const now = new Date();
    const competitors: { id: string; name: string; urlId: string }[] = [];
    for (const name of names) {
      const competitor = await createCompetitor(organization.id, { name });
      const url = await createMonitoredUrl(organization.id, competitor.id, { url: `https://${name.toLowerCase()}-${counter}.example.test/pricing`, category: "GENERAL" });
      const job = await prisma.monitoringJob.create({ data: { organizationId: organization.id, monitoredUrlId: url.id, status: "COMPLETED" } });
      await prisma.snapshot.create({
        data: {
          organizationId: organization.id,
          monitoredUrlId: url.id,
          monitoringJobId: job.id,
          extractionMethod: "CHEERIO",
          verificationState: "NO_CHANGE",
          normalizedContent: "x",
          confidence: 1,
          fetchedAt: new Date(now.getTime() - historyDays * DAY),
        },
      });
      competitors.push({ id: competitor.id, name, urlId: url.id });
    }
    return { organization, competitors, now };
  }

  async function addSignal(orgId: string, competitor: { id: string; urlId: string }, kind: "PRICE_INCREASE" | "PRICE_DECREASE" | "PLAN_ADDED", daysAgo: number, pct: number | null = 10) {
    return prisma.signal.create({
      data: {
        organizationId: orgId,
        competitorId: competitor.id,
        monitoredUrlId: competitor.urlId,
        kind,
        title: "t",
        summary: "s",
        percentageChange: pct,
        confidence: 0.9,
        ruleId: "price-change",
        ruleVersion: 1,
        dedupeKey: `k-${Math.random()}`,
        occurredAt: new Date(Date.now() - daysAgo * DAY),
      },
    });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("claims nothing while the history is too short, and says why", async () => {
    const { organization, competitors } = await makeMarket(5);
    await addSignal(organization.id, competitors[0]!, "PRICE_INCREASE", 2);
    await addSignal(organization.id, competitors[1]!, "PRICE_INCREASE", 2);
    expect(await refreshMarketPatterns(organization.id)).toEqual({ status: "INSUFFICIENT_SAMPLE", created: 0, updated: 0, resolved: 0 });
    const overview = await getMarketPatternOverview(organization.id);
    expect(overview.sample).toMatchObject({ sufficient: false, eligibleCount: 0, observedCount: 4 });
    expect(overview.sample.reason).toContain("watched for 14 days or more");
    expect(overview.active).toEqual([]);
  });

  it("materializes a pattern with every competitor named and every signal as evidence", async () => {
    const { organization, competitors } = await makeMarket(30);
    const s = [
      await addSignal(organization.id, competitors[0]!, "PRICE_INCREASE", 3, 12.4),
      await addSignal(organization.id, competitors[1]!, "PRICE_INCREASE", 5, 8),
      await addSignal(organization.id, competitors[1]!, "PRICE_INCREASE", 9, 20),
      await addSignal(organization.id, competitors[2]!, "PRICE_INCREASE", 2, 10),
    ];
    expect(await refreshMarketPatterns(organization.id)).toMatchObject({ status: "EVALUATED", created: 1, updated: 0, resolved: 0 });

    const overview = await getMarketPatternOverview(organization.id);
    expect(overview.sample).toMatchObject({ sufficient: true, eligibleCount: 4 });
    expect(overview.active).toHaveLength(1);
    const [pattern] = overview.active;
    expect(pattern).toMatchObject({ kind: "MARKET_PRICES_UP", status: "ACTIVE", epistemicLevel: "INTERPRETATION", affectedCount: 3, observedCount: 4, share: 0.75 });
    expect(pattern!.summary).toBe("3 of 4 competitors raised prices in the last 30 days: Gamma (+10%), Alpha (+12.4%), Beta (+20%).");
    expect(pattern!.competitors.map((c) => c.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(pattern!.competitors.flatMap((c) => c.signalIds).sort()).toEqual(s.map((x) => x.id).sort()); // all four, not only the latest
  });

  it("updates the same pattern while it holds (its first detection stays) and is idempotent", async () => {
    const { organization, competitors } = await makeMarket(30);
    await addSignal(organization.id, competitors[0]!, "PRICE_INCREASE", 3);
    await addSignal(organization.id, competitors[1]!, "PRICE_INCREASE", 3);
    await refreshMarketPatterns(organization.id);
    const first = (await getMarketPatternOverview(organization.id)).active[0]!;
    expect(await refreshMarketPatterns(organization.id)).toMatchObject({ created: 0, updated: 1 });
    await addSignal(organization.id, competitors[2]!, "PRICE_INCREASE", 1);
    await refreshMarketPatterns(organization.id);
    const later = (await getMarketPatternOverview(organization.id)).active;
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ id: first.id, affectedCount: 3 });
    expect(later[0]!.firstDetectedAt.getTime()).toBe(first.firstDetectedAt.getTime());
    expect(await prisma.marketPattern.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it("resolves a pattern that stops holding, keeps it visible, and never mixes rises with falls", async () => {
    const { organization, competitors } = await makeMarket(40);
    await addSignal(organization.id, competitors[0]!, "PRICE_INCREASE", 35);
    await addSignal(organization.id, competitors[1]!, "PRICE_INCREASE", 34);
    await addSignal(organization.id, competitors[2]!, "PRICE_DECREASE", 1);
    expect(await refreshMarketPatterns(organization.id, { now: new Date(Date.now() - 20 * DAY) })).toMatchObject({ created: 1 }); // rises held back then
    expect((await getMarketPatternOverview(organization.id)).active.map((p) => p.kind)).toEqual(["MARKET_PRICES_UP"]);
    expect(await refreshMarketPatterns(organization.id)).toMatchObject({ resolved: 1, created: 0 }); // now the rises are out of the window, one fall is no pattern
    const overview = await getMarketPatternOverview(organization.id);
    expect(overview.active).toEqual([]);
    expect(overview.recentlyResolved[0]).toMatchObject({ kind: "MARKET_PRICES_UP", status: "RESOLVED" });
    expect(overview.recentlyResolved[0]!.resolvedAt).not.toBeNull();
  });

  it("leaves a pattern as it was, rather than resolving it, when the sample becomes too small to judge", async () => {
    const { organization, competitors } = await makeMarket(30);
    await addSignal(organization.id, competitors[0]!, "PRICE_INCREASE", 3);
    await addSignal(organization.id, competitors[1]!, "PRICE_INCREASE", 3);
    await refreshMarketPatterns(organization.id);
    await prisma.competitor.updateMany({ where: { organizationId: organization.id, name: { in: ["Gamma", "Delta"] } }, data: { isActive: false } });
    expect(await refreshMarketPatterns(organization.id)).toMatchObject({ status: "INSUFFICIENT_SAMPLE", resolved: 0 });
    expect((await getMarketPatternOverview(organization.id)).active).toHaveLength(1);
  });

  it("is tenant-scoped", async () => {
    const mine = await makeMarket(30);
    const other = await makeMarket(30);
    await addSignal(mine.organization.id, mine.competitors[0]!, "PRICE_INCREASE", 3);
    await addSignal(mine.organization.id, mine.competitors[1]!, "PRICE_INCREASE", 3);
    await refreshMarketPatterns(mine.organization.id);
    expect((await getMarketPatternOverview(other.organization.id)).active).toEqual([]);
    expect((await getMarketPatternOverview(mine.organization.id)).active).toHaveLength(1);
  });
});
