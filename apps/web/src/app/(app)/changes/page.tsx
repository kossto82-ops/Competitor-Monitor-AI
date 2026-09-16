import Link from "next/link";
import { GitCompareArrows } from "lucide-react";
import { listChangeEventsForOrg, listCompetitorsForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { changeTypeDisplay, severityDisplay, summarizeChangeEvent } from "@/lib/statusDisplay";
import { formatDateTime } from "@/lib/formatTime";

const CHANGE_TYPES = ["PRICE_CHANGE", "PRODUCT_ADDED", "PRODUCT_REMOVED", "PROMOTION_CHANGE", "CONTENT_CHANGE"] as const;

interface PageProps {
  searchParams: Promise<{ competitorId?: string; changeType?: string; from?: string; to?: string }>;
}

/** Section 16: basic filtering, expressed as a plain GET form - no client JS or complex search engine needed for "competitor / change type / date range". */
export default async function ChangesPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) return null;
  const filters = await searchParams;

  const [changeEvents, competitors] = await Promise.all([
    listChangeEventsForOrg(session.organizationId, {
      limit: 100,
      competitorId: filters.competitorId || undefined,
      changeType: filters.changeType || undefined,
      detectedAfter: filters.from ? new Date(`${filters.from}T00:00:00.000Z`) : undefined,
      detectedBefore: filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : undefined,
    }),
    listCompetitorsForOrg(session.organizationId),
  ]);

  const hasActiveFilters = Boolean(filters.competitorId || filters.changeType || filters.from || filters.to);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Changes</h1>
        <p className="text-sm text-slate-500">Every deterministic change detected across your monitored pages.</p>
      </div>

      <Card>
        <form className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4" method="get">
          <select
            name="competitorId"
            defaultValue={filters.competitorId ?? ""}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          >
            <option value="">All competitors</option>
            {competitors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            name="changeType"
            defaultValue={filters.changeType ?? ""}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          >
            <option value="">All change types</option>
            {CHANGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {changeTypeDisplay(t).label}
              </option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={filters.from ?? ""} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900" />
          <input type="date" name="to" defaultValue={filters.to ?? ""} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900" />
          <div className="col-span-2 flex items-center gap-2 sm:col-span-4">
            <button type="submit" className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
              Apply filters
            </button>
            {hasActiveFilters ? (
              <Link href="/changes" className="text-sm text-slate-500 hover:text-slate-700">
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {changeEvents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitCompareArrows className="h-8 w-8" />}
            title={hasActiveFilters ? "No changes match these filters" : "No changes detected yet"}
            description={
              hasActiveFilters
                ? "Try widening the date range or clearing a filter."
                : "Once a monitored URL changes, it will show up here with full evidence."
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {changeEvents.map((event) => {
              const type = changeTypeDisplay(event.changeType);
              const severity = severityDisplay(event.severity);
              return (
                <li key={event.id}>
                  <Link href={`/changes/${event.id}`} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge tone={type.tone}>{type.label}</Badge>
                        <Badge tone={severity.tone}>{severity.label}</Badge>
                      </div>
                      <p className="mt-1.5 truncate text-sm font-medium text-slate-900">{summarizeChangeEvent(event)}</p>
                      <p className="truncate text-xs text-slate-400">
                        {event.monitoredUrl.competitor.name} · {event.monitoredUrl.url}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-400">{formatDateTime(event.detectedAt)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
