import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { getReportWithItemsForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { changeTypeDisplay, aiConfidenceDisplay, reportStatusDisplay, summarizeChangeEvent } from "@/lib/statusDisplay";
import { groupReportItemsForDisplay, type ReportChangeForDisplay } from "@/lib/reportGrouping";

interface PageProps {
  params: Promise<{ reportId: string }>;
}

function formatReportDate(reportDate: Date): string {
  return new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(reportDate);
}

/** Section 1: the deterministic fact leads, AI interpretation appears beneath it - never the other way around (Section 18). */
function ChangeRow({ change }: { change: ReportChangeForDisplay }) {
  const type = changeTypeDisplay(change.changeType);
  const confidence = change.aiConfidence ? aiConfidenceDisplay(change.aiConfidence) : null;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={type.tone}>{type.label}</Badge>
        {change.monitoredUrlLabel ? <span className="text-xs text-slate-400">{change.monitoredUrlLabel}</span> : null}
        {confidence ? <Badge tone={confidence.tone}>{confidence.label}</Badge> : null}
      </div>
      <p className="mt-2 text-sm font-medium text-slate-900">{summarizeChangeEvent(change)}</p>

      {change.aiSummary ? (
        <p className="mt-2 rounded-lg bg-indigo-50/60 p-3 text-sm text-slate-700">
          <span className="font-medium text-slate-900">AI interpretation: </span>
          {change.aiSummary}
        </p>
      ) : (
        <p className="mt-2 text-sm italic text-slate-400">
          {change.aiStatus === "FAILED" ? "AI interpretation unavailable (analysis failed)." : "AI interpretation unavailable."}
        </p>
      )}

      <Link href={`/changes/${change.changeEventId}`} className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:text-indigo-700">
        View evidence →
      </Link>
    </li>
  );
}

export default async function ReportDetailPage({ params }: PageProps) {
  const session = await getSession();
  if (!session) return null;
  const { reportId } = await params;

  const report = await getReportWithItemsForOrg(session.organizationId, reportId);
  if (!report) notFound();

  const status = reportStatusDisplay(report.status);
  const groups = groupReportItemsForDisplay(report.items);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Reports
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Competitor Update</h1>
          <p className="text-sm text-slate-500">{formatReportDate(report.reportDate)}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Competitors monitored</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{report.competitorCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Competitors changed</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{report.competitorsWithChangesCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Changes detected</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{report.changeCount}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-indigo-100 bg-indigo-50/50">
        <CardContent className="flex items-start gap-3 py-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-500" aria-hidden="true" />
          <p className="text-sm text-slate-600">
            Every change below is a deterministic fact, verified by comparing two real page snapshots - never generated or
            guessed by AI. AI interpretation, shown beneath each fact when available, is optional enrichment.
          </p>
        </CardContent>
      </Card>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState title="No verified competitor changes detected" description="This report period had no changes to show." />
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.competitorId}>
            <CardHeader>
              <CardTitle>{group.competitorName}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-slate-100">
                {group.changes.map((change) => (
                  <ChangeRow key={change.reportItemId} change={change} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
