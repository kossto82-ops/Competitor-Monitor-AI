import Link from "next/link";
import { Activity } from "lucide-react";
import { SOURCE_HEALTH_STATES, type SourceHealthState } from "@cma/core";
import { listSourceHealthForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SourceHealthStateBadge, SOURCE_HEALTH_DISPLAY } from "@/components/app/SourceHealthBadge";
import { formatRelativeTime } from "@/lib/formatTime";

// Most urgent first: sources that are not being monitored at all, then the ones whose data is old.
const SEVERITY_ORDER: SourceHealthState[] = ["DISABLED", "STALE", "DEGRADED", "PENDING", "PAUSED", "HEALTHY"];

export default async function SourcesPage() {
  const session = await getSession();
  if (!session) return null;

  const rows = await listSourceHealthForOrg(session.organizationId);
  const counts = Object.fromEntries(SOURCE_HEALTH_STATES.map((s) => [s, 0])) as Record<SourceHealthState, number>;
  for (const row of rows) counts[row.health.state] += 1;

  const sorted = [...rows].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.health.state) - SEVERITY_ORDER.indexOf(b.health.state) || a.competitorName.localeCompare(b.competitorName),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Source health</h1>
        <p className="text-sm text-slate-500">Whether each monitored page is actually being observed, and how fresh its data is.</p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Activity className="h-8 w-8" />}
            title="No monitored pages yet"
            description="Add a pricing or product page to a competitor and its health will show up here."
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {SEVERITY_ORDER.map((state) => (
              <Card key={state} className="px-4 py-3">
                <p className="text-2xl font-semibold text-slate-900">{counts[state]}</p>
                <p className="text-xs text-slate-500">{SOURCE_HEALTH_DISPLAY[state].label}</p>
              </Card>
            ))}
          </div>

          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
              {sorted.map((row) => (
                <li key={row.id} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/competitors/${row.competitorId}`} className="text-sm font-medium text-slate-900 hover:text-indigo-700">
                        {row.competitorName}
                      </Link>
                      {row.label ? <span className="text-sm text-slate-500">{row.label}</span> : null}
                      <SourceHealthStateBadge health={row.health} />
                    </div>
                    <p className="truncate text-xs text-slate-400">{row.url}</p>
                    <p className="text-xs text-slate-500">{row.health.reason}</p>
                  </div>
                  <p className="shrink-0 text-xs text-slate-400">
                    {row.lastSuccessfulScanAt ? `Last successful scan ${formatRelativeTime(row.lastSuccessfulScanAt)}` : "Never scanned successfully"}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
