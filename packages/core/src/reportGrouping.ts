/**
 * Phase 4 (Section 20): the ONE place deterministic report ordering is
 * computed - reused by the web report detail page and by the report
 * email builder, so both surfaces show competitors/changes in exactly
 * the same order. Deliberately generic over `T` (rather than importing
 * a Prisma-generated type) so this stays free of any database
 * dependency: packages/db already depends on packages/core, so the
 * reverse dependency is not possible, and this logic is pure enough that
 * it should never need one anyway.
 *
 * Section 20 is explicit: "Do not create a subjective 'most important
 * competitor' ranking... use deterministic sorting." The order here is:
 *   1. competitor name (case-insensitive, locale-aware) ascending
 *   2. detectedAt ascending, within a competitor
 *   3. changeType ascending, as a stable tie-break for same-instant events
 */
export interface ReportChangeSummary {
  competitorId: string;
  competitorName: string;
  changeType: string;
  detectedAt: string | Date;
}

export interface ReportCompetitorGroup<T extends ReportChangeSummary> {
  competitorId: string;
  competitorName: string;
  changes: T[];
}

export function groupChangesByCompetitor<T extends ReportChangeSummary>(changes: readonly T[]): ReportCompetitorGroup<T>[] {
  const groups = new Map<string, ReportCompetitorGroup<T>>();

  for (const change of changes) {
    let group = groups.get(change.competitorId);
    if (!group) {
      group = { competitorId: change.competitorId, competitorName: change.competitorName, changes: [] };
      groups.set(change.competitorId, group);
    }
    group.changes.push(change);
  }

  for (const group of groups.values()) {
    group.changes.sort((a, b) => {
      const dateDiff = new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.changeType.localeCompare(b.changeType);
    });
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.competitorName.localeCompare(b.competitorName, undefined, { sensitivity: "base" }),
  );
}
