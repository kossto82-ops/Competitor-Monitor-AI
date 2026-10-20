import { afterAll, describe, expect, it } from "vitest";
import type { ComparisonResult, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { createOrganizationWithOwner, updateOrganizationSettings } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { createRunningMonitoringJob, persistMonitoringResult } from "./monitoringPipeline.js";
import { backfillCapabilityObservations, getCapabilityMatrix, recordCapabilityObservations } from "./capabilities.js";

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
const TRANSFER = "Nous assurons le transfert d'appels vers votre mobile, avec prise de messages. Disponible 24h/24 et 7j/7.";
const FILLER = "Notre equipe accueille vos clients avec soin. ";

describe.skipIf(!reachable)("capability observations (Phase 29 F1)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeSource(packs?: string[]) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Capabilities ${runId}-${counter}`,
      email: `capabilities-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    if (packs) await prisma.organization.update({ where: { id: organization.id }, data: { capabilityPacks: packs } });
    const competitor = await createCompetitor(organization.id, { name: "Rival" });
    const url = await createMonitoredUrl(organization.id, competitor.id, { url: `https://caps-${counter}.example.test/services`, category: "GENERAL" });
    return { organization, competitor, url };
  }
  const observe = (ids: { organization: { id: string }; competitor: { id: string }; url: { id: string } }, text: string, at = new Date()) =>
    prisma.$transaction((tx) => recordCapabilityObservations(tx, { organizationId: ids.organization.id, competitorId: ids.competitor.id, monitoredUrlId: ids.url.id, observedAt: at, text }));
  const rows = (urlId: string) => prisma.capabilityObservation.findMany({ where: { monitoredUrlId: urlId }, orderBy: { capabilityKey: "asc" } });

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("records what the page says, with the passage that shows it, only for the packs the organization enabled", async () => {
    const both = await makeSource(["general", "call-answering"]);
    expect(await observe(both, FILLER + TRANSFER)).toMatchObject({ found: 3 });
    const found = await rows(both.url.id);
    expect(found.map((r) => r.capabilityKey)).toEqual(["call_transfer", "message_taking", "support_24_7"]);
    expect(found[0]).toMatchObject({ state: "PRESENT", method: "DETERMINISTIC", missCount: 0 });
    expect(found[0]!.evidence).toContain("transfert d'appels");

    const general = await makeSource();
    await observe(general, FILLER + TRANSFER);
    expect((await rows(general.url.id)).map((r) => r.capabilityKey)).toEqual(["support_24_7"]); // call-answering is not enabled
    const none = await makeSource([]);
    expect(await observe(none, TRANSFER)).toEqual({ found: 0, becameAbsent: 0 });
  });

  it("does not call a capability gone after one bad capture, only after several verified scans in a row without it", async () => {
    const ids = await makeSource(["general", "call-answering"]);
    await observe(ids, TRANSFER);
    expect(await observe(ids, "Page under maintenance. ".repeat(5))).toEqual({ found: 0, becameAbsent: 0 }); // first miss
    expect((await rows(ids.url.id)).every((r) => r.state === "PRESENT" && r.missCount === 1)).toBe(true);
    await observe(ids, TRANSFER); // it is back: the counter resets
    expect((await rows(ids.url.id)).every((r) => r.state === "PRESENT" && r.missCount === 0)).toBe(true);
    await observe(ids, "Nothing about services here.");
    const second = await observe(ids, "Still nothing about services.");
    expect(second.becameAbsent).toBe(3);
    const gone = await rows(ids.url.id);
    expect(gone.every((r) => r.state === "ABSENT" && r.absentSince !== null)).toBe(true);
    await observe(ids, TRANSFER); // and it returns
    expect((await rows(ids.url.id)).every((r) => r.state === "PRESENT" && r.absentSince === null)).toBe(true);
  });

  it("keeps the first time it was seen, and refreshes the passage and the last time", async () => {
    const ids = await makeSource();
    const first = new Date(Date.now() - 5 * 86_400_000);
    await observe(ids, "Available 24/7 for everyone.", first);
    await observe(ids, "Our support is available 24/7, every week of the year.", new Date());
    const [row] = await rows(ids.url.id);
    expect(row!.firstSeenAt.getTime()).toBe(first.getTime());
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(first.getTime());
    expect(row!.evidence).toContain("every week of the year");
  });

  it("is written by the pipeline for a verified scan, and by nothing else", async () => {
    const ids = await makeSource(["general", "call-answering"]);
    const scan = async (state: ComparisonResult["verificationState"], text: string, errorMessage: string | null = null) => {
      const job = await createRunningMonitoringJob(ids.organization.id, ids.url.id);
      await persistMonitoringResult(job.id, {
        organizationId: ids.organization.id,
        monitoredUrlId: ids.url.id,
        previousSnapshotId: null,
        extraction: { method: "CHEERIO", requestedUrl: "https://x.test/", finalUrl: "https://x.test/", httpStatus: 200, errorMessage, normalizedContent: text, contentHash: "h", structuredDataHash: null, extractedEntities: [], confidence: 1, warnings: [], durationMs: 1 } as ExtractionResult,
        comparison: { verificationState: state, changeEvents: [] } as ComparisonResult,
        usage,
      });
    };
    await scan("FAILED_TO_VERIFY", TRANSFER);
    expect(await rows(ids.url.id)).toEqual([]);
    await scan("NO_CHANGE", "x", "HTTP 403");
    expect(await rows(ids.url.id)).toEqual([]);
    await scan("NO_CHANGE", TRANSFER);
    expect((await rows(ids.url.id)).map((r) => r.capabilityKey)).toEqual(["call_transfer", "message_taking", "support_24_7"]);
  });

  it("builds the matrix: one column per competitor, a cell per capability with its evidence, and 'not seen' as a missing cell", async () => {
    const ids = await makeSource(["general", "call-answering"]);
    const other = await createCompetitor(ids.organization.id, { name: "Quiet" });
    const otherUrl = await createMonitoredUrl(ids.organization.id, other.id, { url: `https://quiet-${counter}.example.test/`, category: "GENERAL" });
    await observe(ids, TRANSFER);
    await observe({ organization: ids.organization, competitor: other, url: otherUrl }, "Welcome. Contact us.");

    const matrix = await getCapabilityMatrix(ids.organization.id);
    expect(matrix.packs.sort()).toEqual(["call-answering", "general"]);
    expect(matrix.capabilities.find((c) => c.key === "call_transfer")).toMatchObject({ label: "Call transfer", category: "SERVICE", pack: "call-answering" });
    const rival = matrix.competitors.find((c) => c.name === "Rival")!;
    const quiet = matrix.competitors.find((c) => c.name === "Quiet")!;
    expect(rival.cells["call_transfer"]).toMatchObject({ state: "PRESENT" });
    expect(rival.cells["call_transfer"]!.evidence).toContain("transfert d'appels");
    expect(quiet.cells["call_transfer"]).toBeUndefined();
    expect(Object.keys(quiet.cells)).toEqual([]);
  });

  it("builds the same observations from stored snapshots (backfill), leaving a page that already has them alone", async () => {
    const ids = await makeSource(["general", "call-answering"]);
    for (const text of [TRANSFER, TRANSFER]) {
      const job = await prisma.monitoringJob.create({ data: { organizationId: ids.organization.id, monitoredUrlId: ids.url.id, status: "COMPLETED" } });
      await prisma.snapshot.create({ data: { organizationId: ids.organization.id, monitoredUrlId: ids.url.id, monitoringJobId: job.id, extractionMethod: "CHEERIO", verificationState: "NO_CHANGE", normalizedContent: text, confidence: 1 } });
    }
    const failed = await prisma.monitoringJob.create({ data: { organizationId: ids.organization.id, monitoredUrlId: ids.url.id, status: "FAILED" } });
    await prisma.snapshot.create({ data: { organizationId: ids.organization.id, monitoredUrlId: ids.url.id, monitoringJobId: failed.id, extractionMethod: "CHEERIO", verificationState: "FAILED_TO_VERIFY", normalizedContent: "", confidence: 0 } });

    expect(await backfillCapabilityObservations(ids.organization.id)).toEqual({ pages: 1, snapshots: 2 }); // the unverified one is skipped
    expect((await rows(ids.url.id)).map((r) => r.capabilityKey)).toEqual(["call_transfer", "message_taking", "support_24_7"]);
    expect(await backfillCapabilityObservations(ids.organization.id)).toEqual({ pages: 0, snapshots: 0 });
    expect(await backfillCapabilityObservations(ids.organization.id, { force: true })).toEqual({ pages: 1, snapshots: 2 });
  });

  it("is tenant-scoped and lets the packs be changed through the settings", async () => {
    const mine = await makeSource(["general", "call-answering"]);
    const other = await makeSource();
    await observe(mine, TRANSFER);
    expect((await getCapabilityMatrix(other.organization.id)).competitors.every((c) => Object.keys(c.cells).length === 0)).toBe(true);
    await updateOrganizationSettings(other.organization.id, { capabilityPacks: ["call-answering", "call-answering"] });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: other.organization.id } })).capabilityPacks).toEqual(["call-answering"]);
  });
});
