import { describe, expect, it } from "vitest";
import { groupChangesByCompetitor, type ReportChangeSummary } from "./reportGrouping.js";

interface Fixture extends ReportChangeSummary {
  id: string;
}

function change(id: string, competitorId: string, competitorName: string, changeType: string, detectedAt: string): Fixture {
  return { id, competitorId, competitorName, changeType, detectedAt };
}

describe("groupChangesByCompetitor (Section 20: deterministic, never subjective)", () => {
  it("groups changes under their competitor", () => {
    const groups = groupChangesByCompetitor([
      change("1", "c1", "Alpha", "PRICE_CHANGE", "2026-09-16T10:00:00Z"),
      change("2", "c2", "Beta", "PRICE_CHANGE", "2026-09-16T10:00:00Z"),
      change("3", "c1", "Alpha", "PRODUCT_ADDED", "2026-09-16T11:00:00Z"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.competitorId === "c1")?.changes).toHaveLength(2);
    expect(groups.find((g) => g.competitorId === "c2")?.changes).toHaveLength(1);
  });

  it("sorts competitor groups by name, case-insensitively", () => {
    const groups = groupChangesByCompetitor([
      change("1", "c-zebra", "zebra corp", "PRICE_CHANGE", "2026-09-16T10:00:00Z"),
      change("2", "c-alpha", "Alpha Inc", "PRICE_CHANGE", "2026-09-16T10:00:00Z"),
      change("3", "c-mid", "Midway LLC", "PRICE_CHANGE", "2026-09-16T10:00:00Z"),
    ]);

    expect(groups.map((g) => g.competitorName)).toEqual(["Alpha Inc", "Midway LLC", "zebra corp"]);
  });

  it("sorts changes within a competitor by detectedAt ascending, then changeType as a tie-break", () => {
    const groups = groupChangesByCompetitor([
      change("later", "c1", "Alpha", "PRODUCT_ADDED", "2026-09-16T12:00:00Z"),
      change("earlier", "c1", "Alpha", "PRICE_CHANGE", "2026-09-16T09:00:00Z"),
      change("same-time-b", "c1", "Alpha", "PROMOTION_CHANGE", "2026-09-16T09:00:00Z"),
      change("same-time-a", "c1", "Alpha", "CONTENT_CHANGE", "2026-09-16T09:00:00Z"),
    ]);

    // At 09:00: CONTENT_CHANGE < PRICE_CHANGE < PROMOTION_CHANGE alphabetically; 12:00 (PRODUCT_ADDED) is always last regardless of type.
    expect(groups[0]?.changes.map((c) => c.id)).toEqual(["same-time-a", "earlier", "same-time-b", "later"]);
  });

  it("is deterministic across repeated calls with the same input (no reliance on Map iteration order surprises)", () => {
    const input = [
      change("1", "c-b", "B Corp", "PRICE_CHANGE", "2026-09-16T10:00:00Z"),
      change("2", "c-a", "A Corp", "PRICE_CHANGE", "2026-09-16T10:00:00Z"),
    ];

    const first = groupChangesByCompetitor(input).map((g) => g.competitorId);
    const second = groupChangesByCompetitor(input).map((g) => g.competitorId);
    expect(first).toEqual(second);
    expect(first).toEqual(["c-a", "c-b"]);
  });

  it("returns an empty array for an empty change list (Section 21: empty reports)", () => {
    expect(groupChangesByCompetitor([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [
      change("1", "c1", "Alpha", "PRODUCT_ADDED", "2026-09-16T12:00:00Z"),
      change("2", "c1", "Alpha", "PRICE_CHANGE", "2026-09-16T09:00:00Z"),
    ];
    const before = [...input];
    groupChangesByCompetitor(input);
    expect(input).toEqual(before);
  });
});
