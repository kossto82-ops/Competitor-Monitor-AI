import type { PeriodDelta } from "@cma/core";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * Phase 6: the ONE place a deterministic period-over-period delta
 * (PeriodDelta from @cma/core/period.ts) is turned into a customer-facing
 * sentence and badge tone - shared by the dashboard, competitor detail,
 * and comparison pages so all three describe the same kind of number
 * with identical wording (same pattern as statusDisplay.ts's
 * summarizeChangeEvent for individual ChangeEvents).
 *
 * Deliberately neutral language throughout - never "aggressive",
 * "winning", "declining", etc. (Phase 6 brief, Section 3/10): only what
 * the numbers themselves say.
 */
export function formatPeriodDeltaLabel(delta: PeriodDelta): string {
  if (delta.previous === 0) {
    return delta.current === 0 ? "No activity in this period" : "No activity in the previous period";
  }
  const sign = delta.absoluteChange > 0 ? "+" : "";
  const pct = delta.percentageChange === null ? "" : ` (${sign}${delta.percentageChange}%)`;
  return `${sign}${delta.absoluteChange} vs previous period${pct}`;
}

export function periodDeltaTone(delta: PeriodDelta): BadgeTone {
  if (delta.absoluteChange > 0) return "blue";
  if (delta.absoluteChange < 0) return "gray";
  return "gray";
}
