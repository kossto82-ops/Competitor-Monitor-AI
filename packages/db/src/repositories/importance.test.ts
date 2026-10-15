import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_IMPORTANCE_CONFIG, type ComparisonResult, type ExtractedEntity, type ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { createRunningMonitoringJob, persistMonitoringResult } from "./monitoringPipeline.js";
import { getActiveImportanceConfig, InvalidImportanceConfigError, listPrioritizedSignals, saveImportanceConfig, setCompetitorRelevance } from "./importance.js";

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

const plan = (key: string, label: string, value: string): ExtractedEntity => ({ type: "PRICE", key, label, value, currency: "USD", raw: `$${value}` });
const priceEvent = (key: string, oldValue: string, newValue: string, percentageChange: number): Draft => ({
  changeType: "PRICE_CHANGE",
  severity: "MEDIUM",
  confidence: 0.9,
  entityKey: key,
  fieldPath: key,
  oldValue,
  newValue,
  currency: "USD",
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

describe.skipIf(!reachable)("importance configuration and prioritised signals (Phase 29 D3)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg() {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Importance ${runId}-${counter}`,
      email: `importance-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }
  async function addSource(orgId: string, name: string) {
    const competitor = await createCompetitor(orgId, { name });
    const url = await createMonitoredUrl(orgId, competitor.id, { url: `https://importance-${counter}-${name.toLowerCase()}.example.test/pricing`, category: "GENERAL" });
    return { competitor, url };
  }
  async function scan(orgId: string, urlId: string, entities: ExtractedEntity[], state: ComparisonResult["verificationState"], events: Draft[]) {
    const job = await createRunningMonitoringJob(orgId, urlId);
    return persistMonitoringResult(job.id, {
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

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.importanceConfig.deleteMany({ where: { organizationId: id } });
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("uses the built-in default until the organization saves one, then versions every change", async () => {
    const org = await makeOrg();
    expect(await getActiveImportanceConfig(org.id)).toEqual(DEFAULT_IMPORTANCE_CONFIG);

    const v2 = await saveImportanceConfig(org.id, { kindEmphasis: { ...DEFAULT_IMPORTANCE_CONFIG.kindEmphasis, PROMOTION_STARTED: 1 } });
    expect(v2.version).toBe(2);
    expect(v2.kindEmphasis.PROMOTION_STARTED).toBe(1);
    expect(v2.weights).toEqual(DEFAULT_IMPORTANCE_CONFIG.weights); // what was not given keeps the active value
    const v3 = await saveImportanceConfig(org.id, { weights: { ...DEFAULT_IMPORTANCE_CONFIG.weights, magnitude: 0.5 } });
    expect(v3.version).toBe(3);
    expect(v3.kindEmphasis.PROMOTION_STARTED).toBe(1); // carried over from v2
    expect((await getActiveImportanceConfig(org.id)).version).toBe(3);
    expect(await prisma.importanceConfig.count({ where: { organizationId: org.id } })).toBe(2); // old versions are kept
  });

  it("refuses a configuration that cannot be used, without saving anything", async () => {
    const org = await makeOrg();
    await expect(saveImportanceConfig(org.id, { tiers: { high: 20, medium: 50 } })).rejects.toBeInstanceOf(InvalidImportanceConfigError);
    await expect(saveImportanceConfig(org.id, { weights: { ...DEFAULT_IMPORTANCE_CONFIG.weights, kind: -1 } })).rejects.toThrow(/kind/);
    expect(await prisma.importanceConfig.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it("ranks a large price change above a text change, with a breakdown and a confidence that stays separate", async () => {
    const org = await makeOrg();
    const rival = await addSource(org.id, "Rival");
    const other = await addSource(org.id, "Other");
    await scan(org.id, rival.url.id, [plan("plan:pro", "Pro (per month)", "29.00")], "NO_CHANGE", []);
    await scan(org.id, rival.url.id, [plan("plan:pro", "Pro (per month)", "39.00")], "CHANGED", [priceEvent("plan:pro", "29.00", "39.00", 34.48)]);
    await scan(org.id, other.url.id, [], "CHANGED", [textEvent]);

    const { config, signals } = await listPrioritizedSignals(org.id);
    expect(config.version).toBe(1);
    expect(signals.map((s) => s.kind)).toEqual(["PRICE_INCREASE", "CONTENT_UPDATE"]);
    const [price, text] = signals;
    expect(price!.tier).toBe("HIGH");
    expect(text!.tier).toBe("LOW");
    expect(price!.importance).toBeGreaterThan(text!.importance);
    expect(price!.confidence).toBe(0.9);
    expect(price!.factors.map((f) => f.factor)).toContain("magnitude");
    expect(price!.factors.find((f) => f.factor === "history")!.explanation).toContain("first change ever");
    expect(price!.factors.reduce((sum, f) => sum + f.points, 0)).toBeCloseTo(price!.importance, 0);
    expect(price!.configVersion).toBe(1);
  });

  it("follows the customer's relevance for a competitor and the new configuration version", async () => {
    const org = await makeOrg();
    const rival = await addSource(org.id, "Rival");
    await scan(org.id, rival.url.id, [plan("plan:pro", "Pro", "29.00")], "NO_CHANGE", []);
    await scan(org.id, rival.url.id, [plan("plan:pro", "Pro", "39.00")], "CHANGED", [priceEvent("plan:pro", "29.00", "39.00", 34.48)]);
    const normal = (await listPrioritizedSignals(org.id)).signals[0]!;

    await setCompetitorRelevance(org.id, rival.competitor.id, 3);
    const high = (await listPrioritizedSignals(org.id)).signals[0]!;
    expect(high.importance).toBeGreaterThan(normal.importance);
    expect(high.factors.find((f) => f.factor === "relevance")!.explanation).toContain("high relevance");

    await saveImportanceConfig(org.id, { kindEmphasis: { ...DEFAULT_IMPORTANCE_CONFIG.kindEmphasis, PRICE_INCREASE: 0 } });
    const reweighed = (await listPrioritizedSignals(org.id)).signals[0]!;
    expect(reweighed.configVersion).toBe(2);
    expect(reweighed.importance).toBeLessThan(high.importance);
  });

  it("corroboration: the same kind of change at two competitors counts for more at each", async () => {
    const org = await makeOrg();
    const a = await addSource(org.id, "A");
    await scan(org.id, a.url.id, [plan("plan:pro", "Pro", "10.00")], "NO_CHANGE", []);
    await scan(org.id, a.url.id, [plan("plan:pro", "Pro", "12.00")], "CHANGED", [priceEvent("plan:pro", "10.00", "12.00", 20)]);
    const alone = (await listPrioritizedSignals(org.id)).signals[0]!.importance;
    const b = await addSource(org.id, "B");
    await scan(org.id, b.url.id, [plan("plan:team", "Team", "20.00")], "NO_CHANGE", []);
    await scan(org.id, b.url.id, [plan("plan:team", "Team", "24.00")], "CHANGED", [priceEvent("plan:team", "20.00", "24.00", 20)]);
    const together = (await listPrioritizedSignals(org.id)).signals.find((s) => s.competitorName === "A")!;
    expect(together.importance).toBeGreaterThan(alone);
    expect(together.factors.find((f) => f.factor === "corroboration")!.explanation).toContain("2 competitors");
  });

  it("is tenant-scoped, and a competitor of another organization cannot be rated", async () => {
    const mine = await makeOrg();
    const other = await makeOrg();
    const rival = await addSource(mine.id, "Rival");
    await scan(mine.id, rival.url.id, [plan("plan:pro", "Pro", "29.00")], "NO_CHANGE", []);
    await scan(mine.id, rival.url.id, [plan("plan:pro", "Pro", "39.00")], "CHANGED", [priceEvent("plan:pro", "29.00", "39.00", 34.48)]);
    expect((await listPrioritizedSignals(other.id)).signals).toEqual([]);
    await expect(setCompetitorRelevance(other.id, rival.competitor.id, 3)).rejects.toThrow(/not found/);
    expect((await prisma.competitor.findUniqueOrThrow({ where: { id: rival.competitor.id } })).relevance).toBe(2);
  });
});
