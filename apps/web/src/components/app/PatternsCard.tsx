import type { ActivityPattern, RepeatedPriceChangePattern } from "@cma/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/formatTime";
import { activityDetailText, activityDirectionLabel } from "@/lib/patternDisplay";

/**
 * Phase 7: the deterministic Pattern Intelligence surface - see
 * PHASE7-INTELLIGENCE-MODEL.md for the full PATTERN vs AI INTERPRETATION
 * boundary this component deliberately stays on the PATTERN side of.
 * Every sentence here is generated from a `qualifies`/`strongEvidence`
 * flag computed in packages/db/src/repositories/patterns.ts - never from
 * a raw count alone - so a thin historical record (e.g. "1 change this
 * month vs 0 last month") is always rendered as insufficient/limited
 * evidence rather than a dramatic-sounding claim.
 *
 * `activityDirectionLabel`/`activityDetailText` moved to
 * @/lib/patternDisplay.ts in Phase 8 so the compare table (Phase 8) shows
 * the identical vocabulary for the identical pattern - see
 * PHASE8-DESIGN.md Section 6.
 */

function ActivityPatternSection({ pattern }: { pattern: ActivityPattern }) {
  const { label, tone } = activityDirectionLabel(pattern);
  return (
    <div data-testid="activity-pattern-section">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-900">Activity vs. historical baseline</p>
        <Badge tone={tone} data-testid="activity-pattern-badge">
          {label}
        </Badge>
      </div>
      {pattern.qualifies ? (
        <p className="mt-1 text-xs text-slate-500" data-testid="activity-pattern-detail">
          {activityDetailText(pattern)}
        </p>
      ) : (
        <p className="mt-1 text-xs text-slate-400" data-testid="activity-pattern-insufficient-history">
          This competitor has not been monitored long enough yet to establish a reliable historical baseline.
        </p>
      )}
    </div>
  );
}

function RepeatedPriceChangesSection({ patterns }: { patterns: RepeatedPriceChangePattern[] }) {
  const qualifying = patterns.filter((p) => p.qualifies);
  return (
    <div data-testid="repeated-price-pattern-section">
      <p className="text-sm font-medium text-slate-900">Repeated price-change activity</p>
      {qualifying.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400" data-testid="repeated-price-pattern-empty">
          No product or plan has had 2 or more price changes in the selected period yet - a single price change is not
          treated as a pattern.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {qualifying.map((p) => (
            <li
              key={`${p.monitoredUrlId}::${p.entityKey}`}
              data-testid="repeated-price-pattern-item"
              className="flex items-center justify-between gap-3 text-xs text-slate-600"
            >
              <span className="truncate font-medium text-slate-800">{p.entityKey}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone="purple" data-testid="repeated-price-pattern-count">
                  {p.changeCount} price changes
                </Badge>
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
    <Card data-testid="patterns-card">
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
