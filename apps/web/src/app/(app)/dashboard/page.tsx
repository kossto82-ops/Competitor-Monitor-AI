import Link from "next/link";
import { Building2, GitCompareArrows, Link2, ScanLine } from "lucide-react";
import { getDashboardSummaryForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { jobStatusDisplay, severityDisplay, summarizeChangeEvent } from "@/lib/statusDisplay";
import { formatRelativeTime } from "@/lib/formatTime";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return null; // layout already redirects; keeps TS happy

  const summary = await getDashboardSummaryForOrg(session.organizationId);

  const stats = [
    { key: "competitors", label: "Competitors", value: summary.totalCompetitors, icon: Building2 },
    { key: "monitored-urls", label: "Monitored URLs", value: summary.totalMonitoredUrls, icon: Link2 },
    { key: "scans-24h", label: "Scans (24h)", value: summary.scansLast24h, icon: ScanLine },
    { key: "changes-7d", label: "Changes (7d)", value: summary.changesLast7d, icon: GitCompareArrows },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500">An overview of what your monitored competitors are doing.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.key} data-testid={`stat-${stat.key}`}>
            <CardContent className="flex items-center justify-between py-5">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{stat.label}</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900" data-testid={`stat-${stat.key}-value`}>
                  {stat.value}
                </p>
              </div>
              <stat.icon className="h-8 w-8 text-slate-300" aria-hidden="true" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Recent changes</CardTitle>
            <Link href="/changes" className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
              View all
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {summary.recentChangeEvents.length === 0 ? (
              <EmptyState
                icon={<GitCompareArrows className="h-8 w-8" />}
                title="No changes detected yet"
                description="Once a monitored URL changes, it will show up here."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {summary.recentChangeEvents.map((event) => (
                  <li key={event.id}>
                    <Link
                      href={`/changes/${event.id}`}
                      className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-slate-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">{summarizeChangeEvent(event)}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{event.monitoredUrl.url}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={severityDisplay(event.severity).tone}>{severityDisplay(event.severity).label}</Badge>
                        <span className="text-xs text-slate-400">{formatRelativeTime(event.detectedAt)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {summary.recentJobs.length === 0 ? (
              <EmptyState
                icon={<ScanLine className="h-8 w-8" />}
                title="No scans yet"
                description="Add a competitor and a URL, then trigger a scan to see activity here."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {summary.recentJobs.map((job) => {
                  const status = jobStatusDisplay(job.status);
                  return (
                    <li key={job.id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-900">{job.monitoredUrl.label ?? job.monitoredUrl.url}</p>
                        <p className="text-xs text-slate-400">{formatRelativeTime(job.createdAt)}</p>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
