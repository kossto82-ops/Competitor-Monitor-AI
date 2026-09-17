import type { SustainedActivityTrend } from "@cma/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * Phase 14B: the competitor-detail-page-only surface for
 * `getSustainedActivityTrend` (packages/db/src/repositories/patterns.ts) -
 * see PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md Section 11 (Option 3)
 * for why this is NOT wired into the Digest, the AI interpretation bundle,
 * or /compare in this phase.
 *
 * Every number rendered here comes straight from the returned
 * `SustainedActivityTrend.lookback` array (each element the same
 * `ActivityPattern` shape `PatternsCard` already renders) - no new hidden
 * number, no score, no vocabulary beyond "above/below baseline" and a plain
 * consecutive-window count (Section 22 - deterministic data surface, not an
 * AI interpretation).
 */

function directionLabel(direction: "ABOVE_BASELINE" | "BELOW_BASELINE"): { label: string; tone: BadgeTone } {
  return direction === "ABOVE_BASELINE"
    ? { label: "Above baseline", tone: "blue" }
    : { label: "Below baseline", tone: "gray" };
}

function periodWord(count: number): string {
  return count === 1 ? "period" : "periods";
}

export function SustainedTrendCard({ trend }: { trend: SustainedActivityTrend }) {
  // State D: the current window itself does not qualify - distinct from
  // "not enough history for a SUSTAINED claim" (State A below).
  if (!trend.current.qualifies) {
    return (
      <Card data-testid="sustained-trend-card">
        <CardHeader>
          <CardTitle>Sustained activity trend</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-slate-400" data-testid="sustained-trend-no-current-pattern">
            No qualifying sustained activity pattern currently detected. This competitor has not been monitored long
            enough yet to establish a historical baseline for the current period.
          </p>
        </CardContent>
      </Card>
    );
  }

  // State A: the current window qualifies, but there isn't enough tracked
  // history yet to check whether it held up over a prior period.
  if (!trend.sustainedDataAvailable) {
    return (
      <Card data-testid="sustained-trend-card">
        <CardHeader>
          <CardTitle>Sustained activity trend</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-slate-400" data-testid="sustained-trend-not-enough-history">
            Not enough history yet. A sustained pattern requires enough consecutive tracked periods to compare - this
            competitor does not have that yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  // State B / C: enough history exists to make a real sustained/not-sustained call.
  const { label, tone } = directionLabel(trend.current.direction === "BELOW_BASELINE" ? "BELOW_BASELINE" : "ABOVE_BASELINE");

  return (
    <Card data-testid="sustained-trend-card">
      <CardHeader>
        <CardTitle>Sustained activity trend</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-slate-900" data-testid="sustained-trend-headline">
            {trend.sustained ? `Sustained for ${trend.consecutiveQualifyingWindows} consecutive tracked ${periodWord(trend.consecutiveQualifyingWindows)}` : "Trend did not hold"}
          </p>
          <Badge tone={tone} data-testid="sustained-trend-direction-badge">
            {label}
          </Badge>
        </div>
        <p className="text-xs text-slate-500" data-testid="sustained-trend-detail">
          {trend.sustained
            ? `Current activity vs. historical baseline (${label.toLowerCase()}) matched the same direction over the ${trend.consecutiveQualifyingWindows} most recent tracked ${trend.days}-day periods, including the current one.`
            : `Current activity was ${label.toLowerCase()}, but the immediately preceding tracked ${trend.days}-day period did not share that direction - held for ${trend.consecutiveQualifyingWindows} consecutive tracked ${periodWord(trend.consecutiveQualifyingWindows)} only.`}
        </p>
        <p className="text-xs text-slate-400">
          Based on {trend.lookback.length} tracked {trend.days}-day period{trend.lookback.length === 1 ? "" : "s"}, each compared
          independently against its own historical baseline.
        </p>
      </CardContent>
    </Card>
  );
}
