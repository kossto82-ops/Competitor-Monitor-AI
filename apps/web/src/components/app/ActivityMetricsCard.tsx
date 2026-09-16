import Link from "next/link";
import { calculatePeriodDelta } from "@cma/core";
import type { ActivityMetrics } from "@cma/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { changeTypeDisplay } from "@/lib/statusDisplay";
import { formatPeriodDeltaLabel, periodDeltaTone } from "@/lib/periodDisplay";
import { cn } from "@/lib/cn";

const PERIOD_OPTIONS = [7, 30, 90] as const;

/**
 * Phase 6 (Section 6/9): the shared "activity summary" surface - used on
 * both the dashboard (org-wide) and the competitor detail page
 * (per-competitor). Every number here comes straight from
 * `getOrgActivityMetrics` / `getCompetitorActivityMetrics`
 * (packages/db/src/repositories/intelligence.ts) - a deterministic
 * aggregation over ChangeEvent, no AI involved.
 *
 * `basePath` + existing query params let the period switcher
 * (7/30/90 days) work as plain links with zero client JS, same pattern
 * as the Changes page's filter form.
 */
export function ActivityMetricsCard({
  title,
  metrics,
  basePath,
  currentDays,
  emptyDescription,
}: {
  title: string;
  metrics: ActivityMetrics;
  basePath: string;
  currentDays: number;
  emptyDescription: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
          {PERIOD_OPTIONS.map((d) => (
            <Link
              key={d}
              href={`${basePath}?days=${d}`}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition-colors",
                d === currentDays ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
              )}
            >
              {d}d
            </Link>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-3">
          <p className="text-3xl font-semibold text-slate-900">{metrics.total.current}</p>
          <p className="text-sm text-slate-500">verified changes · last {metrics.days} days</p>
        </div>
        <p className="mt-1 text-xs text-slate-400">{formatPeriodDeltaLabel(metrics.total)}</p>

        {metrics.byType.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">{emptyDescription}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {metrics.byType.map((row) => {
              const type = changeTypeDisplay(row.changeType);
              const delta = calculatePeriodDelta(row.current, row.previous);
              return (
                <li key={row.changeType} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge tone={type.tone}>{type.label}</Badge>
                  </span>
                  <span className="flex items-center gap-2 text-slate-600">
                    <span className="font-medium text-slate-900">{row.current}</span>
                    <Badge tone={periodDeltaTone(delta)}>{formatPeriodDeltaLabel(delta)}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
