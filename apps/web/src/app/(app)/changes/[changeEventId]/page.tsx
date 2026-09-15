import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { getChangeEventForOrg, getAiAnalysisForChangeEvent } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { changeTypeDisplay, severityDisplay, verificationStateDisplay } from "@/lib/statusDisplay";
import { formatDateTime } from "@/lib/formatTime";
import { AiAnalysisPanel } from "@/components/app/AiAnalysisPanel";

interface PageProps {
  params: Promise<{ changeEventId: string }>;
}

function SnapshotCard({
  title,
  snapshot,
}: {
  title: string;
  snapshot: {
    fetchedAt: Date;
    extractionMethod: string;
    verificationState: string;
    confidence: number;
    normalizedContent: string;
  } | null;
}) {
  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-400">No prior snapshot - this was the first time this page was checked.</p>
        </CardContent>
      </Card>
    );
  }

  const verification = verificationStateDisplay(snapshot.verificationState);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-400">Fetched at</dt>
          <dd className="text-slate-900">{formatDateTime(snapshot.fetchedAt)}</dd>
          <dt className="text-slate-400">Extraction method</dt>
          <dd className="text-slate-900">{snapshot.extractionMethod}</dd>
          <dt className="text-slate-400">Verification</dt>
          <dd>
            <Badge tone={verification.tone}>{verification.label}</Badge>
          </dd>
          <dt className="text-slate-400">Confidence</dt>
          <dd className="text-slate-900">{Math.round(snapshot.confidence * 100)}%</dd>
        </dl>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Extracted page text</p>
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
            {snapshot.normalizedContent.slice(0, 400) || <span className="text-slate-400">(empty)</span>}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function ChangeDetailPage({ params }: PageProps) {
  const session = await getSession();
  if (!session) return null;
  const { changeEventId } = await params;

  const changeEvent = await getChangeEventForOrg(session.organizationId, changeEventId);
  if (!changeEvent) notFound();

  const aiAnalysis = await getAiAnalysisForChangeEvent(session.organizationId, changeEventId);

  const type = changeTypeDisplay(changeEvent.changeType);
  const severity = severityDisplay(changeEvent.severity);
  const money = (v: string | null) => (v === null ? "—" : `${changeEvent.currency ?? ""}${v}`.trim());

  return (
    <div className="space-y-6">
      <div>
        <Link href="/changes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Changes
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={type.tone}>{type.label}</Badge>
        <Badge tone={severity.tone}>{severity.label} severity</Badge>
        <span className="text-sm text-slate-400">Detected {formatDateTime(changeEvent.detectedAt)}</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What changed</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Previous value</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{money(changeEvent.oldValue)}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Current value</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{money(changeEvent.newValue)}</p>
            </div>
            {changeEvent.percentageChange !== null ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Change</p>
                <p className={`mt-1 text-lg font-semibold ${changeEvent.percentageChange < 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {changeEvent.percentageChange > 0 ? "+" : ""}
                  {changeEvent.percentageChange}%
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-600">
            <p>
              <span className="font-medium text-slate-900">Source: </span>
              <a href={changeEvent.monitoredUrl.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:text-indigo-700">
                {changeEvent.monitoredUrl.url}
              </a>{" "}
              ({changeEvent.monitoredUrl.competitor.name})
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-indigo-100 bg-indigo-50/50">
        <CardContent className="flex items-start gap-3 py-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-500" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-slate-900">This is evidence, not an inference</p>
            <p className="mt-0.5 text-sm text-slate-600">
              Old value, new value, and the percentage change above were computed deterministically by comparing two real
              page snapshots - never generated or guessed by an AI model. The excerpt below is the exact evidence field
              recorded at detection time.
            </p>
            <p className="mt-2 rounded-lg bg-white p-3 text-sm text-slate-700">{changeEvent.evidenceExcerpt}</p>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Snapshot comparison</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SnapshotCard title="Previous snapshot" snapshot={changeEvent.previousSnapshot} />
          <SnapshotCard title="Current snapshot" snapshot={changeEvent.currentSnapshot} />
        </div>
      </div>

      <AiAnalysisPanel
        changeEventId={changeEvent.id}
        changeType={changeEvent.changeType}
        initialAnalysis={aiAnalysis}
      />
    </div>
  );
}
