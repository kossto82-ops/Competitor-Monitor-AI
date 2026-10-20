import Link from "next/link";
import { Check, ListChecks } from "lucide-react";
import { CAPABILITY_CATEGORIES } from "@cma/core";
import { getCapabilityMatrix } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelativeTime } from "@/lib/formatTime";

const CATEGORY_LABEL: Record<(typeof CAPABILITY_CATEGORIES)[number], string> = {
  COVERAGE: "Coverage",
  SERVICE: "What they do",
  AUTOMATION: "Automation",
  INTEGRATION: "Integrations and tools",
  COMMERCIAL: "Commercial terms",
};

/**
 * Phase 29 F1: which capabilities each competitor's page says it has, side by side. The one thing the page
 * must never suggest is that an empty cell means "they do not offer it": it only means the page does not say so.
 */
export default async function FeaturesPage() {
  const session = await getSession();
  if (!session) return null;
  const matrix = await getCapabilityMatrix(session.organizationId);

  const observed = matrix.competitors.filter((c) => c.verifiedPages > 0);
  const grouped = CAPABILITY_CATEGORIES.map((category) => ({ category, items: matrix.capabilities.filter((c) => c.category === category) })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Features compared</h1>
        <p className="text-sm text-slate-500">What each competitor&apos;s pages say their service can do. Hover or open a tick to read the sentence it comes from.</p>
      </div>

      {observed.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListChecks className="h-8 w-8" />}
            title="Nothing to compare yet"
            description="Once your competitors' pages have been scanned, what each one says it offers will appear here."
          />
        </Card>
      ) : (
        <>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th scope="col" className="sticky left-0 bg-white px-4 py-3 font-medium text-slate-500">
                    &nbsp;
                  </th>
                  {observed.map((c) => (
                    <th key={c.id} scope="col" className="px-3 py-3 text-center font-medium text-slate-900">
                      <Link href={`/competitors/${c.id}`} className="hover:text-indigo-700">
                        {c.name}
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              {grouped.map((group) => (
                <tbody key={group.category}>
                  <tr className="bg-slate-50">
                    <th colSpan={observed.length + 1} scope="colgroup" className="px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {CATEGORY_LABEL[group.category]}
                    </th>
                  </tr>
                  {group.items.map((capability) => (
                    <tr key={capability.key} className="border-b border-slate-100 last:border-0">
                      <th scope="row" className="sticky left-0 bg-white px-4 py-2 text-left font-normal text-slate-700">
                        {capability.label}
                      </th>
                      {observed.map((c) => {
                        const cell = c.cells[capability.key];
                        return (
                          <td key={c.id} className="px-3 py-2 text-center align-top">
                            {cell && cell.state === "PRESENT" ? (
                              <details className="inline-block text-left">
                                <summary className="inline-flex cursor-pointer list-none items-center justify-center rounded-full bg-emerald-100 p-1 text-emerald-700 hover:bg-emerald-200" title={cell.evidence}>
                                  <Check className="h-3.5 w-3.5" aria-label={`${c.name}: says it has this`} />
                                </summary>
                                <p className="mt-1 w-56 rounded-lg bg-slate-50 p-2 text-xs leading-relaxed text-slate-600">{cell.evidence}</p>
                                <p className="mt-0.5 text-[11px] text-slate-400">seen {formatRelativeTime(cell.lastSeenAt)}</p>
                              </details>
                            ) : cell && cell.state === "ABSENT" ? (
                              <span className="text-xs text-amber-700" title={`The page stopped saying this ${cell.absentSince ? formatRelativeTime(cell.absentSince) : ""}`}>
                                no longer
                              </span>
                            ) : (
                              <span className="text-slate-300" aria-label={`${c.name}: the page does not say so`}>
                                &ndash;
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </Card>

          <Card>
            <CardContent className="space-y-1 text-xs text-slate-500">
              <p>
                <span className="font-medium text-slate-700">A dash does not mean they lack it</span>: it means the page we read does not mention it. A tick always comes with the sentence that shows it.
              </p>
              <p>
                Found by fixed rules in Spanish, French and English, no AI.{" "}
                {observed.map((c) => `${c.name} ${c.verifiedPages} page${c.verifiedPages === 1 ? "" : "s"}`).join(" · ")}.
              </p>
              {matrix.competitors.length > observed.length ? <p>Not shown, no page read yet: {matrix.competitors.filter((c) => c.verifiedPages === 0).map((c) => c.name).join(", ")}.</p> : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
