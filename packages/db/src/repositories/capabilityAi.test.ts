import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createCompetitor } from "./competitors.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { getCapabilityMatrix, recordCapabilityObservations } from "./capabilities.js";
import {
  createCapabilityAiRun,
  createCustomCapability,
  deleteCustomCapability,
  listCustomCapabilities,
  MAX_PAGES_PER_AI_RUN,
  recordAiCapabilityFindings,
  selectPagesForCapabilityAi,
  updateCustomCapability,
} from "./capabilityAi.js";

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

describe.skipIf(!reachable)("custom capabilities and the on-demand AI check (Phase 29 F3)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(pages = 1) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({ organizationName: `CapAi ${runId}-${counter}`, email: `capai-${runId}-${counter}@example.test`, passwordHash: "not-a-real-hash" });
    createdOrgIds.push(organization.id);
    const competitor = await createCompetitor(organization.id, { name: "Rival" });
    const urls = [];
    for (let i = 0; i < pages; i += 1) urls.push(await createMonitoredUrl(organization.id, competitor.id, { url: `https://capai-${counter}-${i}.example.test/services`, category: "GENERAL" }));
    return { organization, competitor, urls, url: urls[0]! };
  }
  async function snapshot(ids: { organization: { id: string }; url: { id: string } }, text: string, state: "NO_CHANGE" | "CHANGED" | "FAILED_TO_VERIFY" = "CHANGED") {
    const job = await prisma.monitoringJob.create({ data: { organizationId: ids.organization.id, monitoredUrlId: ids.url.id, status: "COMPLETED" } });
    const snap = await prisma.snapshot.create({ data: { organizationId: ids.organization.id, monitoredUrlId: ids.url.id, monitoringJobId: job.id, extractionMethod: "CHEERIO", verificationState: state, normalizedContent: text, confidence: 1 } });
    await prisma.monitoredUrl.update({ where: { id: ids.url.id }, data: { lastSuccessfulScanAt: new Date() } });
    return snap;
  }
  const observe = (ids: { organization: { id: string }; competitor: { id: string }; url: { id: string } }, text: string) =>
    prisma.$transaction((tx) => recordCapabilityObservations(tx, { organizationId: ids.organization.id, competitorId: ids.competitor.id, monitoredUrlId: ids.url.id, observedAt: new Date(), text }));
  const rows = (urlId: string) => prisma.capabilityObservation.findMany({ where: { monitoredUrlId: urlId }, orderBy: { capabilityKey: "asc" } });

  afterAll(async () => {
    for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  });

  describe("the organization's own capabilities", () => {
    it("are matched by their phrases on every scan, literally, and show on the Features matrix as its own group", async () => {
      const ids = await makeOrg();
      const custom = await createCustomCapability(ids.organization.id, { label: "Answers in Catalan", description: "Takes calls in Catalan", phrases: ["en catalán", "C++ (beta)"] });
      await observe(ids, "Atendemos en catalán todos los días. Compatible con C++ (beta).");
      const found = await rows(ids.url.id);
      expect(found.map((r) => r.capabilityKey)).toEqual([`custom:${custom.id}`]);
      expect(found[0]).toMatchObject({ state: "PRESENT", method: "DETERMINISTIC", confidence: 0.85 });
      expect(found[0]!.evidence).toContain("en catalán");

      const matrix = await getCapabilityMatrix(ids.organization.id);
      expect(matrix.capabilities.find((c) => c.key === `custom:${custom.id}`)).toMatchObject({ label: "Answers in Catalan", pack: "custom" });
    });

    it("treat phrases as text, never as patterns, and a negation in the clause stops the match", async () => {
      const ids = await makeOrg();
      const custom = await createCustomCapability(ids.organization.id, { label: "Anything", description: "A wildcard-looking phrase", phrases: ["24.*7"] });
      await observe(ids, "Open 24 hours, 7 days a week.");
      expect(await rows(ids.url.id)).toEqual([]);
      await observe(ids, "We cover 24.*7 here.");
      expect((await rows(ids.url.id)).map((r) => r.capabilityKey)).toEqual([`custom:${custom.id}`]);

      const negated = await makeOrg();
      await createCustomCapability(negated.organization.id, { label: "Weekend", description: "Weekend cover", phrases: ["weekend cover"] });
      await observe(negated, "We do not offer weekend cover.");
      expect(await rows(negated.url.id)).toEqual([]);
    });

    it("are found at once on the pages already read, with no change event, and editing the phrases re-reads them", async () => {
      const ids = await makeOrg();
      await snapshot(ids, "Cobertura en catalán y castellano.");
      const custom = await createCustomCapability(ids.organization.id, { label: "Catalan", description: "Takes calls in Catalan", phrases: ["en catalán"] });
      expect((await rows(ids.url.id)).map((r) => r.capabilityKey)).toEqual([`custom:${custom.id}`]);
      expect(await prisma.changeEvent.count({ where: { organizationId: ids.organization.id } })).toBe(0);

      await updateCustomCapability(ids.organization.id, custom.id, { label: "Catalan", description: "Takes calls in Catalan", phrases: ["en gallego"] });
      expect(await rows(ids.url.id)).toEqual([]); // the old phrase no longer defines it
    });

    it("can be removed together with what was observed for them, are tenant-scoped and capped", async () => {
      const ids = await makeOrg();
      const other = await makeOrg();
      await snapshot(ids, "Cobertura en catalán.");
      const custom = await createCustomCapability(ids.organization.id, { label: "Catalan", description: "Takes calls in Catalan", phrases: ["en catalán"] });
      await expect(deleteCustomCapability(other.organization.id, custom.id)).rejects.toThrow();
      await expect(updateCustomCapability(other.organization.id, custom.id, { label: "x", description: "xxxxx", phrases: [] })).rejects.toThrow();
      await deleteCustomCapability(ids.organization.id, custom.id);
      expect(await rows(ids.url.id)).toEqual([]);
      expect(await listCustomCapabilities(ids.organization.id)).toEqual([]);

      for (let i = 0; i < 20; i += 1) await createCustomCapability(other.organization.id, { label: `Cap ${i}`, description: "Some capability", phrases: [] });
      await expect(createCustomCapability(other.organization.id, { label: "One too many", description: "Some capability", phrases: [] })).rejects.toThrow(/at most 20/);
    });

    it("raise a verified change event, like the built-in ones, when a page starts to claim one", async () => {
      const ids = await makeOrg();
      const custom = await createCustomCapability(ids.organization.id, { label: "Catalan", description: "Takes calls in Catalan", phrases: ["en catalán"] });
      const snap = await snapshot(ids, "Hola.");
      const result = await prisma.$transaction((tx) =>
        recordCapabilityObservations(tx, {
          organizationId: ids.organization.id,
          competitorId: ids.competitor.id,
          monitoredUrlId: ids.url.id,
          observedAt: new Date(),
          text: "Ahora atendemos en catalán.",
          change: { snapshotId: snap.id, previousSnapshotId: snap.id, baseline: false },
        }),
      );
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ changeType: "CAPABILITY_ADDED", entityKey: `capability:custom:${custom.id}`, newValue: "Catalan" });
    });
  });

  describe("the AI check", () => {
    const candidates = [{ key: "free_trial", label: "Free trial", description: null }, { key: "support_24_7", label: "Support or availability 24/7", description: null }];

    it("selects pages with a new verified snapshot, never half-built ones, asks only about what the rules did not find, and reads each snapshot once", async () => {
      const ids = await makeOrg(3);
      const [a, b, c] = ids.urls.map((url) => ({ organization: ids.organization, url }));
      const snapA = await snapshot(a!, "Disponible 24h/24. Una página real con texto suficiente.");
      await observe({ ...ids, url: ids.urls[0]! }, "Disponible 24h/24. Una página real con texto suficiente.");
      await snapshot(b!, "Compare plans Loading content...");
      await snapshot(c!, "Failed capture", "FAILED_TO_VERIFY");

      const first = await selectPagesForCapabilityAi(ids.organization.id);
      expect(first.remaining).toBe(0);
      expect(first.pages.map((p) => p.monitoredUrlId)).toEqual([ids.urls[0]!.id]);
      const keys = first.pages[0]!.candidates.map((x) => x.key);
      expect(keys).not.toContain("support_24_7"); // the rules already found it on this page
      expect(keys).toContain("free_trial");

      await recordAiCapabilityFindings({ organizationId: ids.organization.id, page: first.pages[0]!, accepted: [] });
      expect((await selectPagesForCapabilityAi(ids.organization.id)).pages).toEqual([]); // that snapshot was read

      await snapshot(a!, "Texto nuevo de la página con otra versión.");
      expect((await selectPagesForCapabilityAi(ids.organization.id)).pages).toHaveLength(1); // a newer snapshot is due
      expect(snapA.id).toBeTruthy();
    });

    it("reads a page again when the organization's own capabilities changed after it was read, and limits one run to a batch", async () => {
      const ids = await makeOrg();
      await snapshot(ids, "Una página con texto suficiente para ser leída.");
      const page = (await selectPagesForCapabilityAi(ids.organization.id)).pages[0]!;
      await recordAiCapabilityFindings({ organizationId: ids.organization.id, page, accepted: [] });
      expect((await selectPagesForCapabilityAi(ids.organization.id)).pages).toEqual([]);
      await createCustomCapability(ids.organization.id, { label: "Catalan", description: "Takes calls in Catalan", phrases: [] });
      expect((await selectPagesForCapabilityAi(ids.organization.id)).pages).toHaveLength(1);

      const many = await makeOrg(MAX_PAGES_PER_AI_RUN + 2);
      for (const url of many.urls) await snapshot({ organization: many.organization, url }, `Página ${url.id} con texto suficiente.`);
      const batch = await selectPagesForCapabilityAi(many.organization.id);
      expect(batch.pages).toHaveLength(MAX_PAGES_PER_AI_RUN);
      expect(batch.remaining).toBe(2);
    });

    it("stores findings as AI inferences that never raise change events, never overwrite what the rules found, and are dropped when no longer supported", async () => {
      const ids = await makeOrg();
      await snapshot(ids, "Estamos disponibles en cualquier momento, siempre. Prueba gratuita.");
      await observe(ids, "Prueba gratuita incluida."); // the rules find free_trial
      const page = (await selectPagesForCapabilityAi(ids.organization.id)).pages[0]!;
      const accepted = [
        { key: "support_24_7", evidence: "disponibles en cualquier momento, siempre", confidence: 0.7 },
        { key: "free_trial", evidence: "Prueba gratuita", confidence: 0.7 },
      ];
      const { stored } = await recordAiCapabilityFindings({ organizationId: ids.organization.id, page: { ...page, candidates: [...page.candidates, { key: "free_trial", label: "Free trial", description: null }] }, accepted });
      expect(stored).toBe(1); // free_trial was already a rule match
      const found = await rows(ids.url.id);
      expect(found.find((r) => r.capabilityKey === "support_24_7")).toMatchObject({ method: "AI", state: "PRESENT", confidence: 0.7 });
      expect(found.find((r) => r.capabilityKey === "free_trial")).toMatchObject({ method: "DETERMINISTIC", confidence: 0.85 });
      expect(await prisma.changeEvent.count({ where: { organizationId: ids.organization.id } })).toBe(0);

      // Deterministic scans do not count misses against an inference...
      await observe(ids, "Prueba gratuita incluida.");
      await observe(ids, "Prueba gratuita incluida.");
      expect((await rows(ids.url.id)).find((r) => r.capabilityKey === "support_24_7")).toMatchObject({ state: "PRESENT", method: "AI", missCount: 0 });
      // ...a later rule match takes it over without raising an "added" event...
      const taken = await observe(ids, "Prueba gratuita incluida. Disponible 24h/24.");
      expect(taken.events).toEqual([]);
      expect((await rows(ids.url.id)).find((r) => r.capabilityKey === "support_24_7")).toMatchObject({ method: "DETERMINISTIC", confidence: 0.85 });

      // ...and an inference the next check no longer supports is dropped.
      const ids2 = await makeOrg();
      await snapshot(ids2, "Una página con texto suficiente y otra frase.");
      const p2 = (await selectPagesForCapabilityAi(ids2.organization.id)).pages[0]!;
      await recordAiCapabilityFindings({ organizationId: ids2.organization.id, page: p2, accepted: [{ key: "free_trial", evidence: "texto suficiente", confidence: 0.55 }] });
      expect(await rows(ids2.url.id)).toHaveLength(1);
      await recordAiCapabilityFindings({ organizationId: ids2.organization.id, page: p2, accepted: [] });
      expect(await rows(ids2.url.id)).toHaveLength(0);
    });

    it("shows an inference in the matrix as AI, and a rule match wins over it on another page of the same competitor", async () => {
      const ids = await makeOrg(2);
      await snapshot({ organization: ids.organization, url: ids.urls[0]! }, "Texto suficiente de la primera página.");
      const page = (await selectPagesForCapabilityAi(ids.organization.id)).pages[0]!;
      await recordAiCapabilityFindings({ organizationId: ids.organization.id, page, accepted: [{ key: "free_trial", evidence: "Texto suficiente de la primera", confidence: 0.55 }] });
      let cell = (await getCapabilityMatrix(ids.organization.id)).competitors[0]!.cells["free_trial"];
      expect(cell).toMatchObject({ state: "PRESENT", method: "AI", confidence: 0.55 });
      await prisma.$transaction((tx) => recordCapabilityObservations(tx, { organizationId: ids.organization.id, competitorId: ids.competitor.id, monitoredUrlId: ids.urls[1]!.id, observedAt: new Date(), text: "Prueba gratuita de 14 días." }));
      cell = (await getCapabilityMatrix(ids.organization.id)).competitors[0]!.cells["free_trial"];
      expect(cell).toMatchObject({ state: "PRESENT", method: "DETERMINISTIC" });
    });

    it("never starts a second paid run while one is in flight, and never crosses organizations", async () => {
      const ids = await makeOrg();
      const other = await makeOrg();
      const first = await createCapabilityAiRun(ids.organization.id);
      expect(first.created).toBe(true);
      const second = await createCapabilityAiRun(ids.organization.id);
      expect(second).toMatchObject({ created: false });
      expect(second.run.id).toBe(first.run.id);
      expect((await createCapabilityAiRun(other.organization.id)).created).toBe(true);
      await prisma.capabilityAiRun.update({ where: { id: first.run.id }, data: { status: "COMPLETED" } });
      expect((await createCapabilityAiRun(ids.organization.id)).created).toBe(true);
      // A run that never finished (a crashed worker) stops blocking after the stale window.
      await prisma.capabilityAiRun.updateMany({ where: { organizationId: ids.organization.id, status: "PENDING" }, data: { requestedAt: new Date(Date.now() - 2 * 3_600_000) } });
      expect((await createCapabilityAiRun(ids.organization.id)).created).toBe(true);
    });
  });
});
