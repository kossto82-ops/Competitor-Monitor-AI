import { afterAll, describe, expect, it } from "vitest";
import type { ComparisonResult, ExtractionResult } from "@cma/core";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { createRunningMonitoringJob, persistMonitoringResult, persistNotModifiedResult } from "./monitoringPipeline.js";

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

function extraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    method: "CHEERIO",
    requestedUrl: "https://pipeline.example.test/pricing",
    finalUrl: "https://pipeline.example.test/pricing",
    httpStatus: 200,
    errorMessage: null,
    normalizedContent: "Pro 10 USD",
    contentHash: "h1",
    structuredDataHash: null,
    extractedEntities: [],
    confidence: 1,
    warnings: [],
    durationMs: 5,
    ...overrides,
  };
}

const comparison = (verificationState: ComparisonResult["verificationState"]): ComparisonResult =>
  ({ verificationState, changeEvents: [] }) as unknown as ComparisonResult;

const usage = { browserEscalated: false, aiCallMade: false };

describe.skipIf(!reachable)("monitoring pipeline persistence (Phase 29 B3b)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeUrl() {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Pipeline persist ${runId}-${counter}`,
      email: `pipeline-persist-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: "Rival" });
    const url = await createMonitoredUrl(organization.id, competitor.id, {
      url: `https://pipeline-${counter}.example.test/pricing`,
      category: "GENERAL",
    });
    return { organization, url };
  }

  const reload = (id: string) => prisma.monitoredUrl.findUniqueOrThrow({ where: { id } });

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  it("stores the validators of a verified full fetch", async () => {
    const { organization, url } = await makeUrl();
    const job = await createRunningMonitoringJob(organization.id, url.id);
    await persistMonitoringResult(job.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      previousSnapshotId: null,
      extraction: extraction({ validators: { etag: '"v1"', lastModified: "Wed, 01 Oct 2026 10:00:00 GMT" } }),
      comparison: comparison("NO_CHANGE"),
      usage,
    });
    const row = await reload(url.id);
    expect(row.etag).toBe('"v1"');
    expect(row.lastModifiedHeader).toBe("Wed, 01 Oct 2026 10:00:00 GMT");
    expect(row.validatorsSetAt).not.toBeNull();
  });

  it("records the extractor version on the snapshot, defaulting to 1 for callers that do not send one", async () => {
    const { organization, url } = await makeUrl();
    const job = await createRunningMonitoringJob(organization.id, url.id);
    await persistMonitoringResult(job.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      previousSnapshotId: null,
      extraction: extraction({ extractorVersion: 2 }),
      comparison: comparison("NO_CHANGE"),
      usage,
    });
    const job2 = await createRunningMonitoringJob(organization.id, url.id);
    await persistMonitoringResult(job2.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      previousSnapshotId: null,
      extraction: extraction(),
      comparison: comparison("NO_CHANGE"),
      usage,
    });
    const rows = await prisma.snapshot.findMany({ where: { monitoredUrlId: url.id }, orderBy: { fetchedAt: "asc" } });
    expect(rows.map((x) => x.extractorVersion)).toEqual([2, 1]);
  });

  it("records the market a snapshot was requested in and the language the page declared", async () => {
    const { organization, url } = await makeUrl();
    const job = await createRunningMonitoringJob(organization.id, url.id);
    await persistMonitoringResult(job.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      previousSnapshotId: null,
      extraction: extraction({ requestedLocale: "es-ES", pageLanguage: "es-es" }),
      comparison: comparison("NO_CHANGE"),
      usage,
    });
    const job2 = await createRunningMonitoringJob(organization.id, url.id);
    await persistMonitoringResult(job2.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      previousSnapshotId: null,
      extraction: extraction(),
      comparison: comparison("NO_CHANGE"),
      usage,
    });
    const rows = await prisma.snapshot.findMany({ where: { monitoredUrlId: url.id }, orderBy: { fetchedAt: "asc" } });
    expect(rows.map((r) => [r.requestedLocale, r.pageLanguage])).toEqual([["es-ES", "es-es"], [null, null]]);
  });

  it("clears the validators after a failed scan, so the next scan is a full fetch", async () => {
    const { organization, url } = await makeUrl();
    await prisma.monitoredUrl.update({ where: { id: url.id }, data: { etag: '"old"', validatorsSetAt: new Date() } });
    const job = await createRunningMonitoringJob(organization.id, url.id);
    await persistMonitoringResult(job.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      previousSnapshotId: null,
      extraction: extraction({ httpStatus: 403, errorMessage: "Unexpected HTTP status 403", normalizedContent: "", contentHash: null }),
      comparison: comparison("FAILED_TO_VERIFY"),
      usage,
    });
    const row = await reload(url.id);
    expect(row.etag).toBeNull();
    expect(row.validatorsSetAt).toBeNull();
  });

  it("does not keep validators from a response that could not be verified", async () => {
    const { organization, url } = await makeUrl();
    const job = await createRunningMonitoringJob(organization.id, url.id);
    await persistMonitoringResult(job.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      previousSnapshotId: null,
      extraction: extraction({ validators: { etag: '"x"', lastModified: null } }),
      comparison: comparison("FAILED_TO_VERIFY"),
      usage,
    });
    expect((await reload(url.id)).etag).toBeNull();
  });

  it("persistNotModifiedResult completes the job and updates the URL without a snapshot or touching validators", async () => {
    const { organization, url } = await makeUrl();
    await prisma.monitoredUrl.update({
      where: { id: url.id },
      data: { etag: '"keep"', validatorsSetAt: new Date(Date.now() - 3_600_000), consecutiveFailureCount: 3 },
    });
    const job = await createRunningMonitoringJob(organization.id, url.id);

    await persistNotModifiedResult(job.id, {
      organizationId: organization.id,
      monitoredUrlId: url.id,
      extraction: extraction({ httpStatus: 304, notModified: true }),
      usage,
    });

    const row = await reload(url.id);
    expect(row.etag).toBe('"keep"');
    expect(row.consecutiveFailureCount).toBe(0);
    expect(row.lastSuccessfulScanAt).not.toBeNull();
    expect(row.lastAttemptAt).not.toBeNull();
    expect((await prisma.monitoringJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("COMPLETED");
    expect(await prisma.snapshot.count({ where: { monitoredUrlId: url.id } })).toBe(0);
    const record = await prisma.usageRecord.findFirstOrThrow({ where: { monitoringJobId: job.id } });
    expect(record.fetchSucceeded).toBe(true);
  });
});
