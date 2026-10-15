import {
  DEFAULT_MARKET_PATTERN_CONFIG,
  detectMarketPatterns,
  type MarketPatternConfig,
  type MarketPatternKind,
  type MarketPatternResult,
  type SignalKind,
} from "@cma/core";
import { prisma } from "../client.js";

const DAY_MS = 24 * 60 * 60_000;

/** The competitors of the organization with how long each has really been observed (its first verified scan). */
async function loadObservedCompetitors(organizationId: string) {
  const competitors = await prisma.competitor.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, name: true, monitoredUrls: { select: { id: true } } },
  });
  const firstScans = await prisma.snapshot.groupBy({
    by: ["monitoredUrlId"],
    where: { organizationId, verificationState: { not: "FAILED_TO_VERIFY" } },
    _min: { fetchedAt: true },
  });
  const firstByUrl = new Map(firstScans.map((r) => [r.monitoredUrlId, r._min.fetchedAt]));
  const observed = [];
  for (const competitor of competitors) {
    const dates = competitor.monitoredUrls.map((u) => firstByUrl.get(u.id)).filter((d): d is Date => d instanceof Date);
    if (dates.length === 0) continue; // never verified: nothing to say about it yet
    observed.push({ id: competitor.id, name: competitor.name, observedSince: new Date(Math.min(...dates.map((d) => d.getTime()))) });
  }
  return observed;
}

async function evaluate(organizationId: string, now: Date, config: MarketPatternConfig): Promise<{ result: MarketPatternResult; signalCount: number }> {
  const [competitors, signals] = await Promise.all([
    loadObservedCompetitors(organizationId),
    prisma.signal.findMany({
      where: { organizationId, occurredAt: { gte: new Date(now.getTime() - config.windowDays * DAY_MS), lte: now } },
      select: { id: true, kind: true, competitorId: true, occurredAt: true, percentageChange: true },
    }),
  ]);
  const result = detectMarketPatterns(
    signals.map((s) => ({ id: s.id, kind: s.kind as SignalKind, competitorId: s.competitorId, occurredAt: s.occurredAt, percentageChange: s.percentageChange })),
    competitors,
    now,
    config,
  );
  return { result, signalCount: signals.length };
}

export interface RefreshPatternsResult {
  status: MarketPatternResult["status"];
  created: number;
  updated: number;
  resolved: number;
}

/**
 * Keeps the organization's market patterns up to date. A pattern that holds is created once and then updated
 * (its first detection stays); one that stops holding is marked RESOLVED, not deleted, so that what happened is
 * still visible; and when the sample is too small nothing is claimed (an active pattern is left as it was
 * rather than being resolved by a lack of data). Idempotent.
 */
export async function refreshMarketPatterns(organizationId: string, options: { now?: Date; config?: MarketPatternConfig } = {}): Promise<RefreshPatternsResult> {
  const now = options.now ?? new Date();
  const { result } = await evaluate(organizationId, now, options.config ?? DEFAULT_MARKET_PATTERN_CONFIG);
  const outcome: RefreshPatternsResult = { status: result.status, created: 0, updated: 0, resolved: 0 };
  if (result.status === "INSUFFICIENT_SAMPLE") return outcome;

  const active = await prisma.marketPattern.findMany({ where: { organizationId, status: "ACTIVE" } });
  const activeByKind = new Map(active.map((p) => [p.kind, p]));
  const holding = new Set<MarketPatternKind>();

  for (const pattern of result.patterns) {
    holding.add(pattern.kind);
    const evidence = pattern.affected.flatMap((a) => a.signalIds.map((signalId) => ({ organizationId, competitorId: a.competitorId, competitorName: a.name, signalId })));
    const existing = activeByKind.get(pattern.kind);
    const data = {
      ruleVersion: pattern.ruleVersion,
      windowStart: pattern.windowStart,
      windowEnd: pattern.windowEnd,
      affectedCount: pattern.affectedCount,
      observedCount: pattern.observedCount,
      share: pattern.share,
      summary: pattern.summary,
      lastConfirmedAt: now,
    };
    if (existing) {
      await prisma.$transaction([
        prisma.marketPatternEvidence.deleteMany({ where: { patternId: existing.id } }),
        prisma.marketPattern.update({ where: { id: existing.id }, data: { ...data, evidence: { create: evidence } } }),
      ]);
      outcome.updated += 1;
    } else {
      await prisma.marketPattern.create({ data: { organizationId, kind: pattern.kind, ...data, firstDetectedAt: now, evidence: { create: evidence } } });
      outcome.created += 1;
    }
  }
  for (const pattern of active) {
    if (holding.has(pattern.kind)) continue;
    await prisma.marketPattern.update({ where: { id: pattern.id }, data: { status: "RESOLVED", resolvedAt: now } });
    outcome.resolved += 1;
  }
  return outcome;
}

export interface MarketPatternView {
  id: string;
  kind: MarketPatternKind;
  status: "ACTIVE" | "RESOLVED";
  epistemicLevel: string;
  summary: string;
  affectedCount: number;
  observedCount: number;
  share: number;
  firstDetectedAt: Date;
  lastConfirmedAt: Date;
  resolvedAt: Date | null;
  competitors: { competitorId: string; name: string; signalIds: string[] }[];
}

export interface MarketPatternOverview {
  /** Whether the sample is big enough to claim anything, and if not, why. Never hidden. */
  sample: { sufficient: boolean; reason: string | null; observedCount: number; eligibleCount: number };
  active: MarketPatternView[];
  /** The last few patterns that stopped holding. */
  recentlyResolved: MarketPatternView[];
}

/** What the market looks like now: the sample, the patterns that hold, and the ones that ended recently (tenant-scoped). */
export async function getMarketPatternOverview(organizationId: string, options: { now?: Date; config?: MarketPatternConfig } = {}): Promise<MarketPatternOverview> {
  const now = options.now ?? new Date();
  const { result } = await evaluate(organizationId, now, options.config ?? DEFAULT_MARKET_PATTERN_CONFIG);
  const rows = await prisma.marketPattern.findMany({
    where: { organizationId, OR: [{ status: "ACTIVE" }, { status: "RESOLVED", resolvedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }] },
    orderBy: [{ status: "asc" }, { share: "desc" }, { lastConfirmedAt: "desc" }],
    take: 30,
    include: { evidence: { select: { competitorId: true, competitorName: true, signalId: true } } },
  });
  const view = (row: (typeof rows)[number]): MarketPatternView => {
    const byCompetitor = new Map<string, { competitorId: string; name: string; signalIds: string[] }>();
    for (const e of row.evidence) {
      const entry = byCompetitor.get(e.competitorId) ?? { competitorId: e.competitorId, name: e.competitorName, signalIds: [] };
      entry.signalIds.push(e.signalId);
      byCompetitor.set(e.competitorId, entry);
    }
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      epistemicLevel: row.epistemicLevel,
      summary: row.summary,
      affectedCount: row.affectedCount,
      observedCount: row.observedCount,
      share: row.share,
      firstDetectedAt: row.firstDetectedAt,
      lastConfirmedAt: row.lastConfirmedAt,
      resolvedAt: row.resolvedAt,
      competitors: [...byCompetitor.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  };
  return {
    sample: {
      sufficient: result.status === "EVALUATED",
      reason: result.status === "INSUFFICIENT_SAMPLE" ? result.reason : null,
      observedCount: result.observedCount,
      eligibleCount: result.eligibleCount,
    },
    active: rows.filter((r) => r.status === "ACTIVE").map(view),
    recentlyResolved: rows.filter((r) => r.status === "RESOLVED").slice(0, 5).map(view),
  };
}
