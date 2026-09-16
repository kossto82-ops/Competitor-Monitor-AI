import Link from "next/link";
import { Columns3 } from "lucide-react";
import { getCompetitiveContext, getOrganizationById, listCompetitorsForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatPeriodDeltaLabel } from "@/lib/periodDisplay";
import { formatDateTime } from "@/lib/formatTime";
import { activityDetailText, activityDirectionLabel } from "@/lib/patternDisplay";

const VALID_PERIOD_DAYS = [7, 30, 90] as const;

function parsePeriodDays(value: string | undefined): number {
  const parsed = Number(value);
  return VALID_PERIOD_DAYS.includes(parsed as (typeof VALID_PERIOD_DAYS)[number]) ? parsed : 30;
}

interface PageProps {
  searchParams: Promise<{ competitorIds?: string | string[]; days?: string }>;
}

/** A repeated `?competitorIds=a&competitorIds=b` query string parses to a string[] under Next.js's searchParams; a single value parses to a plain string. Normalize both to string[]. */
function normalizeCompetitorIds(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Phase 6 (Section 10/11): a FIRST, deliberately descriptive
 * cross-competitor comparison - raw verified-change counts side by
 * side, in the order the customer selected them. There is intentionally
 * no derived score, rank, or "winner" column - see
 * packages/db/src/repositories/intelligence.ts's compareCompetitors doc
 * comment and PHASE6-VALIDATION.md's Product Assessment section for why.
 *
 * Phase 8 (PHASE8-DESIGN.md): extends the same table with each
 * competitor's own Phase 7 activity-vs-baseline pattern and repeated
 * price-change count via getCompetitiveContext - still no ranking, no
 * global/market baseline; every competitor is still only ever compared
 * against ITS OWN accumulated history.
 *
 * Plain GET form + checkboxes, no client JS, matching the Changes page's
 * filter pattern (Section 21 asks for a page, not a JS framework
 * detour).
 */
export default async function ComparePage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) return null;
  const params = await searchParams;
  const days = parsePeriodDays(params.days);
  const selectedIds = normalizeCompetitorIds(params.competitorIds);

  const [competitors, organization] = await Promise.all([
    listCompetitorsForOrg(session.organizationId),
    getOrganizationById(session.organizationId),
  ]);

  const rows = selectedIds.length > 0 ? await getCompetitiveContext(session.organizationId, selectedIds, days, organization?.timezone) : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Compare competitors</h1>
        <p className="text-sm text-slate-500">
          A side-by-side view of verified activity. Purely descriptive - select the competitors you want to compare.
        </p>
      </div>

      {competitors.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Columns3 className="h-8 w-8" />}
            title="No competitors yet"
            description="Add at least two competitors to compare their activity."
          />
        </Card>
      ) : (
        <Card>
          <form className="space-y-4 p-4" method="get">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {competitors.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="competitorIds"
                    value={c.id}
                    defaultChecked={selectedIds.includes(c.id)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                name="days"
                defaultValue={String(days)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              >
                {VALID_PERIOD_DAYS.map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
                Compare
              </button>
              {selectedIds.length > 0 ? (
                <Link href="/compare" className="text-sm text-slate-500 hover:text-slate-700">
                  Clear
                </Link>
              ) : null}
            </div>
          </form>
        </Card>
      )}

      {selectedIds.length === 0 ? null : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Columns3 className="h-8 w-8" />}
            title="Nothing to compare"
            description="The selected competitors could not be found."
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <CardHeader>
            <CardTitle>
              Activity comparison · last {days} days
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full min-w-[860px] text-left text-sm" data-testid="compare-table">
              <thead>
                <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-5 py-3 font-medium">Competitor</th>
                  <th className="px-5 py-3 font-medium">Verified changes</th>
                  <th className="px-5 py-3 font-medium">Price changes</th>
                  <th className="px-5 py-3 font-medium">Added</th>
                  <th className="px-5 py-3 font-medium">Removed</th>
                  <th className="px-5 py-3 font-medium">Activity vs. own baseline</th>
                  <th className="px-5 py-3 font-medium">Repeated price changes</th>
                  <th className="px-5 py-3 font-medium">Most recent change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const { label, tone } = activityDirectionLabel(row.activityPattern);
                  return (
                    <tr key={row.competitorId} data-testid="compare-row">
                      <td className="px-5 py-3">
                        <Link href={`/competitors/${row.competitorId}`} className="font-medium text-indigo-600 hover:text-indigo-700">
                          {row.name}
                        </Link>
                      </td>
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900">{row.totalChanges.current}</p>
                        <p className="text-xs text-slate-400">{formatPeriodDeltaLabel(row.totalChanges)}</p>
                      </td>
                      <td className="px-5 py-3 text-slate-700">{row.priceChanges.current}</td>
                      <td className="px-5 py-3 text-slate-700">{row.productsAdded.current}</td>
                      <td className="px-5 py-3 text-slate-700">{row.productsRemoved.current}</td>
                      <td className="px-5 py-3">
                        <Badge tone={tone} data-testid="compare-pattern-badge">
                          {label}
                        </Badge>
                        {row.activityPattern.qualifies ? (
                          <p className="mt-1 max-w-xs text-xs text-slate-400" data-testid="compare-pattern-detail">
                            {activityDetailText(row.activityPattern)}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-slate-700" data-testid="compare-repeated-price-count">
                        {row.qualifyingRepeatedPriceChangeCount > 0
                          ? `${row.qualifyingRepeatedPriceChangeCount} product${row.qualifyingRepeatedPriceChangeCount === 1 ? "" : "s"}/plan${row.qualifyingRepeatedPriceChangeCount === 1 ? "" : "s"}`
                          : "None"}
                      </td>
                      <td className="px-5 py-3 text-slate-500">
                        {row.latestChangeEventId ? (
                          <Link href={`/changes/${row.latestChangeEventId}`} className="text-indigo-600 hover:text-indigo-700" data-testid="compare-latest-change-link">
                            {row.latestChangeAt ? formatDateTime(row.latestChangeAt) : "View evidence"}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
          <p className="px-5 py-4 text-xs text-slate-400">
            &quot;Activity vs. own baseline&quot; compares each competitor only against its own accumulated history -
            never against another competitor or a market average. &quot;Not enough history yet&quot; means this
            competitor&apos;s own baseline cannot be established yet, not that it has no activity.
          </p>
        </Card>
      )}
    </div>
  );
}
