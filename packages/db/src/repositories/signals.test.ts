import { afterAll, describe, expect, it } from "vitest";
import type { ComparisonResult, ExtractedEntity, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { createRunningMonitoringJob, persistMonitoringResult } from "./monitoringPipeline.js";
import { backfillSignals, getSignalWithEvidence, listSignals, promoteSignals } from "./signals.js";

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
const event = (overrides: Partial<Draft>): Draft => ({
  changeType: "PRICE_CHANGE",
  severity: "MEDIUM",
  confidence: 0.9,
  entityKey: "plan:pro",
  fieldPath: "plan:pro",
  oldValue: "29.00",
  newValue: "39.00",
  currency: "USD",
  percentageChange: 34.48,
  evidenceExcerpt: "Pro (per month): 29.00 -> 39.00",
  ...overrides,
});

describe.skipIf(!reachable)("signals (Phase 29 D2)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeSource() {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Signals ${runId}-${counter}`,
      email: `signals-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: "Rival" });
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: `https://signals-${counter}.example.test/pricing`, category: "GENERAL" });
    return { organization, competitor, url };
  }

  async function scan(orgId: string, urlId: string, entities: ExtractedEntity[], state: ComparisonResult["verificationState"], events: Draft[], errorMessage: string | null = null) {
    const job = await createRunningMonitoringJob(orgId, urlId);
    return persistMonitoringResult(job.id, {
      organizationId: orgId,
      monitoredUrlId: urlId,
      previousSnapshotId: null,
      extraction: {
        method: "CHEERIO",
        requestedUrl: "https://x.test/",
        finalUrl: "https://x.test/",
        httpStatus: errorMessage ? 403 : 200,
        errorMessage,
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
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("promotes a verified price change to a signal with a template title, its rule, and the event as evidence", async () => {
    const { organization, url } = await makeSource();
    await scan(organization.id, url.id, [plan("plan:pro", "Pro (per month)", "39.00")], "CHANGED", [event({})]);

    const signals = await listSignals(organization.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "PRICE_INCREASE",
      epistemicLevel: "FACT",
      title: "Pro: price increased",
      ruleId: "price-change",
      ruleVersion: 1,
      competitorName: "Rival",
      evidenceCount: 1,
    });
    const detail = await getSignalWithEvidence(organization.id, signals[0]!.id);
    expect(detail?.evidence).toHaveLength(1);
    expect(detail?.evidence[0]).toMatchObject({ role: "PRIMARY" });
    expect(detail?.evidence[0]?.changeEvent).toMatchObject({ changeType: "PRICE_CHANGE", oldValue: "29.00", newValue: "39.00" });
  });

  it("groups a source's text changes of one day into one signal and keeps every event as evidence", async () => {
    const { organization, url } = await makeSource();
    const text = (path: string) => event({ changeType: "CONTENT_CHANGE", entityKey: null, fieldPath: path, oldValue: null, newValue: null, percentageChange: null, confidence: 0.6, evidenceExcerpt: "Changed text" });
    await scan(organization.id, url.id, [], "CHANGED", [text("page.visibleText")]);
    await scan(organization.id, url.id, [], "CHANGED", [text("page.visibleText")]);

    const signals = await listSignals(organization.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: "CONTENT_UPDATE", evidenceCount: 2 });
    const detail = await getSignalWithEvidence(organization.id, signals[0]!.id);
    expect(detail?.evidence.map((e) => e.role).sort()).toEqual(["PRIMARY", "SUPPORTING"]);
  });

  it("does not promote events the detector downgraded, and learns nothing from an unverified scan", async () => {
    const { organization, url } = await makeSource();
    await scan(organization.id, url.id, [plan("plan:pro", "Pro", "39.00")], "CHANGED", [event({ confidence: 0.45, evidenceExcerpt: "x Reverts the change detected 3h ago" })]);
    await scan(organization.id, url.id, [plan("plan:pro", "Pro", "49.00")], "FAILED_TO_VERIFY", [event({ oldValue: "39.00", newValue: "49.00" })]);
    expect(await listSignals(organization.id)).toEqual([]);
  });

  it("is idempotent, and a backfill rebuilds the same signals", async () => {
    const { organization, competitor, url } = await makeSource();
    await scan(organization.id, url.id, [plan("plan:pro", "Pro (per month)", "39.00")], "CHANGED", [event({})]);
    const before = await listSignals(organization.id);

    const events = await prisma.changeEvent.findMany({ where: { organizationId: organization.id } });
    const again = await prisma.$transaction((tx) =>
      promoteSignals(tx, { organizationId: organization.id, competitorId: competitor.id, events: events.map((e) => ({ ...e, evidenceExcerpt: e.evidenceExcerpt })) }),
    );
    expect(again.created).toBe(0);
    expect((await backfillSignals(organization.id)).created).toBe(0);
    expect(await listSignals(organization.id)).toEqual(before);

    await prisma.signal.deleteMany({ where: { organizationId: organization.id } });
    expect(await backfillSignals(organization.id)).toMatchObject({ events: 1, created: 1 });
    expect((await listSignals(organization.id))[0]).toMatchObject({ kind: "PRICE_INCREASE", title: "Pro: price increased" });
  });

  it("is tenant-scoped", async () => {
    const mine = await makeSource();
    const other = await makeSource();
    await scan(mine.organization.id, mine.url.id, [plan("plan:pro", "Pro", "39.00")], "CHANGED", [event({})]);
    const signal = (await listSignals(mine.organization.id))[0]!;
    expect(await listSignals(other.organization.id)).toEqual([]);
    expect(await getSignalWithEvidence(other.organization.id, signal.id)).toBeNull();
  });
});
