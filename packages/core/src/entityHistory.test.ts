import { describe, expect, it } from "vitest";
import { isTrackableEntity, planEntityObservation, type KnownEntityState, type ObservedEntity } from "./entityHistory.js";

const price = (key: string, value: string | null, currency: string | null = "USD", overrides: Partial<ObservedEntity> = {}): ObservedEntity => ({
  type: "PRICE",
  key,
  label: key,
  value,
  currency,
  raw: `$${value}`,
  ...overrides,
});
const known = (key: string, value: string | null, status: KnownEntityState["status"] = "ACTIVE", currency: string | null = "USD"): KnownEntityState => ({
  key,
  status,
  latestValue: value,
  latestCurrency: currency,
});

describe("planEntityObservation (Phase 29 D1)", () => {
  it("creates every trackable entity on the first scan of a source", () => {
    const plan = planEntityObservation([], [price("plan:pro", "29.00"), price("plan:team", "59.00")]);
    expect(plan.created.map((e) => e.key)).toEqual(["plan:pro", "plan:team"]);
    expect(plan.versions).toEqual([]);
    expect(plan.absent).toEqual([]);
  });

  it("does nothing but move last-seen for entities that did not change", () => {
    const plan = planEntityObservation([known("plan:pro", "29.00")], [price("plan:pro", "29.00")]);
    expect(plan).toEqual({ created: [], versions: [], seen: ["plan:pro"], absent: [] });
  });

  it("adds a CHANGE version when the value or the currency differs", () => {
    const value = planEntityObservation([known("plan:pro", "29.00")], [price("plan:pro", "39.00")]);
    expect(value.versions).toMatchObject([{ origin: "CHANGE", entity: { key: "plan:pro", value: "39.00" } }]);
    const currency = planEntityObservation([known("plan:pro", "29.00")], [price("plan:pro", "29.00", "EUR")]);
    expect(currency.versions).toMatchObject([{ origin: "CHANGE" }]);
  });

  it("marks active entities missing from a scan that shows others as absent, and brings them back as REAPPEARED", () => {
    const gone = planEntityObservation([known("plan:pro", "29.00"), known("plan:team", "59.00")], [price("plan:pro", "29.00")]);
    expect(gone.absent).toEqual(["plan:team"]);
    const back = planEntityObservation([known("plan:team", "59.00", "ABSENT")], [price("plan:team", "59.00")]);
    expect(back.versions).toMatchObject([{ origin: "REAPPEARED", entity: { key: "plan:team" } }]);
    expect(back.absent).toEqual([]);
  });

  it("does not mark anything absent from a scan with no trackable entity at all", () => {
    expect(planEntityObservation([known("plan:pro", "29.00")], []).absent).toEqual([]);
    expect(planEntityObservation([known("plan:pro", "29.00")], [price("text-price:abc", "5.00", "USD", { type: "GENERIC" })]).absent).toEqual([]);
  });

  it("ignores generic context-hashed prices and repeated keys", () => {
    expect(isTrackableEntity({ type: "GENERIC", key: "text-price:1a2b" })).toBe(false);
    expect(isTrackableEntity({ type: "PRICE", key: "text-price:1a2b" })).toBe(false);
    expect(isTrackableEntity({ type: "PRICE", key: "plan:pro" })).toBe(true);
    const plan = planEntityObservation([], [price("plan:pro", "29.00"), price("plan:pro", "29.00"), price("text-price:x", "1.00", "USD", { type: "GENERIC" })]);
    expect(plan.created).toHaveLength(1);
  });
});
