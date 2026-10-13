import { afterAll, describe, expect, it } from "vitest";
import type { ComparisonResult, ExtractedEntity, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { createRunningMonitoringJob, persistMonitoringResult } from "./monitoringPipeline.js";
import { backfillEntityHistory, listEntityHistory } from "./entityHistory.js";

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

const plan = (key: string, value: string, currency = "USD"): ExtractedEntity => ({ type: "PRICE", key, label: key, value, currency, raw: `$${value}` });
const generic = (): ExtractedEntity => ({ type: "GENERIC", key: "text-price:ab12", label: "ctx", value: "5.00", currency: "USD", raw: "$5" });

describe.skipIf(!reachable)("entity history (Phase 29 D1)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeSource() {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Entity history ${runId}-${counter}`,
      email: `entity-history-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: "Rival" });
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: `https://entity-${counter}.example.test/pricing`, category: "GENERAL" });
    return { organization, url };
  }

  let previousSnapshotId: string | null = null;
  async function scan(
    org: { id: string },
    urlId: string,
    entities: ExtractedEntity[],
    state: ComparisonResult["verificationState"] = "CHANGED",
    events: ComparisonResult["changeEvents"] = [],
    errorMessage: string | null = null,
  ) {
    const job = await createRunningMonitoringJob(org.id, urlId);
    const snapshot = await persistMonitoringResult(job.id, {
      organizationId: org.id,
      monitoredUrlId: urlId,
      previousSnapshotId,
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
    previousSnapshotId = snapshot.id;
    // Distinct, ordered capture times so versions sort the way the scans happened.
    await new Promise((r) => setTimeout(r, 5));
    return snapshot;
  }

  const priceEvent = (key: string, oldValue: string, newValue: string) =>
    ({ changeType: "PRICE_CHANGE", severity: "MEDIUM", confidence: 0.9, entityKey: key, fieldPath: key, oldValue, newValue, currency: "USD", percentageChange: 10, evidenceExcerpt: "e" }) as ComparisonResult["changeEvents"][number];

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("follows a plan across scans: first seen, a change linked to its event, an unexplained difference as baseline, absence and return", async () => {
    const { organization, url } = await makeSource();
    previousSnapshotId = null;
    await scan(organization, url.id, [plan("plan:pro", "29.00"), plan("plan:team", "59.00"), generic()], "NO_CHANGE");
    await scan(organization, url.id, [plan("plan:pro", "39.00"), plan("plan:team", "59.00")], "CHANGED", [priceEvent("plan:pro", "29.00", "39.00")]);
    await scan(organization, url.id, [plan("plan:pro", "39.00"), plan("plan:team", "61.00")], "NO_CHANGE"); // no event explains team 59 -> 61
    await scan(organization, url.id, [plan("plan:pro", "39.00")], "CHANGED"); // team disappears
    await scan(organization, url.id, [plan("plan:pro", "39.00"), plan("plan:team", "61.00")], "CHANGED"); // and is back

    const history = await listEntityHistory(organization.id, url.id);
    expect(history.map((e) => e.key)).toEqual(["plan:pro", "plan:team"]); // the generic evidence price is not tracked
    const pro = history.find((e) => e.key === "plan:pro")!;
    expect(pro.versions.map((v) => [v.origin, v.value])).toEqual([["FIRST_SEEN", "29.00"], ["CHANGE", "39.00"]]);
    expect(pro.versions[1]!.changeEventId).not.toBeNull();
    const event = await prisma.changeEvent.findUniqueOrThrow({ where: { id: pro.versions[1]!.changeEventId! } });
    expect([event.changeType, event.entityKey]).toEqual(["PRICE_CHANGE", "plan:pro"]);

    const team = history.find((e) => e.key === "plan:team")!;
    expect(team.versions.map((v) => [v.origin, v.value])).toEqual([["FIRST_SEEN", "59.00"], ["BASELINE", "61.00"], ["REAPPEARED", "61.00"]]);
    expect(team.versions[1]!.changeEventId).toBeNull();
    expect(team.status).toBe("ACTIVE");
    expect(team.absentSince).toBeNull();
  });

  it("marks an entity absent when a verified scan no longer shows it", async () => {
    const { organization, url } = await makeSource();
    previousSnapshotId = null;
    await scan(organization, url.id, [plan("plan:pro", "29.00"), plan("plan:team", "59.00")], "NO_CHANGE");
    await scan(organization, url.id, [plan("plan:pro", "29.00")], "CHANGED");
    const team = (await listEntityHistory(organization.id, url.id)).find((e) => e.key === "plan:team")!;
    expect(team.status).toBe("ABSENT");
    expect(team.absentSince).not.toBeNull();
  });

  it("learns nothing from an unverified scan or a failed fetch", async () => {
    const { organization, url } = await makeSource();
    previousSnapshotId = null;
    await scan(organization, url.id, [plan("plan:pro", "29.00")], "NO_CHANGE");
    await scan(organization, url.id, [], "FAILED_TO_VERIFY");
    await scan(organization, url.id, [plan("plan:pro", "99.00")], "FAILED_TO_VERIFY");
    await scan(organization, url.id, [], "FAILED_TO_VERIFY", [], "HTTP 403");
    const pro = (await listEntityHistory(organization.id, url.id))[0]!;
    expect(pro.status).toBe("ACTIVE");
    expect(pro.versions).toHaveLength(1);
  });

  it("is tenant-scoped", async () => {
    const mine = await makeSource();
    const other = await makeSource();
    previousSnapshotId = null;
    await scan(mine.organization, mine.url.id, [plan("plan:pro", "29.00")], "NO_CHANGE");
    expect(await listEntityHistory(other.organization.id, mine.url.id)).toEqual([]);
  });

  it("rebuilds the same history from existing snapshots (backfill), and leaves a source that already has one alone", async () => {
    const { organization, url } = await makeSource();
    previousSnapshotId = null;
    await scan(organization, url.id, [plan("plan:pro", "29.00")], "NO_CHANGE");
    await scan(organization, url.id, [plan("plan:pro", "39.00")], "CHANGED", [priceEvent("plan:pro", "29.00", "39.00")]);
    const live = await listEntityHistory(organization.id, url.id);

    expect(await backfillEntityHistory(organization.id)).toEqual({ sources: 0, snapshots: 0 }); // already has history
    const rebuilt = await backfillEntityHistory(organization.id, { force: true });
    expect(rebuilt).toEqual({ sources: 1, snapshots: 2 });
    const again = await listEntityHistory(organization.id, url.id);
    const shape = (h: typeof live) => h.map((e) => [e.key, e.status, e.versions.map((v) => [v.origin, v.value, v.changeEventId !== null])]);
    expect(shape(again)).toEqual(shape(live));
  });
});
