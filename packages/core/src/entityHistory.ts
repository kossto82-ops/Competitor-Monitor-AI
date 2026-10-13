import type { EntityType } from "./enums.js";

/**
 * Phase 29 D1: what each tracked entity (a plan, a price, a promotion...) looked like over time. A scan's
 * extracted entities are throwaway rows of that snapshot; an Entity is the same thing followed across
 * scans, and an EntityVersion is one distinct state of it. Pure planning only: the database layer applies
 * the plan, so the rules here can be tested without a database.
 */
export type EntityStatus = "ACTIVE" | "ABSENT";

/**
 * Why a version exists:
 * - FIRST_SEEN : the entity appeared (the first scan of a source, or a new plan later on).
 * - CHANGE     : its value or currency differs from the previous version and a change event explains it.
 * - BASELINE   : its value differs but no event does (the extractor, market or layout changed, so the
 *                difference is not a real-world change).
 * - REAPPEARED : it was missing from a verified scan and is back.
 */
export type EntityVersionOrigin = "FIRST_SEEN" | "CHANGE" | "BASELINE" | "REAPPEARED";

export interface ObservedEntity {
  type: EntityType;
  key: string;
  label: string;
  value: string | null;
  currency: string | null;
  raw: string;
}

export interface KnownEntityState {
  key: string;
  status: EntityStatus;
  latestValue: string | null;
  latestCurrency: string | null;
}

export interface EntityObservationPlan {
  /** Entities never seen before on this source: a row and a FIRST_SEEN version. */
  created: ObservedEntity[];
  /** Known entities that need a new version. `CHANGE` is downgraded to BASELINE by the caller when no event explains it. */
  versions: { entity: ObservedEntity; origin: "CHANGE" | "REAPPEARED" }[];
  /** Known entities present in this scan (their last-seen time moves). */
  seen: string[];
  /** Known active entities missing from this scan. */
  absent: string[];
}

/**
 * Entities whose identity is stable enough to follow. GENERIC ones are context-hashed prices kept as
 * evidence only (their key changes when the surrounding text does) and would create a new "entity" for
 * every wording change.
 */
export function isTrackableEntity(entity: Pick<ObservedEntity, "type" | "key">): boolean {
  return entity.type !== "GENERIC" && !entity.key.startsWith("text-price:");
}

export function planEntityObservation(known: KnownEntityState[], observed: ObservedEntity[]): EntityObservationPlan {
  const knownByKey = new Map(known.map((k) => [k.key, k]));
  const plan: EntityObservationPlan = { created: [], versions: [], seen: [], absent: [] };
  const present = new Set<string>();

  for (const entity of observed) {
    if (!isTrackableEntity(entity) || present.has(entity.key)) continue;
    present.add(entity.key);
    const existing = knownByKey.get(entity.key);
    if (!existing) {
      plan.created.push(entity);
      continue;
    }
    plan.seen.push(entity.key);
    if (existing.status === "ABSENT") {
      plan.versions.push({ entity, origin: "REAPPEARED" });
    } else if (existing.latestValue !== entity.value || existing.latestCurrency !== entity.currency) {
      plan.versions.push({ entity, origin: "CHANGE" });
    }
  }

  // A scan that shows no trackable entity at all says nothing about what is gone (a partial render, a
  // page that stopped exposing prices): nothing is marked absent from it.
  if (present.size > 0) {
    for (const k of known) if (k.status === "ACTIVE" && !present.has(k.key)) plan.absent.push(k.key);
  }
  return plan;
}
