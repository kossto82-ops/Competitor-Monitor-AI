import type { ActivityPattern } from "@cma/db";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * Phase 7/8: the ONE place an ActivityPattern (packages/db/src/
 * repositories/patterns.ts) is turned into a customer-facing badge label -
 * shared by the competitor-detail PatternsCard (Phase 7) and the
 * cross-competitor compare table (Phase 8) so the same pattern state never
 * reads differently depending on which page renders it (same convention
 * as periodDisplay.ts's formatPeriodDeltaLabel for PeriodDelta). Extracted
 * from PatternsCard.tsx in Phase 8 - see PHASE8-DESIGN.md Section 6.
 *
 * Deliberately neutral language (Section 23 of the Phase 8 brief): no
 * "aggressive"/"winning"/"declining" - only what the pattern itself says.
 */
export function activityDirectionLabel(pattern: ActivityPattern): { label: string; tone: BadgeTone } {
  if (!pattern.qualifies) return { label: "Not enough history yet", tone: "gray" };
  switch (pattern.direction) {
    case "ABOVE_BASELINE":
      return {
        label: pattern.strongEvidence ? "Above recent baseline" : "Limited historical observations",
        tone: pattern.strongEvidence ? "blue" : "gray",
      };
    case "BELOW_BASELINE":
      return { label: "Below recent baseline", tone: "gray" };
    case "AT_BASELINE":
      return { label: "In line with recent baseline", tone: "gray" };
    default:
      return { label: "Not enough history yet", tone: "gray" };
  }
}

/**
 * The exact sentence PatternsCard renders for a qualifying pattern -
 * shared so the compare table's detail line matches word-for-word rather
 * than drifting into a second, subtly different phrasing of the same
 * numbers.
 */
export function activityDetailText(pattern: ActivityPattern): string {
  const changeWord = pattern.current === 1 ? "" : "s";
  const periodWord = pattern.qualifyingWindows === 1 ? "" : "s";
  const ratioText = pattern.ratio !== null ? ` (${pattern.ratio}x the baseline average.)` : "";
  return `${pattern.current} recorded change${changeWord} in the last ${pattern.days} days, vs. an average of ${pattern.baselineAverage} across the ${pattern.qualifyingWindows} preceding ${pattern.days}-day period${periodWord} for which this competitor has been tracked.${ratioText}`;
}
