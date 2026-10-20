import {
  capabilitiesOfPacks,
  customCapabilityDefinition,
  detectWithDefinitions,
  looksPartiallyLoaded,
  MAX_CUSTOM_CAPABILITIES,
  MAX_CUSTOM_PHRASES,
  type CapabilityDefinition,
  type CapabilityPack,
  CAPABILITY_PACKS,
} from "@cma/core";
import { prisma } from "../client.js";
import { ConflictError, NotFoundError } from "./errors.js";

/** Pages one AI check reads. The rest are due for the next run: a bounded batch keeps the cost of one click known. */
export const MAX_PAGES_PER_AI_RUN = 10;
/** A run that never finished (a crashed worker) stops blocking new ones after this long. */
export const AI_RUN_STALE_MINUTES = 30;

export interface CustomCapabilityValues {
  label: string;
  description: string;
  phrases: string[];
}

function cleanValues(values: CustomCapabilityValues): CustomCapabilityValues {
  const phrases = [...new Set(values.phrases.map((p) => p.trim().replace(/\s+/g, " ")).filter((p) => p.length > 0))].slice(0, MAX_CUSTOM_PHRASES);
  return { label: values.label.trim(), description: values.description.trim(), phrases };
}

export async function listCustomCapabilities(organizationId: string) {
  return prisma.customCapability.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
}

/**
 * Phase 29 F3: the organization defines a capability of its own. Phrases are matched literally by every later
 * scan; the description is what the on-demand AI check is asked. The pages already read are searched once now
 * for the phrases (no AI, no change events: it is a new list, not a change of any page).
 */
export async function createCustomCapability(organizationId: string, values: CustomCapabilityValues) {
  const clean = cleanValues(values);
  const count = await prisma.customCapability.count({ where: { organizationId } });
  if (count >= MAX_CUSTOM_CAPABILITIES) throw new ConflictError(`An organization can define at most ${MAX_CUSTOM_CAPABILITIES} capabilities of its own.`);
  const created = await prisma.customCapability.create({ data: { organizationId, ...clean } });
  await applyCustomCapabilityToLatestPages(organizationId, created.id);
  return created;
}

export async function updateCustomCapability(organizationId: string, id: string, values: CustomCapabilityValues) {
  const existing = await prisma.customCapability.findFirst({ where: { id, organizationId } });
  if (!existing) throw new NotFoundError("Capability not found.");
  const updated = await prisma.customCapability.update({ where: { id }, data: cleanValues(values) });
  await applyCustomCapabilityToLatestPages(organizationId, id);
  return updated;
}

/** Deleting it also removes what was observed for it: nothing is left on the Features page pointing at a capability that no longer exists. */
export async function deleteCustomCapability(organizationId: string, id: string): Promise<void> {
  const existing = await prisma.customCapability.findFirst({ where: { id, organizationId } });
  if (!existing) throw new NotFoundError("Capability not found.");
  await prisma.$transaction([
    prisma.capabilityObservation.deleteMany({ where: { organizationId, capabilityKey: `custom:${id}` } }),
    prisma.customCapability.delete({ where: { id } }),
  ]);
}

