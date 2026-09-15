import Link from "next/link";
import { GitCompareArrows } from "lucide-react";
import { listChangeEventsForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { changeTypeDisplay, severityDisplay, summarizeChangeEvent } from "@/lib/statusDisplay";
import { formatDateTime } from "@/lib/formatTime";

export default async function ChangesPage() {
  const session = await getSession();
  if (!session) return null;

  const changeEvents = await listChangeEventsForOrg(session.organizationId, { limit: 100 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Changes</h1>
        <p className="text-sm text-slate-500">Every deterministic change detected across your monitored pages.</p>
      </div>

      {changeEvents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitCompareArrows className="h-8 w-8" />}
            title="No changes detected yet"
            description="Once a monitored URL changes, it will show up here with full evidence."
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
