import type { ActivityPattern, RepeatedPriceChangePattern } from "@cma/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/formatTime";

/**
 * Phase 7: the deterministic Pattern Intelligence surface - see
 * PHASE7-INTELLIGENCE-MODEL.md for the full PATTERN vs AI INTERPRETATION
 * boundary this component deliberately stays on the PATTERN side of.
 * Every sentence here is generated from a `qualifies`/`strongEvidence`
 * flag computed in packages/db/src/repositories/patterns.ts - never from
 * a raw count alone - so a thin historical record (e.g. "1 change this
 * month vs 0 last month") is always rendered as insufficient/limited
 * evidence rather than a dramatic-sounding claim.
 */

function activityDirectionLabel(pattern: ActivityPattern): { label: string; tone: BadgeTone } {
  if (!pattern.qualifies) return { label: "Not enough history yet", tone: "gray" };
  switch (pattern.direction) {
    case "ABOVE_BASELINE":
      return { label: pattern.strongEvidence ? "Above recent baseline" : "Limited historical observations", tone: pattern.strongEvidence ? "blue" : "gray" };
    case "BELOW_BASELINE":
      return { label: "Below recent baseline", tone: "gray" };
    case "AT_BASELINE":
      return { label: "In line with recent baseline", tone: "gray" };
    default:
      return { label: "Not enough history yet", tone: "gray" };
  }
}

function ActivityPatternSection({ pattern }: { pattern: ActivityPattern }) {
  const { label, tone } = activityDirectionLabel(pattern);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-900">Activity vs. historical baseline</p>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {pattern.qualifies ? (
        <p className="mt-1 text-xs text-slate-500">
          {pattern.current} recorded change{pattern.current === 1 ? "" : "s"} in the last {pattern.days} days, vs. an
          average of {pattern.baselineAverage} across the {pattern.qualifyingWindows} preceding {pattern.days}-day
          period{pattern.qualifyingWindows === 1 ? "" : "s"} for which this competitor has been tracked.
          {pattern.ratio !== null ? ` (${pattern.ratio}x the baseline average.)` : ""}
        </p>
      ) : (
        <p className="mt-1 text-xs text-slate-400">
          This competitor has not been monitored long enough yet to establish a reliable historical baseline.
        </p>
      )}
    </div>
  );
}

function RepeatedPriceChangesSection({ patterns }: { patterns: RepeatedPriceChangePattern[] }) {
  const qualifying = patterns.filter((p) => p.qualifies);
  return (
    <div>
      <p className="text-sm font-medium text-slate-900">Repeated price-change activity</p>
      {qualifying.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400">
          No product or plan has had 2 or more price changes in the selected period yet - a single price change is not
          treated as a pattern.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {qualifying.map((p) => (
            <li key={`${p.monitoredUrlId}::${p.entityKey}`} className="flex items-center justify-between gap-3 text-xs text-slate-600">
              <span className="truncate font-medium text-slate-800">{p.entityKey}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone="purple">{p.changeCount} price changes</Badge>
                {p.lastChangeAt ? <span className="text-slate-400">last {formatDateTime(p.lastChangeAt)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PatternsCard({
  activityPattern,
  repeatedPriceChangePatterns,
}: {
  activityPattern: ActivityPattern;
  repeatedPriceChangePatterns: RepeatedPriceChangePattern[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Patterns</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <ActivityPatternSection pattern={activityPattern} />
        <RepeatedPriceChangesSection patterns={repeatedPriceChangePatterns} />
        <p className="text-xs text-slate-400">
          Patterns are deterministic calculations over verified changes only - they describe what has been observed,
          not why it may have happened.
        </p>
      </CardContent>
    </Card>
  );
}