/** Looks for a custom capability's phrases in the latest verified text of every page, writing observations only (never change events). */
async function applyCustomCapabilityToLatestPages(organizationId: string, id: string): Promise<void> {
  const row = await prisma.customCapability.findFirst({ where: { id, organizationId } });
  if (!row) return;
  const definition = customCapabilityDefinition({ key: `custom:${id}`, label: row.label, description: row.description, phrases: row.phrases });
  const pages = await prisma.monitoredUrl.findMany({
    where: { organizationId },
    select: {
      id: true,
      competitorId: true,
      snapshots: { where: { verificationState: { not: "FAILED_TO_VERIFY" } }, orderBy: { fetchedAt: "desc" }, take: 1, select: { fetchedAt: true, normalizedContent: true } },
    },
  });
  for (const page of pages) {
    const snapshot = page.snapshots[0];
    if (!snapshot) continue;
    const match = detectWithDefinitions(snapshot.normalizedContent, [definition])[0];
    const existing = await prisma.capabilityObservation.findUnique({ where: { monitoredUrlId_capabilityKey: { monitoredUrlId: page.id, capabilityKey: definition.key } } });
    if (match) {
      const data = { state: "PRESENT" as const, method: "DETERMINISTIC" as const, confidence: match.confidence, evidence: match.evidence, missCount: 0, absentSince: null, lastSeenAt: snapshot.fetchedAt };
      if (existing) await prisma.capabilityObservation.update({ where: { id: existing.id }, data });
      else await prisma.capabilityObservation.create({ data: { organizationId, competitorId: page.competitorId, monitoredUrlId: page.id, capabilityKey: definition.key, firstSeenAt: snapshot.fetchedAt, ...data } });
    } else if (existing && existing.method === "DETERMINISTIC") {
      // The phrases were edited and the page no longer matches them: the old observation is not evidence for the new definition.
      await prisma.capabilityObservation.delete({ where: { id: existing.id } });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The on-demand AI check
// ---------------------------------------------------------------------------------------------------------------

export async function getLatestCapabilityAiRun(organizationId: string) {
  return prisma.capabilityAiRun.findFirst({ where: { organizationId }, orderBy: { requestedAt: "desc" } });
}

/** A new PENDING run, or the one already in flight: a double click never starts two paid checks. */
export async function createCapabilityAiRun(organizationId: string): Promise<{ run: NonNullable<Awaited<ReturnType<typeof getLatestCapabilityAiRun>>>; created: boolean }> {
  const since = new Date(Date.now() - AI_RUN_STALE_MINUTES * 60_000);
  const active = await prisma.capabilityAiRun.findFirst({ where: { organizationId, status: { in: ["PENDING", "RUNNING"] }, requestedAt: { gte: since } }, orderBy: { requestedAt: "desc" } });
  if (active) return { run: active, created: false };
  return { run: await prisma.capabilityAiRun.create({ data: { organizationId } }), created: true };
}

export async function getCapabilityAiRunForOrgOrThrow(organizationId: string, id: string) {
  const run = await prisma.capabilityAiRun.findFirst({ where: { id, organizationId } });
  if (!run) throw new NotFoundError("Capability check not found.");
  return run;
}

export async function markCapabilityAiRunRunning(id: string) {
  return prisma.capabilityAiRun.update({ where: { id }, data: { status: "RUNNING", startedAt: new Date() } });
}

export async function markCapabilityAiRunFailed(id: string, errorMessage: string) {
  return prisma.capabilityAiRun.update({ where: { id }, data: { status: "FAILED", completedAt: new Date(), errorMessage: errorMessage.slice(0, 500) } });
}

export interface CompleteCapabilityAiRunInput {
  provider: string;
  model: string;
  pagesChecked: number;
  pagesRemaining: number;
  findings: number;
  rejectedCount: number;
  failedPages: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export async function markCapabilityAiRunCompleted(id: string, input: CompleteCapabilityAiRunInput) {
  return prisma.capabilityAiRun.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date(), ...input } });
}

export interface CapabilityAiCandidate {
  key: string;
  label: string;
  description: string | null;
}

export interface CapabilityAiPage {
  monitoredUrlId: string;
  competitorId: string;
  url: string;
  snapshotId: string;
  text: string;
  /** What the rules did not already find on this page: the only things worth asking about. */
  candidates: CapabilityAiCandidate[];
}

/**
 * The pages a check should read now: those with a verified snapshot the AI check has not read yet (or read before
 * the organization's own capabilities last changed), whole and not half-built, with at least one capability still
 * unaccounted for. Never-read pages go first. At most `limit`; the rest are counted, not read.
 */
export async function selectPagesForCapabilityAi(organizationId: string, limit: number = MAX_PAGES_PER_AI_RUN): Promise<{ pages: CapabilityAiPage[]; remaining: number }> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { capabilityPacks: true } });
  const packs = (org?.capabilityPacks ?? []).filter((p): p is CapabilityPack => (CAPABILITY_PACKS as readonly string[]).includes(p));
  const customs = await prisma.customCapability.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
  const customsChangedAt = customs.reduce<Date | null>((latest, c) => (latest === null || c.updatedAt > latest ? c.updatedAt : latest), null);
  const definitions: CapabilityDefinition[] = capabilitiesOfPacks(packs);
  const asked = [
    ...definitions.map((d): CapabilityAiCandidate => ({ key: d.key, label: d.label, description: null })),
    ...customs.map((c): CapabilityAiCandidate => ({ key: `custom:${c.id}`, label: c.label, description: c.description })),
  ];
  if (asked.length === 0) return { pages: [], remaining: 0 };

  const urls = await prisma.monitoredUrl.findMany({
    where: { organizationId, isActive: true },
    select: {
      id: true,
      competitorId: true,
      url: true,
      capabilityAiCheckedSnapshotId: true,
      capabilityAiCheckedAt: true,
      snapshots: { where: { verificationState: { not: "FAILED_TO_VERIFY" } }, orderBy: { fetchedAt: "desc" }, take: 1, select: { id: true, normalizedContent: true } },
      capabilityObservations: { where: { state: "PRESENT", method: "DETERMINISTIC" }, select: { capabilityKey: true } },
    },
  });

  const due: (CapabilityAiPage & { checkedAt: Date | null })[] = [];
  for (const u of urls) {
    const snapshot = u.snapshots[0];
    if (!snapshot || snapshot.normalizedContent.trim().length === 0 || looksPartiallyLoaded(snapshot.normalizedContent)) continue;
    const upToDate = u.capabilityAiCheckedSnapshotId === snapshot.id && u.capabilityAiCheckedAt !== null && (customsChangedAt === null || u.capabilityAiCheckedAt >= customsChangedAt);
    if (upToDate) continue;
    const found = new Set(u.capabilityObservations.map((o) => o.capabilityKey));
    const candidates = asked.filter((c) => !found.has(c.key));
    if (candidates.length === 0) continue;
    due.push({ monitoredUrlId: u.id, competitorId: u.competitorId, url: u.url, snapshotId: snapshot.id, text: snapshot.normalizedContent, candidates, checkedAt: u.capabilityAiCheckedAt });
  }
  due.sort((a, b) => (a.checkedAt?.getTime() ?? 0) - (b.checkedAt?.getTime() ?? 0));
  const pages = due.slice(0, limit).map(({ checkedAt: _checkedAt, ...page }) => page);
  return { pages, remaining: Math.max(0, due.length - pages.length) };
}

