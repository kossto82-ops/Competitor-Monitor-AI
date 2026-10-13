import { deriveSignals, type EventForSignal } from "@cma/core";
import type { Prisma } from "../../generated/client/index.js";
import { prisma } from "../client.js";

type Tx = Prisma.TransactionClient;

/**
 * Phase 29 D2: turns verified change events into Signals by the deterministic rules in `@cma/core`.
 * Idempotent: a signal has a dedupe key that is unique per organization, so promoting the same event again
 * (a retry, a backfill) lands on the same row, and a second text change of the same day joins that day's signal.
 */
export async function promoteSignals(
  tx: Tx,
  input: { organizationId: string; competitorId: string; events: EventForSignal[]; labels?: ReadonlyMap<string, string> },
): Promise<{ created: number; attached: number; skipped: number }> {
  const { organizationId, competitorId, events, labels } = input;
  const { drafts, skipped } = deriveSignals(events, labels);
  let created = 0;
  let attached = 0;

  for (const draft of drafts) {
    const existing = await tx.signal.findUnique({
      where: { organizationId_dedupeKey: { organizationId, dedupeKey: draft.dedupeKey } },
      select: { id: true, confidence: true, occurredAt: true },
    });
    if (!existing) {
      await tx.signal.create({
        data: {
          organizationId,
          competitorId,
          monitoredUrlId: draft.monitoredUrlId,
          entityKey: draft.entityKey,
          kind: draft.kind,
          epistemicLevel: draft.epistemicLevel,
          title: draft.title,
          summary: draft.summary,
          oldValue: draft.oldValue,
          newValue: draft.newValue,
          currency: draft.currency,
          percentageChange: draft.percentageChange,
          confidence: draft.confidence,
          ruleId: draft.ruleId,
          ruleVersion: draft.ruleVersion,
          dedupeKey: draft.dedupeKey,
          occurredAt: draft.occurredAt,
          evidence: { create: { organizationId, changeEventId: draft.primaryEventId, role: "PRIMARY" } },
        },
      });
      created += 1;
      continue;
    }
    // The same signal again: only new supporting evidence is added (a no-op when the event is already linked).
    const linked = await tx.signalEvidence.findUnique({
      where: { signalId_changeEventId: { signalId: existing.id, changeEventId: draft.primaryEventId } },
      select: { id: true },
    });
    if (linked) continue;
    await tx.signalEvidence.create({ data: { organizationId, signalId: existing.id, changeEventId: draft.primaryEventId, role: "SUPPORTING" } });
    await tx.signal.update({
      where: { id: existing.id },
      data: {
        confidence: Math.min(existing.confidence, draft.confidence),
        occurredAt: draft.occurredAt > existing.occurredAt ? draft.occurredAt : existing.occurredAt,
      },
    });
    attached += 1;
  }
  return { created, attached, skipped: skipped.length };
}

export interface SignalListItem {
  id: string;
  kind: string;
  epistemicLevel: string;
  title: string;
  summary: string;
  entityKey: string | null;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
  confidence: number;
  ruleId: string;
  ruleVersion: number;
  occurredAt: Date;
  competitorId: string;
  competitorName: string;
  monitoredUrlId: string;
  url: string;
  evidenceCount: number;
}

/** Recent signals of the organization, newest first (tenant-scoped). */
export async function listSignals(organizationId: string, options: { since?: Date; competitorId?: string; limit?: number } = {}): Promise<SignalListItem[]> {
  const rows = await prisma.signal.findMany({
    where: {
      organizationId,
      ...(options.since ? { occurredAt: { gte: options.since } } : {}),
      ...(options.competitorId ? { competitorId: options.competitorId } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: options.limit ?? 100,
    include: { monitoredUrl: { select: { url: true, competitor: { select: { id: true, name: true } } } }, _count: { select: { evidence: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    epistemicLevel: r.epistemicLevel,
    title: r.title,
    summary: r.summary,
    entityKey: r.entityKey,
    oldValue: r.oldValue,
    newValue: r.newValue,
    currency: r.currency,
    percentageChange: r.percentageChange,
    confidence: r.confidence,
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    occurredAt: r.occurredAt,
    competitorId: r.monitoredUrl.competitor.id,
    competitorName: r.monitoredUrl.competitor.name,
    monitoredUrlId: r.monitoredUrlId,
    url: r.monitoredUrl.url,
    evidenceCount: r._count.evidence,
  }));
}

/** One signal with the change events that back it, before and after (tenant-scoped; null when not found). */
export async function getSignalWithEvidence(organizationId: string, signalId: string) {
  return prisma.signal.findFirst({
    where: { id: signalId, organizationId },
    include: { evidence: { orderBy: { role: "asc" }, include: { changeEvent: true } } },
  });
}

/**
 * Promotes the signals of every change event the organization already has, oldest first, with the same rules
 * the pipeline uses. Safe to run again: promotion is idempotent.
 */
export async function backfillSignals(organizationId: string): Promise<{ events: number; created: number; attached: number; skipped: number }> {
  const events = await prisma.changeEvent.findMany({
    where: { organizationId },
    orderBy: { detectedAt: "asc" },
    include: { monitoredUrl: { select: { competitorId: true } } },
  });
  const entities = await prisma.entity.findMany({ where: { organizationId }, select: { monitoredUrlId: true, key: true, label: true } });
  const labelsByUrl = new Map<string, Map<string, string>>();
  for (const e of entities) {
    const labels = labelsByUrl.get(e.monitoredUrlId) ?? new Map<string, string>();
    labels.set(e.key, e.label);
    labelsByUrl.set(e.monitoredUrlId, labels);
  }
  const total = { events: events.length, created: 0, attached: 0, skipped: 0 };
  for (const event of events) {
    const result = await prisma.$transaction((tx) =>
      promoteSignals(tx, {
        organizationId,
        competitorId: event.monitoredUrl.competitorId,
        events: [
          {
            id: event.id,
            monitoredUrlId: event.monitoredUrlId,
            changeType: event.changeType,
            entityKey: event.entityKey,
            oldValue: event.oldValue,
            newValue: event.newValue,
            currency: event.currency,
            percentageChange: event.percentageChange,
            confidence: event.confidence,
            evidenceExcerpt: event.evidenceExcerpt,
            detectedAt: event.detectedAt,
          },
        ],
        labels: labelsByUrl.get(event.monitoredUrlId),
      }),
    );
    total.created += result.created;
    total.attached += result.attached;
    total.skipped += result.skipped;
  }
  return total;
}
