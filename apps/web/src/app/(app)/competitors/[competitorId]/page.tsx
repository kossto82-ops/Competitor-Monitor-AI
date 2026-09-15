import Link from "next/link";
import { ArrowLeft, Link2 } from "lucide-react";
import { getCompetitorForOrg, listMonitoredUrlsWithStatusForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddUrlForm } from "@/components/app/AddUrlForm";
import { ScanButton } from "@/components/app/ScanButton";
import { jobStatusDisplay, summarizeChangeEvent, verificationStateDisplay } from "@/lib/statusDisplay";
import { formatRelativeTime } from "@/lib/formatTime";

interface PageProps {
  params: Promise<{ competitorId: string }>;
}

interface UrlWithStatus {
  latestSnapshot: { verificationState: string; errorMessage: string | null } | null;
  latestChangeEvent: unknown;
}

/**
 * Renders the three states the Phase 2 brief explicitly requires never
 * be conflated: never scanned, could-not-verify, and no-change. A
 * FAILED_TO_VERIFY snapshot produces no ChangeEvent (by design, see
 * packages/detection), so without this line a failed fetch and a
 * verified "nothing changed" would look identical to the user.
 */
function MonitoringStatusLine({ url }: { url: UrlWithStatus }) {
  if (!url.latestSnapshot) {
    return <p className="mt-1 text-sm text-slate-400">Never scanned yet</p>;
  }
  if (url.latestSnapshot.verificationState === "FAILED_TO_VERIFY") {
    const display = verificationStateDisplay(url.latestSnapshot.verificationState);
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-amber-700">
        <Badge tone={display.tone}>{display.label}</Badge>
        {url.latestSnapshot.errorMessage ? <span className="text-xs text-slate-400">{url.latestSnapshot.errorMessage}</span> : null}
      </p>
    );
  }
  if (!url.latestChangeEvent) {
    return <p className="mt-1 text-sm text-slate-400">No changes detected</p>;
  }
  return null; // the change summary link is rendered separately by the caller
}

export default async function CompetitorDetailPage({ params }: PageProps) {
  const session = await getSession();
  if (!session) return null;
  const { competitorId } = await params;

  const competitor = await getCompetitorForOrg(session.organizationId, competitorId);
  const monitoredUrls = await listMonitoredUrlsWithStatusForOrg(session.organizationId, competitorId);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/competitors" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Competitors
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{competitor.name}</h1>
            {competitor.website ? <p className="text-sm text-slate-500">{competitor.website}</p> : null}
          </div>
          <AddUrlForm competitorId={competitor.id} />
        </div>
      </div>

      {monitoredUrls.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title="No monitored URLs yet"
            description="Add a pricing or product page for this competitor to start monitoring it."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {monitoredUrls.map((url) => {
              const status = url.latestJob ? jobStatusDisplay(url.latestJob.status) : null;
              return (
                <li key={url.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-900">{url.label ?? url.url}</p>
                      <Badge tone="gray">{url.category.replace("_", " ").toLowerCase()}</Badge>
                    </div>
                    <p className="truncate text-xs text-slate-400">{url.url}</p>
                    <MonitoringStatusLine url={url} />
                    {url.latestChangeEvent ? (
                      <Link href={`/changes/${url.latestChangeEvent.id}`} className="mt-1 block text-sm text-indigo-600 hover:text-indigo-700">
                        {summarizeChangeEvent(url.latestChangeEvent)}
                      </Link>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-400">
                      {url.lastSuccessfulScanAt
                        ? `Last successful scan: ${formatRelativeTime(url.lastSuccessfulScanAt)}`
                        : "Never scanned successfully"}
                    </p>
                  </div>

                  <ScanButton monitoredUrlId={url.id} initialStatus={status} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
