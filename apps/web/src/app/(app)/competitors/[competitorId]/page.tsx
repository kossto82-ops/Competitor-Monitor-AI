import Link from "next/link";
import { ArrowLeft, Link2 } from "lucide-react";
import {
  getActivityPattern,
  getCompetitorActivityMetrics,
  getCompetitorForOrg,
  getOrganizationById,
  getPriceHistoryForCompetitor,
  getProductLifecycleSummary,
  getRepeatedPriceChangePatterns,
  listChangeEventsForCompetitor,
  listMonitoredUrlsWithStatusForOrg,
} from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddUrlForm } from "@/components/app/AddUrlForm";
import { ScanButton } from "@/components/app/ScanButton";
import { CompetitorActions } from "@/components/app/CompetitorActions";
import { MonitoredUrlActions } from "@/components/app/MonitoredUrlActions";
import { ActivityMetricsCard } from "@/components/app/ActivityMetricsCard";
import { PriceHistoryCard } from "@/components/app/PriceHistoryCard";
import { PatternsCard } from "@/components/app/PatternsCard";
import { changeTypeDisplay, jobStatusDisplay, summarizeChangeEvent, verificationStateDisplay } from "@/lib/statusDisplay";
import { formatPeriodDeltaLabel } from "@/lib/periodDisplay";
import { formatRelativeTime } from "@/lib/formatTime";

const VALID_PERIOD_DAYS = [7, 30, 90] as const;

function parsePeriodDays(value: string | undefined): number {
  const parsed = Number(value);
  return VALID_PERIOD_DAYS.includes(parsed as (typeof VALID_PERIOD_DAYS)[number]) ? parsed : 30;
}

/**
 * Phase 6 (Section 8): added/removed products-or-plans, current vs.
 * previous period - deterministic counts only, never an interpretation
 * of WHY (Section 8 explicitly forbids reading "removed" as "business
 * closure").
 */
function ProductLifecycleCard({ summary }: { summary: Awaited<ReturnType<typeof getProductLifecycleSummary>> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Products &amp; plans</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-2xl font-semibold text-slate-900">{summary.added.current}</p>
            <p className="text-xs text-slate-500">added · last {summary.days} days</p>
            <p className="mt-1 text-xs text-slate-400">{formatPeriodDeltaLabel(summary.added)}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-slate-900">{summary.removed.current}</p>
            <p className="text-xs text-slate-500">no longer detected · last {summary.days} days</p>
            <p className="mt-1 text-xs text-slate-400">{formatPeriodDeltaLabel(summary.removed)}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          &quot;No longer detected&quot; reflects what monitoring observed on the page - it is not evidence of a business
          decision.
        </p>
      </CardContent>
    </Card>
  );
}

function formatTimelineDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

/**
 * Phase 5 (Section 15): a basic competitor timeline - every verified
 * change across ALL of this competitor's monitored URLs, grouped by
 * calendar day, each linking to its evidence. Deliberately just a
 * grouped list (Section 14: "do NOT build a complex analytics
 * platform") - no trend lines, no predictive anything.
 */
function CompetitorTimeline({ changeEvents }: { changeEvents: Awaited<ReturnType<typeof listChangeEventsForCompetitor>> }) {
  if (changeEvents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-400">No verified changes yet for this competitor.</p>
        </CardContent>
      </Card>
    );
  }

  const groups = new Map<string, typeof changeEvents>();
  for (const event of changeEvents) {
    const key = formatTimelineDate(event.detectedAt);
    const existing = groups.get(key);
    if (existing) existing.push(event);
    else groups.set(key, [event]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {Array.from(groups.entries()).map(([day, events]) => (
          <div key={day}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{day}</p>
            <ul className="mt-2 space-y-2">
              {events.map((event) => {
                const type = changeTypeDisplay(event.changeType);
                return (
                  <li key={event.id}>
                    <Link href={`/changes/${event.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                      <Badge tone={type.tone}>{type.label}</Badge>
                      <span className="truncate text-sm text-slate-700">{summarizeChangeEvent(event)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface PageProps {
  params: Promise<{ competitorId: string }>;
  searchParams: Promise<{ days?: string }>;
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

export default async function CompetitorDetailPage({ params, searchParams }: PageProps) {
  const session = await getSession();
  if (!session) return null;
  const { competitorId } = await params;
  const { days: daysParam } = await searchParams;
  const days = parsePeriodDays(daysParam);

  const [competitor, organization] = await Promise.all([
    getCompetitorForOrg(session.organizationId, competitorId),
    getOrganizationById(session.organizationId),
  ]);
  const timezone = organization?.timezone;
  const [monitoredUrls, changeEvents, activityMetrics, lifecycleSummary, priceHistory, activityPattern, repeatedPriceChangePatterns] =
    await Promise.all([
      listMonitoredUrlsWithStatusForOrg(session.organizationId, competitorId),
      listChangeEventsForCompetitor(session.organizationId, competitorId),
      getCompetitorActivityMetrics(session.organizationId, competitorId, days, timezone),
      getProductLifecycleSummary(session.organizationId, competitorId, days, timezone),
      getPriceHistoryForCompetitor(session.organizationId, competitorId),
      getActivityPattern(session.organizationId, competitorId, days),
      getRepeatedPriceChangePatterns(session.organizationId, competitorId, days),
    ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/competitors" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Competitors
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{competitor.name}</h1>
            {competitor.website ? <p className="text-sm text-slate-500">{competitor.website}</p> : null}
            {competitor.notes ? <p className="mt-1 max-w-xl text-sm text-slate-500">{competitor.notes}</p> : null}
          </div>
          <div className="flex flex-col items-end gap-2">
            <CompetitorActions competitor={competitor} />
            <AddUrlForm competitorId={competitor.id} />
          </div>
        </div>
      </div>

      <ActivityMetricsCard
        title="Activity"
        metrics={activityMetrics}
        basePath={`/competitors/${competitor.id}`}
        currentDays={days}
        emptyDescription="No verified changes for this competitor in this period."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ProductLifecycleCard summary={lifecycleSummary} />
        <PriceHistoryCard series={priceHistory} />
      </div>

      <PatternsCard activityPattern={activityPattern} repeatedPriceChangePatterns={repeatedPriceChangePatterns} />

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
                      {!url.isActive ? <Badge tone="amber">Paused</Badge> : null}
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

                  <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
                    <MonitoredUrlActions url={url} />
                    <ScanButton monitoredUrlId={url.id} initialStatus={status} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <CompetitorTimeline changeEvents={changeEvents} />
    </div>
  );
}
