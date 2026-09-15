import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import {
  getAiAnalysisForChangeEvent,
  getOrCreatePendingAiAnalysis,
  markAiAnalysisCompleted,
  markAiAnalysisFailed,
  markAiAnalysisRunning,
} from "./aiAnalysis.js";
import { getChangeEventForOrg } from "./changeEvents.js";

/**
 * Phase 3 (Section 8/10/13). Same real-Postgres convention as
 * dashboard.test.ts and tenantIsolation.test.ts: skipped, not failed,
 * when unreachable.
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

describe.skipIf(!reachable)("AiAnalysis repository", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrgWithChangeEvent(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `AiAnalysis ${label} ${runId}-${counter}`,
      email: `ai-analysis-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);

    const competitor = await createCompetitor(organization.id, { name: `Competitor ${label}` });
    const monitoredUrl = await createMonitoredUrl(organization.id, competitor.id, {
      url: `https://competitor-${label.toLowerCase()}-${runId}-${counter}.example.test/pricing`,
      category: "PRICING_PAGE",
    });
    const job = await prisma.monitoringJob.create({
      data: { organizationId: organization.id, monitoredUrlId: monitoredUrl.id, status: "COMPLETED" },
    });
    const snapshot = await prisma.snapshot.create({
      data: {
        organizationId: organization.id,
        monitoredUrlId: monitoredUrl.id,
        monitoringJobId: job.id,
        extractionMethod: "CHEERIO",
        verificationState: "CHANGED",
        normalizedContent: "Pro Plan 39.00 EUR",
        confidence: 1,
      },
    });
    const changeEvent = await prisma.changeEvent.create({
      data: {
        organizationId: organization.id,
        monitoredUrlId: monitoredUrl.id,
        currentSnapshotId: snapshot.id,
        changeType: "PRICE_CHANGE",
        severity: "HIGH",
        confidence: 0.9,
        fieldPath: "product.price",
        oldValue: "49.00",
        newValue: "39.00",
        currency: "EUR",
        percentageChange: -20.41,
        evidenceExcerpt: "Pro Plan now 39.00 EUR",
      },
    });
    return { organization, changeEvent };
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("creates a PENDING row for a fresh ChangeEvent", async () => {
    const { organization, changeEvent } = await makeOrgWithChangeEvent("fresh");
    const analysis = await getOrCreatePendingAiAnalysis(organization.id, changeEvent.id, "v1");
    expect(analysis.status).toBe("PENDING");
    expect(analysis.organizationId).toBe(organization.id);
    expect(analysis.promptVersion).toBe("v1");
  });

  it("is idempotent - calling it twice for the same ChangeEvent returns the same row, not a duplicate (Section 10)", async () => {
    const { organization, changeEvent } = await makeOrgWithChangeEvent("idempotent");
    const first = await getOrCreatePendingAiAnalysis(organization.id, changeEvent.id, "v1");
    const second = await getOrCreatePendingAiAnalysis(organization.id, changeEvent.id, "v1");
    expect(second.id).toBe(first.id);

    const count = await prisma.aiAnalysis.count({ where: { changeEventId: changeEvent.id } });
    expect(count).toBe(1);
  });

  it("runs through PENDING -> RUNNING -> COMPLETED and persists the structured output, provider metadata, and promptVersion (Section 8, 16, 17)", async () => {
    const { organization, changeEvent } = await makeOrgWithChangeEvent("lifecycle");
    const pending = await getOrCreatePendingAiAnalysis(organization.id, changeEvent.id, "change-analysis-v1");

    const running = await markAiAnalysisRunning(pending.id);
    expect(running.status).toBe("RUNNING");
    expect(running.startedAt).not.toBeNull();

    const completed = await markAiAnalysisCompleted(pending.id, {
      provider: "fake",
      model: "fake-v1",
      summary: "The price dropped.",
      facts: ["The listed price changed from 49.00 to 39.00."],
      interpretations: ["This may make the offer more competitive."],
      speculation: [],
      confidence: "medium",
      inputTokens: 120,
      outputTokens: 40,
      durationMs: 850,
    });

    expect(completed.status).toBe("COMPLETED");
    expect(completed.provider).toBe("fake");
    expect(completed.model).toBe("fake-v1");
    expect(completed.promptVersion).toBe("change-analysis-v1");
    expect(completed.summary).toBe("The price dropped.");
    expect(completed.facts).toEqual(["The listed price changed from 49.00 to 39.00."]);
    expect(completed.confidence).toBe("medium");
    expect(completed.completedAt).not.toBeNull();
  });

  it("marks FAILED on provider failure without ever touching the underlying ChangeEvent (Section 9 & 14)", async () => {
    const { organization, changeEvent } = await makeOrgWithChangeEvent("failure");
    const pending = await getOrCreatePendingAiAnalysis(organization.id, changeEvent.id, "v1");
    await markAiAnalysisRunning(pending.id);
    const failed = await markAiAnalysisFailed(pending.id, "provider timed out");

    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toBe("provider timed out");

    const stillThere = await getChangeEventForOrg(organization.id, changeEvent.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.changeType).toBe("PRICE_CHANGE");
  });

  it("never overwrites an already-COMPLETED row on a duplicate delivery (Section 10 & 11)", async () => {
    const { organization, changeEvent } = await makeOrgWithChangeEvent("duplicate-delivery");
    const pending = await getOrCreatePendingAiAnalysis(organization.id, changeEvent.id, "v1");
    await markAiAnalysisRunning(pending.id);
    await markAiAnalysisCompleted(pending.id, {
      provider: "fake",
      model: "fake-v1",
      summary: "first summary",
      facts: [],
      interpretations: [],
      speculation: [],
      confidence: "high",
      durationMs: 10,
    });

    // A duplicate delivery re-runs the full lifecycle against the same row.
    await markAiAnalysisRunning(pending.id);
    const secondAttempt = await markAiAnalysisCompleted(pending.id, {
      provider: "fake",
      model: "fake-v1",
      summary: "second summary - should never be persisted",
      facts: [],
      interpretations: [],
      speculation: [],
      confidence: "low",
      durationMs: 10,
    });

    expect(secondAttempt.summary).toBe("first summary");
    expect(secondAttempt.confidence).toBe("high");
  });

  it("scopes lookups by organizationId - one org can never read another org's AiAnalysis (Section 13)", async () => {
    const a = await makeOrgWithChangeEvent("tenant-a");
    const b = await makeOrgWithChangeEvent("tenant-b");
    await getOrCreatePendingAiAnalysis(a.organization.id, a.changeEvent.id, "v1");

    const crossTenantRead = await getAiAnalysisForChangeEvent(b.organization.id, a.changeEvent.id);
    expect(crossTenantRead).toBeNull();

    const ownRead = await getAiAnalysisForChangeEvent(a.organization.id, a.changeEvent.id);
    expect(ownRead).not.toBeNull();
  });
});
