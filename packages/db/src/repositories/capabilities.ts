import {
  CAPABILITY_MISSES_BEFORE_ABSENT,
  CAPABILITY_PACKS,
  MASS_PLAN_CHANGE_THRESHOLD,
  looksPartiallyLoaded,
  capabilitiesOfPacks,
  capabilityByKey,
  customCapabilityDefinition,
  detectCapabilities,
  detectWithDefinitions,
  type CapabilityDefinition,
  type CapabilityCategory,
  type CapabilityPack,
} from "@cma/core";
import type { Prisma } from "../../generated/client/index.js";
import { prisma } from "../client.js";

type Tx = Prisma.TransactionClient;

/** The organization's own capabilities as rules the scan can run. Their key is custom:<id>. */
export async function customDefinitionsOf(tx: Pick<Tx, "customCapability">, organizationId: string): Promise<CapabilityDefinition[]> {
  const rows = await tx.customCapability.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => customCapabilityDefinition({ key: `custom:${r.id}`, label: r.label, description: r.description, phrases: r.phrases }));
}

function packsOf(value: string[] | null | undefined): CapabilityPack[] {
  return (value ?? []).filter((p): p is CapabilityPack => (CAPABILITY_PACKS as readonly string[]).includes(p));
}

/**
 * Phase 29 F1: folds what one verified scan's text says into the capability observations of that page. Runs in
 * the pipeline's transaction. A capability found is PRESENT (with the passage that shows it); one that was
 * present and is not found is only counted as missed, and turns ABSENT after several verified scans in a row
 * without it, so a single bad capture cannot remove it. Only the capabilities of the organization's enabled
 * packs are touched.
 */
export async function recordCapabilityObservations(
  tx: Tx,
  input: {
    organizationId: string;
    competitorId: string;
    monitoredUrlId: string;
    observedAt: Date;
    text: string;
    /**
     * Phase 29 F2: with a snapshot, a capability that appears or is gone becomes a verified ChangeEvent, unless
     * this scan is a baseline (the first one of the page, or one after the extractor or market changed: what
     * looks like a change is only a different reading) or so many capabilities moved at once that the page
     * changed layout rather than its offer. Without a snapshot (a backfill) only the observations are written.
     */
    change?: { snapshotId: string; previousSnapshotId: string | null; baseline: boolean };
  },
): Promise<{ found: number; becameAbsent: number; events: Awaited<ReturnType<Tx["changeEvent"]["create"]>>[] }> {
  const { organizationId, competitorId, monitoredUrlId, observedAt, text, change } = input;
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { capabilityPacks: true } });
  const packs = packsOf(org?.capabilityPacks);
  if (packs.length === 0) return { found: 0, becameAbsent: 0, events: [] };

  const customDefinitions = await customDefinitionsOf(tx, organizationId);
  const labelOf = new Map(customDefinitions.map((d) => [d.key, d.label]));
  const enabledKeys = new Set([...capabilitiesOfPacks(packs), ...customDefinitions].map((c) => c.key));
  const matches = [...detectCapabilities(text, packs), ...detectWithDefinitions(text, customDefinitions)];
  const matched = new Map(matches.map((m) => [m.key, m]));
  const existing = await tx.capabilityObservation.findMany({ where: { monitoredUrlId } });
  const existingByKey = new Map(existing.map((e) => [e.capabilityKey, e]));
  let becameAbsent = 0;
  const appeared: { key: string; evidence: string; confidence: number }[] = [];
  const disappeared: { key: string; evidence: string; confidence: number }[] = [];

  for (const match of matches) {
    const row = existingByKey.get(match.key);
    if (!row || row.state === "ABSENT") appeared.push({ key: match.key, evidence: match.evidence, confidence: match.confidence });
    if (!row) {
      await tx.capabilityObservation.create({
        data: { organizationId, competitorId, monitoredUrlId, capabilityKey: match.key, confidence: match.confidence, evidence: match.evidence, firstSeenAt: observedAt, lastSeenAt: observedAt },
      });
    } else {
      await tx.capabilityObservation.update({
        where: { id: row.id },
        data: { state: "PRESENT", method: "DETERMINISTIC", missCount: 0, absentSince: null, lastSeenAt: observedAt, evidence: match.evidence, confidence: match.confidence },
      });
    }
  }
  // A partly built page proves nothing by what it lacks: no misses are counted and no change is raised from it.
  const partial = looksPartiallyLoaded(text);
  for (const row of existing) {
    // An AI inference is not tracked by the rules: a scan that does not repeat it neither confirms nor removes it.
    if (partial || row.method === "AI" || matched.has(row.capabilityKey) || !enabledKeys.has(row.capabilityKey) || row.state === "ABSENT") continue;
    const missCount = row.missCount + 1;
    const gone = missCount >= CAPABILITY_MISSES_BEFORE_ABSENT;
    await tx.capabilityObservation.update({ where: { id: row.id }, data: gone ? { missCount, state: "ABSENT", absentSince: observedAt } : { missCount } });
    if (gone) {
      becameAbsent += 1;
      disappeared.push({ key: row.capabilityKey, evidence: row.evidence, confidence: row.confidence });
    }
  }

  const events: Awaited<ReturnType<Tx["changeEvent"]["create"]>>[] = [];
  if (change && !change.baseline && !partial) {
    const emit = async (kind: "CAPABILITY_ADDED" | "CAPABILITY_REMOVED", item: { key: string; evidence: string; confidence: number }) => {
      const label = capabilityByKey(item.key)?.label ?? labelOf.get(item.key) ?? item.key;
      events.push(
        await tx.changeEvent.create({
          data: {
            organizationId,
            monitoredUrlId,
            currentSnapshotId: change.snapshotId,
            previousSnapshotId: change.previousSnapshotId,
            changeType: kind,
            severity: "LOW",
            confidence: item.confidence,
            entityKey: `capability:${item.key}`,
            fieldPath: `capability:${item.key}`,
            oldValue: kind === "CAPABILITY_REMOVED" ? label : null,
            newValue: kind === "CAPABILITY_ADDED" ? label : null,
            evidenceExcerpt:
              kind === "CAPABILITY_ADDED"
                ? `The page now says: "${item.evidence}"`
                : `The page stopped saying this after ${CAPABILITY_MISSES_BEFORE_ABSENT} verified scans in a row. It used to say: "${item.evidence}"`,
          },
        }),
      );
    };
    // Many at once is a different page, not a different offer: the observations above stay, the events are not raised.
    if (appeared.length < MASS_PLAN_CHANGE_THRESHOLD) for (const item of appeared) await emit("CAPABILITY_ADDED", item);
    if (disappeared.length < MASS_PLAN_CHANGE_THRESHOLD) for (const item of disappeared) await emit("CAPABILITY_REMOVED", item);
  }
  return { found: matches.length, becameAbsent, events };
}

