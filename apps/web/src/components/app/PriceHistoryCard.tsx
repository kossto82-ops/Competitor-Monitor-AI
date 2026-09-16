import type { PriceSeries } from "@cma/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/formatTime";

function formatMoney(value: string | null, currency: string | null): string {
  return value === null ? "—" : `${currency ?? ""}${value}`.trim();
}

/**
 * Phase 6 (Section 7): renders each defensible price-history series
 * (see getPriceHistoryForCompetitor's doc comment for the identity
 * rule) as a simple chronological list of verified price points - no
 * chart library, no interpolation, no invented "current price" beyond
 * what the most recent evidenced value says. Deliberately the same
 * evidence-first presentation as the change timeline rather than a
 * decorative visualization (Section 22: "charts only where they improve
 * understanding").
 */
export function PriceHistoryCard({ series }: { series: PriceSeries[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pricing</CardTitle>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          <p className="text-sm text-slate-400">
            No price history yet. A price series appears here once a product or plan with a stable identity has been seen
            changing price more than once.
          </p>
        ) : (
          <ul className="space-y-4">
            {series.map((s) => {
              const latest = s.points[s.points.length - 1];
              return (
                <li key={`${s.monitoredUrlId}::${s.entityKey}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-slate-900">{s.entityKey}</p>
                    {latest ? (
                      <Badge tone="purple">Latest: {formatMoney(latest.newValue, latest.currency)}</Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-slate-400">{s.label ?? s.url}</p>
                  <ul className="mt-2 space-y-1">
                    {s.points.map((p) => (
                      <li key={p.changeEventId} className="flex items-center justify-between gap-3 text-xs text-slate-600">
                        <span>
                          {formatMoney(p.oldValue, p.currency)} → {formatMoney(p.newValue, p.currency)}
                          {p.percentageChange !== null ? (
                            <span className="ml-1 text-slate-400">
                              ({p.percentageChange > 0 ? "+" : ""}
                              {p.percentageChange}%)
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-slate-400">{formatDateTime(p.detectedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
