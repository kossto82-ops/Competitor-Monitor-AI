import {
  DEFAULT_IMPORTANCE_CONFIG,
  IMPORTANCE_FACTORS,
  prioritizeSignals,
  validateImportanceConfig,
  type CompetitorRelevance,
  type ImportanceConfig,
  type ScoredSignal,
  type SignalForScoring,
  type SignalKind,
} from "@cma/core";
import { prisma } from "../client.js";
import { listSignals, type SignalListItem } from "./signals.js";
import { NotFoundError } from "./errors.js";

/** The organization's current weights: its newest saved version, or the built-in default when it never saved one. */
export async function getActiveImportanceConfig(organizationId: string): Promise<ImportanceConfig> {
  const row = await prisma.importanceConfig.findFirst({ where: { organizationId }, orderBy: { version: "desc" } });
  if (!row) return DEFAULT_IMPORTANCE_CONFIG;
  return {
    version: row.version,
    weights: row.weights as ImportanceConfig["weights"],
    kindEmphasis: row.kindEmphasis as ImportanceConfig["kindEmphasis"],
    tiers: row.tiers as ImportanceConfig["tiers"],
    recencyHalfLifeDays: row.recencyHalfLifeDays,
  };
}

export class InvalidImportanceConfigError extends Error {}

/**
 * Saves new weights as the next version (never edits one in place, so an old breakdown stays explainable).
 * Anything not given keeps the value of the version that is active now.
 */
export async function saveImportanceConfig(
  organizationId: string,
  input: Partial<Pick<ImportanceConfig, "weights" | "kindEmphasis" | "tiers" | "recencyHalfLifeDays">>,
): Promise<ImportanceConfig> {
  const current = await getActiveImportanceConfig(organizationId);
  const next = {
    weights: { ...current.weights, ...input.weights },
    kindEmphasis: { ...current.kindEmphasis, ...input.kindEmphasis },
    tiers: input.tiers ?? current.tiers,
    recencyHalfLifeDays: input.recencyHalfLifeDays ?? current.recencyHalfLifeDays,
  };
  const problem = validateImportanceConfig(next);
  if (problem) throw new InvalidImportanceConfigError(problem);

  // Two saves at once must not both claim the same version: the unique key makes the loser fail loudly.
  const latest = await prisma.importanceConfig.findFirst({ where: { organizationId }, orderBy: { version: "desc" }, select: { version: true } });
  const version = (latest?.version ?? DEFAULT_IMPORTANCE_CONFIG.version) + 1;
  await prisma.importanceConfig.create({
    data: { organizationId, version, weights: next.weights, kindEmphasis: next.kindEmphasis, tiers: next.tiers, recencyHalfLifeDays: next.recencyHalfLifeDays },
  });
  return { version, ...next };
}

/** How much the customer cares about a competitor: 1 low, 2 normal, 3 high (tenant-scoped). */
export async function setCompetitorRelevance(organizationId: string, competitorId: string, relevance: CompetitorRelevance): Promise<void> {
  if (![1, 2, 3].includes(relevance)) throw new InvalidImportanceConfigError("Relevance must be 1, 2 or 3.");
  const result = await prisma.competitor.updateMany({ where: { id: competitorId, organizationId }, data: { relevance } });
  if (result.count === 0) throw new NotFoundError("Competitor");
}

export interface PrioritizedSignal extends SignalListItem {
  importance: number;
  tier: ScoredSignal["tier"];
  factors: ScoredSignal["factors"];
  configVersion: number;
}

const CONTEXT_WINDOW_MS = 30 * 24 * 60 * 60_000;

/**
 * The signals of a period ranked by importance, each with its breakdown. The scoring itself is the pure
 * function in `@cma/core`; this only gathers what its factors need (other competitors' signals, each price's
 * earlier changes, how much the customer cares about each competitor).
 */
export async function listPrioritizedSignals(
  organizationId: string,
  options: { since?: Date; limit?: number; now?: Date } = {},
): Promise<{ config: ImportanceConfig; signals: PrioritizedSignal[] }> {
  const now = options.now ?? new Date();
  const config = await getActiveImportanceConfig(organizationId);
  const since = options.since ?? new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const shown = await listSignals(organizationId, { since, limit: options.limit ?? 100 });
  if (shown.length === 0) return { config, signals: [] };

  const contextRows = await prisma.signal.findMany({
    where: { organizationId, occurredAt: { gte: new Date(now.getTime() - CONTEXT_WINDOW_MS) } },
    select: { id: true, kind: true, entityKey: true, percentageChange: true, confidence: true, occurredAt: true, monitoredUrlId: true, competitorId: true },
    orderBy: { occurredAt: "desc" },
    take: 5000,
  });
  const toScoring = (r: { id: string; kind: string; entityKey: string | null; percentageChange: number | null; confidence: number; occurredAt: Date; monitoredUrlId: string; competitorId: string }): SignalForScoring => ({
    id: r.id,
    kind: r.kind as SignalKind,
    entityKey: r.entityKey,
    percentageChange: r.percentageChange,
    confidence: r.confidence,
    occurredAt: r.occurredAt,
    monitoredUrlId: r.monitoredUrlId,
    competitorId: r.competitorId,
  });
  const recentSignals = contextRows.map(toScoring);
  const scoring = shown.map((s) => toScoring({ ...s, competitorId: s.competitorId }));

  const competitors = await prisma.competitor.findMany({ where: { organizationId }, select: { id: true, relevance: true } });
  const competitorRelevance = new Map<string, CompetitorRelevance>(competitors.map((c) => [c.id, (c.relevance >= 1 && c.relevance <= 3 ? c.relevance : 2) as CompetitorRelevance]));

  // Earlier CHANGE versions per price or plan, from the entity history (Phase D1).
  const priorChangesByEntity = new Map<string, number>();
  const keyed = scoring.filter((s) => s.entityKey !== null);
  if (keyed.length > 0) {
    const versions = await prisma.entityVersion.findMany({
      where: { organizationId, origin: "CHANGE", entity: { monitoredUrlId: { in: [...new Set(keyed.map((s) => s.monitoredUrlId))] }, key: { in: [...new Set(keyed.map((s) => s.entityKey!))] } } },
      select: { observedAt: true, entity: { select: { monitoredUrlId: true, key: true } } },
    });
    for (const s of keyed) {
      const k = `${s.monitoredUrlId}|${s.entityKey}`;
      // changes strictly before this signal: its own version is not an "earlier" change
      const before = versions.filter((v) => v.entity.monitoredUrlId === s.monitoredUrlId && v.entity.key === s.entityKey && v.observedAt.getTime() < s.occurredAt.getTime() - 1000).length;
      priorChangesByEntity.set(k, before);
    }
  }

  const ranked = prioritizeSignals(scoring, { now, competitorRelevance, recentSignals, priorChangesByEntity }, config);
  const byId = new Map(shown.map((s) => [s.id, s]));
  return {
    config,
    signals: ranked.map((r) => ({ ...byId.get(r.signalId)!, importance: r.importance, tier: r.tier, factors: r.factors, configVersion: r.configVersion })),
  };
}

export { IMPORTANCE_FACTORS };