export interface CapabilityCell {
  state: "PRESENT" | "ABSENT";
  /** DETERMINISTIC: a phrase was found by the rules. AI: an inference from the on-demand check, always shown as such. */
  method: "DETERMINISTIC" | "AI";
  evidence: string;
  confidence: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  absentSince: Date | null;
}

export interface CapabilityMatrix {
  packs: CapabilityPack[];
  capabilities: { key: string; label: string; category: CapabilityCategory; pack: CapabilityPack | "custom" }[];
  competitors: {
    id: string;
    name: string;
    /** Scans of its pages that were verified: how much there is behind a "not seen". */
    verifiedPages: number;
    cells: Record<string, CapabilityCell | undefined>;
  }[];
}

/** Capabilities x competitors for the organization's enabled packs (tenant-scoped). A competitor with several pages is present if any page says so. */
export async function getCapabilityMatrix(organizationId: string): Promise<CapabilityMatrix> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { capabilityPacks: true } });
  const packs = packsOf(org?.capabilityPacks);
  const definitions: CapabilityDefinition[] = [...capabilitiesOfPacks(packs), ...(await customDefinitionsOf(prisma, organizationId))];
  const keys = new Set(definitions.map((d) => d.key));

  const competitors = await prisma.competitor.findMany({
    where: { organizationId, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, monitoredUrls: { select: { id: true, lastSuccessfulScanAt: true } } },
  });
  const rows = await prisma.capabilityObservation.findMany({ where: { organizationId } });
  const byCompetitor = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!keys.has(row.capabilityKey)) continue;
    byCompetitor.set(row.competitorId, [...(byCompetitor.get(row.competitorId) ?? []), row]);
  }

  return {
    packs,
    capabilities: definitions.map((d) => ({ key: d.key, label: d.label, category: d.category, pack: d.pack })),
    competitors: competitors.map((c) => {
      const cells: Record<string, CapabilityCell | undefined> = {};
      for (const row of byCompetitor.get(c.id) ?? []) {
        const cell: CapabilityCell = { state: row.state, method: row.method, evidence: row.evidence, confidence: row.confidence, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, absentSince: row.absentSince };
        const current = cells[row.capabilityKey];
        // A page that still says it beats one that stopped saying it, and a phrase the rules found beats an inference; among equals the most recent wins.
        const rank = (c: CapabilityCell) => (c.state === "PRESENT" ? 2 : 0) + (c.method === "DETERMINISTIC" ? 1 : 0);
        if (!current || rank(cell) > rank(current) || (rank(cell) === rank(current) && cell.lastSeenAt > current.lastSeenAt)) cells[row.capabilityKey] = cell;
      }
      return { id: c.id, name: c.name, verifiedPages: c.monitoredUrls.filter((u) => u.lastSuccessfulScanAt !== null).length, cells };
    }),
  };
}

/**
 * Builds the capability observations of existing data by replaying the verified snapshots of each page in order
 * through the same rules. A page that already has observations is left alone unless `force` is set.
 */
export async function backfillCapabilityObservations(organizationId: string, options: { force?: boolean } = {}): Promise<{ pages: number; snapshots: number }> {
  const sources = await prisma.monitoredUrl.findMany({ where: { organizationId }, select: { id: true, competitorId: true } });
  const result = { pages: 0, snapshots: 0 };
  for (const source of sources) {
    const existing = await prisma.capabilityObservation.count({ where: { monitoredUrlId: source.id } });
    if (existing > 0 && !options.force) continue;
    if (existing > 0) await prisma.capabilityObservation.deleteMany({ where: { monitoredUrlId: source.id } });
    const snapshots = await prisma.snapshot.findMany({
      where: { organizationId, monitoredUrlId: source.id, verificationState: { not: "FAILED_TO_VERIFY" } },
      orderBy: { fetchedAt: "asc" },
      select: { fetchedAt: true, normalizedContent: true },
    });
    if (snapshots.length > 0) result.pages += 1;
    for (const snapshot of snapshots) {
      await prisma.$transaction((tx) => recordCapabilityObservations(tx, { organizationId, competitorId: source.competitorId, monitoredUrlId: source.id, observedAt: snapshot.fetchedAt, text: snapshot.normalizedContent }));
      result.snapshots += 1;
    }
  }
  return result;
}
