import Link from "next/link";
import { Newspaper } from "lucide-react";
import { getDigestForOrganization, getOrganizationById, type DigestItem } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FirstRunExplainer } from "@/components/app/FirstRunExplainer";
import { changeTypeDisplay, severityDisplay } from "@/lib/statusDisplay";
import { activityDetailText, activityDirectionLabel } from "@/lib/patternDisplay";
import { formatDateTime } from "@/lib/formatTime";
import { cn } from "@/lib/cn";

const VALID_PERIOD_DAYS = [7, 30, 90] as const;

function parsePeriodDays(value: string | undefined): number {
  const parsed = Number(value);
  return VALID_PERIOD_DAYS.includes(parsed as (typeof VALID_PERIOD_DAYS)[number]) ? parsed : 30;
}

/** The evidence link every digest item resolves to - always a real ChangeEvent, never a fabricated summary. See PHASE10-VALIDATION-REPORT.md's Evidence Requirement section. */
function primaryEvidenceId(item: DigestItem): string {
  if (item.kind === "CHANGE_EVENT") return item.changeEventId;
  // Both other kinds carry changeEventIds already sorted; pick the most recently detected one.
  return item.changeEventIds[0]!;
}

function DigestItemRow({ item }: { item: DigestItem }) {
  const evidenceHref = `/changes/${primaryEvidenceId(item)}`;

  return (
    <li className="flex items-start justify-between gap-3 px-5 py-4" data-testid="digest-item" data-digest-kind={item.kind}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/competitors/${item.competitorId}`} className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
            {item.competitorName}
          </Link>
          {item.kind === "CHANGE_EVENT" ? (
            <>
              <Badge tone={changeTypeDisplay(item.changeType).tone}>{changeTypeDisplay(item.changeType).label}</Badge>
              <Badge tone={severityDisplay(item.severity).tone}>{severityDisplay(item.severity).label}</Badge>
            </>
          ) : null}
          {item.kind === "REPEATED_PRICE_CHANGE" ? <Badge tone="purple">Repeated price change</Badge> : null}
          {item.kind === "ACTIVITY_PATTERN" ? (
            <Badge tone={activityDirectionLabel(item.pattern).tone} data-testid="digest-pattern-badge">
              {activityDirectionLabel(item.pattern).label}
            </Badge>
          ) : null}
          {item.kind === "LIFECYCLE" ? <Badge tone="green">Product lifecycle</Badge> : null}
        </div>

        <p className="mt-1 text-sm text-slate-700">
          {item.kind === "CHANGE_EVENT" ? item.description : null}
          {item.kind === "REPEATED_PRICE_CHANGE"
            ? `${item.pattern.label ?? item.pattern.entityKey} changed price ${item.pattern.changeCount} times in the last ${item.pattern.days} days`
            : null}
          {item.kind === "ACTIVITY_PATTERN" ? activityDetailText(item.pattern) : null}
          {item.kind === "LIFECYCLE"
            ? [
                item.added > 0 ? `Added ${item.added} product${item.added === 1 ? "" : "s"}` : null,
                item.removed > 0 ? `Removed ${item.removed} product${item.removed === 1 ? "" : "s"}` : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : null}
        </p>

        <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">
          <span>{formatDateTime(item.detectedAt)}</span>
          <Link href={evidenceHref} className="font-medium text-indigo-600 hover:text-indigo-700" data-testid="digest-evidence-link">
            View evidence →
          </Link>
        </div>
      </div>
    </li>
  );
}

interface PageProps {
  searchParams: Promise<{ days?: string }>;
}

/**
 * Phase 10 (PHASE10-VALIDATION-REPORT.md): the deterministic Digest - one
 * per-organization, evidence-linked feed composing the already-existing
 * ChangeEvent/ActivityPattern/RepeatedPriceChangePattern layer via
 * getDigestForOrganization. Zero AI calls, zero new schema. Recency-first
 * ordering only - never an importance/relevance score, and never a "top N"
 * that hides real items (see intelligence.ts's compareDigestItems doc
 * comment for the exact, documented tie-break rule).
 */
export default async function DigestPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) return null;
  const { days: daysParam } = await searchParams;
  const days = parsePeriodDays(daysParam);

  const organization = await getOrganizationById(session.organizationId);
  const digest = await getDigestForOrganization(session.organizationId, days, organization?.timezone);

  if (digest.totalTrackedCompetitors === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Digest</h1>
          <p className="text-sm text-slate-500">
            Notable, evidence-linked activity across every competitor you track.
          </p>
        </div>
        <FirstRunExplainer />
      </div>
    );
  }

  const { aboveBaselineCount, totalTrackedCompetitors } = digest.crossCompetitorContext;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Digest</h1>
          <p className="text-sm text-slate-500">
            Notable, evidence-linked activity across every competitor you track - purely descriptive, ordered by recency.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
          {VALID_PERIOD_DAYS.map((d) => (
            <Link
              key={d}
              href={`/digest?days=${d}`}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition-colors",
                d === days ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
              )}
              data-testid={`digest-period-${d}`}
            >
              {d}d
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="flex items-center justify-between gap-3 py-4">
          <p className="text-sm text-slate-700" data-testid="digest-cross-competitor-context">
            <span className="font-semibold text-slate-900">
              {aboveBaselineCount} of {totalTrackedCompetitors}
            </span>{" "}
            tracked competitor{totalTrackedCompetitors === 1 ? "" : "s"} {aboveBaselineCount === 1 ? "is" : "are"} currently above{" "}
            {aboveBaselineCount === 1 ? "its" : "their"} own historical baseline.
          </p>
          <Link href="/compare" className="shrink-0 text-xs font-medium text-indigo-600 hover:text-indigo-700">
            View comparison →
          </Link>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Last {days} days</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {digest.items.length === 0 ? (
            <EmptyState
              icon={<Newspaper className="h-8 w-8" />}
              title="Nothing notable yet"
              description="No verified changes or qualifying patterns were found across your tracked competitors in this period."
            />
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="digest-feed">
              {digest.items.map((item, index) => (
                // Items have no single stable id across kinds (a REPEATED_PRICE_CHANGE/ACTIVITY_PATTERN/LIFECYCLE
                // item is keyed by competitor+kind, not a single ChangeEvent id) - index is stable within one
                // deterministic server render, which is all React's reconciliation needs here.
                <DigestItemRow key={`${item.kind}-${item.competitorId}-${index}`} item={item} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-slate-400">
        Every item above traces back to real, verified monitoring evidence. &quot;Above/below its own historical
        baseline&quot; always compares a competitor only against its own accumulated history - never against another
        competitor or a market average. Items are ordered by recency only - there is no importance score.
      </p>
    </div>
  );
}
