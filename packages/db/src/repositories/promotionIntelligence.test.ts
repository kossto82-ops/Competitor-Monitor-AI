import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { listChangeEventsForOrg } from "./changeEvents.js";
import { getDigestForOrganization, getOrgActivityMetrics, type ChangeEventDigestItem } from "./intelligence.js";
import type { ChangeType } from "../../generated/client/index.js";

/**
 * Phase 23 (Commercial Offer & Promotion Intelligence): verifies the
 * full downstream path once a PROMOTION_ADDED / PROMOTION_CHANGE /
 * PROMOTION_REMOVED ChangeEvent exists - historical retention (Section
 * 8 of the brief: a removed promotion must remain visible in history,
 * never overwritten), Digest inclusion without duplication (Section 9),
 * and the activity byType breakdown. Same real-Postgres,
 * skip-if-unreachable convention as intelligence.test.ts /
 * tenantIsolation.test.ts - detection logic itself (which ChangeType
 * gets produced from which entity diff) is unit-tested without a
 * database in packages/detection/src/compare.test.ts.
 */
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

describe.skipIf(!reachable)("promotion intelligence (Phase 23)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrgWithCompetitor(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Promo ${label} ${runId}-${counter}`,
      email: `promo-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: `Competitor ${label}` });
    const monitoredUrl = await createMonitoredUrl(organization.id, competitor.id, {
      url: `https://promo-${label.toLowerCase()}.example.test/pricing`,
      category: "PRICING_PAGE",
    });
    return { organization, competitor, monitoredUrl };
  }

  async function createPromotionChangeEvent(
    organizationId: string,
    monitoredUrlId: string,
    changeType: ChangeType,
    oldValue: string | null,
    newValue: string | null,
    detectedAt: Date,
  ) {
    const job = await prisma.monitoringJob.create({
      data: { organizationId, monitoredUrlId, status: "COMPLETED" },
    });
    const snapshot = await prisma.snapshot.create({
      data: {
        organizationId,
        monitoredUrlId,
        monitoringJobId: job.id,
        extractionMethod: "CHEERIO",
        verificationState: "CHANGED",
        normalizedContent: "content",
        confidence: 1,
      },
    });
    return prisma.changeEvent.create({
      data: {
        organizationId,
        monitoredUrlId,
        currentSnapshotId: snapshot.id,
        changeType,
        severity: "MEDIUM",
        confidence: 0.75,
        entityKey: "jsonld-promo:pro plan",
        fieldPath: "jsonld-promo:pro plan",
        oldValue,
        newValue,
        currency: "EUR",
        evidenceExcerpt: `Pro Plan: ${oldValue ?? "?"} -> ${newValue ?? "?"}`,
        detectedAt,
      },
    });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("retains the full promotion lifecycle (added -> changed -> removed) as history, even though the promotion is no longer 'current'", async () => {
    const { organization, monitoredUrl } = await makeOrgWithCompetitor("History");
    const day1 = new Date("2026-09-01T10:00:00.000Z");
    const day15 = new Date("2026-09-15T10:00:00.000Z");
    const day30 = new Date("2026-09-30T10:00:00.000Z");

    await createPromotionChangeEvent(organization.id, monitoredUrl.id, "PROMOTION_ADDED", null, "discount=20", day1);
    await createPromotionChangeEvent(organization.id, monitoredUrl.id, "PROMOTION_CHANGE", "discount=20", "discount=30", day15);
    await createPromotionChangeEvent(organization.id, monitoredUrl.id, "PROMOTION_REMOVED", "discount=30", null, day30);

    // The "current" state (no promotion) is what a fresh extraction of the live page would show -
    // history must NOT be overwritten or collapsed to reflect only that current state.
    const history = await listChangeEventsForOrg(organization.id, { monitoredUrlId: monitoredUrl.id });
    const promotionEvents = history.filter((e) => e.changeType.startsWith("PROMOTION_"));
    expect(promotionEvents).toHaveLength(3);

    // Newest-first ordering (listChangeEventsForOrg's documented contract) - the removal is
    // still the most recent fact, but the full chain remains queryable.
    expect(promotionEvents.map((e) => e.changeType)).toEqual(["PROMOTION_REMOVED", "PROMOTION_CHANGE", "PROMOTION_ADDED"]);
    expect(promotionEvents.map((e) => e.newValue)).toEqual([null, "discount=30", "discount=20"]);
    expect(promotionEvents.map((e) => e.oldValue)).toEqual(["discount=30", "discount=20", null]);
  });

  it("counts PROMOTION_ADDED/PROMOTION_CHANGE/PROMOTION_REMOVED separately in the activity byType breakdown", async () => {
    const { organization, monitoredUrl } = await makeOrgWithCompetitor("Activity");
    const now = new Date();

    await createPromotionChangeEvent(organization.id, monitoredUrl.id, "PROMOTION_ADDED", null, "discount=10", now);
    await createPromotionChangeEvent(organization.id, monitoredUrl.id, "PROMOTION_CHANGE", "discount=10", "discount=15", now);
    await createPromotionChangeEvent(organization.id, monitoredUrl.id, "PROMOTION_REMOVED", "discount=15", null, now);

    const metrics = await getOrgActivityMetrics(organization.id, 7, "UTC");
    const byType = new Map(metrics.byType.map((r) => [r.changeType, r.current]));
    expect(byType.get("PROMOTION_ADDED")).toBe(1);
    expect(byType.get("PROMOTION_CHANGE")).toBe(1);
    expect(byType.get("PROMOTION_REMOVED")).toBe(1);
  });

  it("exposes each promotion ChangeEvent exactly once in the Digest, with evidence linking back to the real ChangeEvent id", async () => {
    const { organization, monitoredUrl } = await makeOrgWithCompetitor("Digest");
    const now = new Date();

    const added = await createPromotionChangeEvent(organization.id, monitoredUrl.id, "PROMOTION_ADDED", null, "discount=25", now);

    const digest = await getDigestForOrganization(organization.id, 7, "UTC", new Date(now.getTime() + 1000));
    const changeEventItems = digest.items.filter((i): i is ChangeEventDigestItem => i.kind === "CHANGE_EVENT");
    const matching = changeEventItems.filter((i) => i.changeEventId === added.id);

    expect(matching).toHaveLength(1); // no duplication across any digest composition step
    expect(matching[0]!.changeType).toBe("PROMOTION_ADDED");
    expect(matching[0]!.description).toContain("discount=25");
  });
});