/**
 * Stores what the AI check found on one page as inferences (method AI, confidence below any rule match) and
 * remembers that this snapshot was read. Never overwrites what the rules found, never raises a change event, and
 * drops an earlier inference the model no longer supports.
 */
export async function recordAiCapabilityFindings(input: {
  organizationId: string;
  page: Pick<CapabilityAiPage, "monitoredUrlId" | "competitorId" | "snapshotId" | "candidates">;
  accepted: { key: string; evidence: string; confidence: number }[];
  now?: Date;
}): Promise<{ stored: number }> {
  const { organizationId, page, accepted } = input;
  const now = input.now ?? new Date();
  const askedKeys = new Set(page.candidates.map((c) => c.key));
  const acceptedByKey = new Map(accepted.filter((a) => askedKeys.has(a.key)).map((a) => [a.key, a]));
  let stored = 0;
  await prisma.$transaction(async (tx) => {
    const existing = await tx.capabilityObservation.findMany({ where: { monitoredUrlId: page.monitoredUrlId, capabilityKey: { in: [...askedKeys] } } });
    const byKey = new Map(existing.map((e) => [e.capabilityKey, e]));
    for (const key of askedKeys) {
      const row = byKey.get(key);
      const finding = acceptedByKey.get(key);
      if (row && row.method === "DETERMINISTIC" && row.state === "PRESENT") continue; // the rules found it: that stands
      if (finding) {
        const data = { state: "PRESENT" as const, method: "AI" as const, confidence: finding.confidence, evidence: finding.evidence, missCount: 0, absentSince: null, lastSeenAt: now };
        if (row) await tx.capabilityObservation.update({ where: { id: row.id }, data });
        else await tx.capabilityObservation.create({ data: { organizationId, competitorId: page.competitorId, monitoredUrlId: page.monitoredUrlId, capabilityKey: key, firstSeenAt: now, ...data } });
        stored += 1;
      } else if (row && row.method === "AI") {
        await tx.capabilityObservation.delete({ where: { id: row.id } });
      }
    }
    await tx.monitoredUrl.update({ where: { id: page.monitoredUrlId }, data: { capabilityAiCheckedSnapshotId: page.snapshotId, capabilityAiCheckedAt: now } });
  });
  return { stored };
}
