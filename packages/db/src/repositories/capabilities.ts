import {
  CAPABILITY_MISSES_BEFORE_ABSENT,
  CAPABILITY_PACKS,
  capabilitiesOfPacks,
  detectCapabilities,
  type CapabilityCategory,
  type CapabilityPack,
} from "@cma/core";
import type { Prisma } from "../../generated/client/index.js";
import { prisma } from "../client.js";

type Tx = Prisma.TransactionClient;

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
  input: { organizationId: string; competitorId: string; monitoredUrlId: string; observedAt: Date; text: string },
): Promise<{ found: number; becameAbsent: number }> {
  const { organizationId, competitorId, monitoredUrlId, observedAt, text } = input;
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { capabilityPacks: true } });
  const packs = packsOf(org?.capabilityPacks);
  if (packs.length === 0) return { found: 0, becameAbsent: 0 };

  const enabledKeys = new Set(capabilitiesOfPacks(packs).map((c) => c.key));
  const matches = detectCapabilities(text, packs);
  const matched = new Map(matches.map((m) => [m.key, m]));
  const existing = await tx.capabilityObservation.findMany({ where: { monitoredUrlId } });
  const existingByKey = new Map(existing.map((e) => [e.capabilityKey, e]));
  let becameAbsent = 0;

  for (const match of matches) {
    const row = existingByKey.get(match.key);
    if (!row) {
      await tx.capabilityObservation.create({
        data: { organizationId, competitorId, monitoredUrlId, capabilityKey: match.key, confidence: match.confidence, evidence: match.evidence, firstSeenAt: observedAt, lastSeenAt: observedAt },
      });
    } else {
      await tx.capabilityObservation.update({
        where: { id: row.id },
        data: { state: "PRESENT", missCount: 0, absentSince: null, lastSeenAt: observedAt, evidence: match.evidence, confidence: match.confidence },
      });
    }
  }
  for (const row of existing) {
    if (matched.has(row.capabilityKey) || !enabledKeys.has(row.capabilityKey) || row.state === "ABSENT") continue;
    const missCount = row.missCount + 1;
    const gone = missCount >= CAPABILITY_MISSES_BEFORE_ABSENT;
    await tx.capabilityObservation.update({ where: { id: row.id }, data: gone ? { missCount, state: "ABSENT", absentSince: observedAt } : { missCount } });
    if (gone) becameAbsent += 1;
  }
  return { found: matches.length, becameAbsent };
}

export interface CapabilityCell {
  state: "PRESENT" | "ABSENT";
  evidence: string;
  confidence: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  absentSince: Date | null;
}

export interface CapabilityMatrix {
  packs: CapabilityPack[];
  capabilities: { key: string; label: string; category: CapabilityCategory; pack: CapabilityPack }[];
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
  const definitions = capabilitiesOfPacks(packs);
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
        const cell: CapabilityCell = { state: row.state, evidence: row.evidence, confidence: row.confidence, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, absentSince: row.absentSince };
        const current = cells[row.capabilityKey];
        // A page that still says it beats one that stopped saying it; among equals the most recent wins.
        if (!current || (cell.state === "PRESENT" && current.state === "ABSENT") || (cell.state === current.state && cell.lastSeenAt > current.lastSeenAt)) cells[row.capabilityKey] = cell;
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
