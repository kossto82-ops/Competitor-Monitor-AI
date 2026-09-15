import Link from "next/link";
import { Building2, ChevronRight } from "lucide-react";
import { listCompetitorsWithSummaryForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { NewCompetitorForm } from "@/components/app/NewCompetitorForm";
import { jobStatusDisplay, summarizeChangeEvent } from "@/lib/statusDisplay";
import { formatRelativeTime } from "@/lib/formatTime";

export default async function CompetitorsPage() {
  const session = await getSession();
  if (!session) return null;

  const competitors = await listCompetitorsWithSummaryForOrg(session.organizationId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Competitors</h1>
          <p className="text-sm text-slate-500">Everyone you're keeping an eye on.</p>
        </div>
        {competitors.length > 0 ? <NewCompetitorForm /> : null}
      </div>

      {competitors.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            title="No competitors yet"
            description="Add your first competitor to start monitoring their pricing and content."
            action={<NewCompetitorForm />}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {competitors.map((competitor) => {
              const status = competitor.latestJob ? jobStatusDisplay(competitor.latestJob.status) : null;
              return (
                <li key={competitor.id}>
                  <Link
                    href={`/competitors/${competitor.id}`}
                    className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-900">{competitor.name}</p>
                      {competitor.website ? <p className="truncate text-xs text-slate-400">{competitor.website}</p> : null}
                    </div>

                    <div className="hidden shrink-0 text-sm text-slate-500 sm:block">
                      {competitor.monitoredUrlCount} URL{competitor.monitoredUrlCount === 1 ? "" : "s"}
                    </div>

                    <div className="hidden w-56 shrink-0 md:block">
                      {competitor.latestChangeEvent ? (
                        <p className="truncate text-sm text-slate-700">{summarizeChangeEvent(competitor.latestChangeEvent)}</p>
                      ) : (
                        <p className="text-sm text-slate-400">No changes yet</p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {status ? <Badge tone={status.tone}>{status.label}</Badge> : <Badge tone="gray">Not scanned</Badge>}
                      {competitor.latestJob ? (
                        <span className="text-xs text-slate-400">{formatRelativeTime(competitor.latestJob.createdAt)}</span>
                      ) : null}
                    </div>

                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
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
