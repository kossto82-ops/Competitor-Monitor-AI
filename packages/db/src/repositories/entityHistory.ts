import { planEntityObservation, type KnownEntityState, type ObservedEntity } from "@cma/core";
import type { Prisma } from "../../generated/client/index.js";
import { prisma } from "../client.js";

type Tx = Prisma.TransactionClient;

export interface ObservedChangeEvent {
  id: string;
  changeType: string;
  entityKey: string | null;
}

export interface RecordEntityObservationInput {
  organizationId: string;
  monitoredUrlId: string;
  snapshotId: string;
  observedAt: Date;
  entities: ObservedEntity[];
  /** The change events the comparison of THIS snapshot produced, to link each version to what explains it. */
  events: ObservedChangeEvent[];
}

/**
 * Phase 29 D1: folds one verified snapshot's entities into the long-lived Entity / EntityVersion rows.
 * Runs inside the pipeline's transaction, so a snapshot and the history it adds are written together or
 * not at all. Only call it for snapshots whose verification state says the scan can be trusted.
 */
export async function recordEntityObservations(tx: Tx, input: RecordEntityObservationInput): Promise<void> {
  const { organizationId, monitoredUrlId, snapshotId, observedAt, entities, events } = input;

  const rows = await tx.entity.findMany({
    where: { monitoredUrlId },
    select: { id: true, key: true, status: true, versions: { orderBy: { observedAt: "desc" }, take: 1, select: { value: true, currency: true } } },
  });
  const idByKey = new Map(rows.map((r) => [r.key, r.id]));
  const known: KnownEntityState[] = rows.map((r) => ({
    key: r.key,
    status: r.status,
    latestValue: r.versions[0]?.value ?? null,
    latestCurrency: r.versions[0]?.currency ?? null,
  }));
  const plan = planEntityObservation(known, entities);
  const eventFor = (key: string, types: string[]) => events.find((e) => e.entityKey === key && types.includes(e.changeType))?.id ?? null;

  const version = (entityId: string, entity: ObservedEntity, origin: "FIRST_SEEN" | "CHANGE" | "BASELINE" | "REAPPEARED", changeEventId: string | null) =>
    tx.entityVersion.create({
      data: { organizationId, entityId, snapshotId, observedAt, value: entity.value, currency: entity.currency, raw: entity.raw, origin, changeEventId },
    });

  for (const entity of plan.created) {
    const row = await tx.entity.create({
      data: { organizationId, monitoredUrlId, type: entity.type, key: entity.key, label: entity.label, firstSeenAt: observedAt, lastSeenAt: observedAt },
    });
    await version(row.id, entity, "FIRST_SEEN", eventFor(entity.key, ["PRODUCT_ADDED", "PROMOTION_ADDED"]));
  }

  for (const { entity, origin } of plan.versions) {
    const entityId = idByKey.get(entity.key)!;
    if (origin === "REAPPEARED") {
      await tx.entity.update({ where: { id: entityId }, data: { status: "ACTIVE", absentSince: null, label: entity.label } });
      await version(entityId, entity, "REAPPEARED", eventFor(entity.key, ["PRODUCT_ADDED", "PROMOTION_ADDED"]));
    } else {
      // A different value that no event explains is the extractor, the market or the layout changing - not
      // the competitor - so it is recorded as a baseline instead of as a change.
      const eventId = eventFor(entity.key, ["PRICE_CHANGE", "PROMOTION_CHANGE"]);
      await version(entityId, entity, eventId ? "CHANGE" : "BASELINE", eventId);
    }
  }

  if (plan.seen.length > 0 || plan.created.length > 0) {
    await tx.entity.updateMany({ where: { monitoredUrlId, key: { in: [...plan.seen] } }, data: { lastSeenAt: observedAt } });
  }
  if (plan.absent.length > 0) {
    await tx.entity.updateMany({ where: { monitoredUrlId, key: { in: plan.absent } }, data: { status: "ABSENT", absentSince: observedAt } });
  }
}

export interface EntityHistoryItem {
  id: string;
  type: string;
  key: string;
  label: string;
  status: "ACTIVE" | "ABSENT";
  firstSeenAt: Date;
  lastSeenAt: Date;
  absentSince: Date | null;
  versions: {
    id: string;
    observedAt: Date;
    value: string | null;
    currency: string | null;
    origin: string;
    changeEventId: string | null;
  }[];
}

/** Every tracked entity of one source with its versions, oldest first (tenant-scoped). */
export async function listEntityHistory(organizationId: string, monitoredUrlId: string): Promise<EntityHistoryItem[]> {
  const rows = await prisma.entity.findMany({
    where: { organizationId, monitoredUrlId },
    orderBy: [{ firstSeenAt: "asc" }, { key: "asc" }],
    include: { versions: { orderBy: { observedAt: "asc" } } },
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    key: r.key,
    label: r.label,
    status: r.status,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    absentSince: r.absentSince,
    versions: r.versions.map((v) => ({ id: v.id, observedAt: v.observedAt, value: v.value, currency: v.currency, origin: v.origin, changeEventId: v.changeEventId })),
  }));
}

export interface BackfillResult {
  sources: number;
  snapshots: number;
}

/**
 * Builds the entity history of existing data by replaying the verified snapshots of each source in order
 * through the same rules the pipeline uses. Safe to run again: a source that already has entities is left
 * alone unless `force` is set (which first clears that source's history).
 */
export async function backfillEntityHistory(organizationId: string, options: { force?: boolean } = {}): Promise<BackfillResult> {
  const sources = await prisma.monitoredUrl.findMany({ where: { organizationId }, select: { id: true } });
  const result: BackfillResult = { sources: 0, snapshots: 0 };
  for (const source of sources) {
    const existing = await prisma.entity.count({ where: { monitoredUrlId: source.id } });
    if (existing > 0 && !options.force) continue;
    if (existing > 0) await prisma.entity.deleteMany({ where: { monitoredUrlId: source.id } });

    const snapshots = await prisma.snapshot.findMany({
      where: { organizationId, monitoredUrlId: source.id, verificationState: { not: "FAILED_TO_VERIFY" } },
      orderBy: { fetchedAt: "asc" },
      select: {
        id: true,
        fetchedAt: true,
        extractedEntities: { select: { type: true, key: true, label: true, value: true, currency: true, raw: true } },
        changeEventsAsCurrent: { select: { id: true, changeType: true, entityKey: true } },
      },
    });
    if (snapshots.length > 0) result.sources += 1;
    for (const snapshot of snapshots) {
      await prisma.$transaction((tx) =>
        recordEntityObservations(tx, {
          organizationId,
          monitoredUrlId: source.id,
          snapshotId: snapshot.id,
          observedAt: snapshot.fetchedAt,
          entities: snapshot.extractedEntities,
          events: snapshot.changeEventsAsCurrent,
        }),
      );
      result.snapshots += 1;
    }
  }
  return result;
}
