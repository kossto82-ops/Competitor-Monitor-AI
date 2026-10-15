import Link from "next/link";
import { CalendarCheck, CheckCircle2 } from "lucide-react";
import { listAlerts, listPrioritizedSignals, listSignalEvidenceExcerpts, listSourceHealthForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { AlertActions } from "@/components/app/AlertActions";
import { SourceHealthStateBadge } from "@/components/app/SourceHealthBadge";
import { ALERT_LEVEL_DISPLAY, confidenceLabel, pointsBarPercent, quietDaySummary, signalKindLabel, TIER_DISPLAY } from "@/lib/alertDisplay";
import { formatRelativeTime } from "@/lib/formatTime";

// Phase 29 D5: "what should I know today", ordered by importance instead of by recency or by count.
const SIGNAL_WINDOW_DAYS = 7;
const SIGNALS_SHOWN = 12;
const WORRYING_SOURCE_STATES = new Set(["DISABLED", "STALE", "DEGRADED", "PARTIAL"]);

export default async function TodayPage() {
  const session = await getSession();
  if (!session) return null;
  const orgId = session.organizationId;

  const since = new Date(Date.now() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60_000);
  const [alerts, prioritized, sources] = await Promise.all([
    listAlerts(orgId, { limit: 50 }),
    listPrioritizedSignals(orgId, { since, limit: 200 }),
    listSourceHealthForOrg(orgId),
  ]);
  const open = alerts.filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED");
  const signals = prioritized.signals.slice(0, SIGNALS_SHOWN);
  const evidence = await listSignalEvidenceExcerpts(orgId, signals.map((s) => s.id));
  const worrying = sources.filter((s) => s.competitorIsActive && WORRYING_SOURCE_STATES.has(s.health.state));
  const alertsOpenCount = open.filter((a) => a.status === "OPEN").length;
  const nothingToDo = open.length === 0 && signals.every((s) => s.tier === "LOW");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">What you should know today</h1>
        <p className="text-sm text-slate-500">
          Alerts first, then everything that changed in the last {SIGNAL_WINDOW_DAYS} days ranked by how much it matters. Every item says why.
        </p>
      </div>

      {nothingToDo ? (
        <Card>
          <CardContent className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
            <p className="text-sm text-slate-700">Nothing needs your attention. {quietDaySummary(sources.length, signals.length)}</p>
          </CardContent>
        </Card>
      ) : null}

      {open.length > 0 ? (
        <section aria-labelledby="alerts-heading" className="space-y-3">
          <h2 id="alerts-heading" className="text-sm font-semibold text-slate-900">
            Alerts{alertsOpenCount > 0 ? ` (${alertsOpenCount} new)` : ""}
          </h2>
          {open.map((alert) => {
            const display = ALERT_LEVEL_DISPLAY[alert.level];
            return (
              <Card key={alert.id}>
                <CardContent className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={display.tone} title={display.meaning}>
                          {display.label}
                        </Badge>
                        <Link href={`/competitors/${alert.competitorId}`} className="text-sm font-medium text-slate-900 hover:text-indigo-700">
                          {alert.title}
                        </Link>
                        {alert.occurrences > 1 ? <Badge tone="gray">{alert.occurrences} times</Badge> : null}
                      </div>
                      <p className="text-xs text-slate-500">
                        Importance {alert.importance}/100 · {confidenceLabel(alert.confidence)} · {formatRelativeTime(alert.lastRaisedAt)}
                      </p>
                    </div>
                    <AlertActions alertId={alert.id} status={alert.status} />
                  </div>
                  <details className="group text-sm">
                    <summary className="cursor-pointer text-xs font-medium text-indigo-700 hover:text-indigo-900">Why you are seeing this</summary>
                    <p className="mt-2 rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">{alert.explanation}</p>
                  </details>
                </CardContent>
              </Card>
            );
          })}
        </section>
      ) : null}

      <section aria-labelledby="signals-heading">
        <Card>
          <CardHeader>
            <CardTitle>
              <span id="signals-heading">Signals, most important first</span>
            </CardTitle>
          </CardHeader>
          {signals.length === 0 ? (
            <EmptyState
              icon={<CalendarCheck className="h-8 w-8" />}
              title={`No changes in the last ${SIGNAL_WINDOW_DAYS} days`}
              description="When a competitor changes a price, a plan or a promotion it will show up here with the reason it matters."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {signals.map((signal) => {
                const tier = TIER_DISPLAY[signal.tier];
                const excerpts = evidence.get(signal.id) ?? [];
                const primary = excerpts.find((e) => e.role === "PRIMARY") ?? excerpts[0];
                return (
                  <li key={signal.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={tier.tone}>{signal.importance}</Badge>
                      <Badge tone="purple">{signalKindLabel(signal.kind)}</Badge>
                      <Link href={`/competitors/${signal.competitorId}`} className="text-sm font-medium text-slate-900 hover:text-indigo-700">
                        {signal.competitorName}
                      </Link>
                      <span className="text-sm text-slate-700">{signal.title}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{signal.summary}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {tier.label} · {confidenceLabel(signal.confidence)} · observed fact · {formatRelativeTime(signal.occurredAt)}
                      {signal.evidenceCount > 1 ? ` · ${signal.evidenceCount} changes behind it` : ""}
                    </p>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-indigo-700 hover:text-indigo-900">How this was scored</summary>
                      <div className="mt-2 space-y-3 rounded-lg bg-slate-50 p-3">
                        <ul className="space-y-1.5">
                          {signal.factors.map((factor) => (
                            <li key={factor.factor} className="grid grid-cols-[7rem_1fr] items-start gap-x-3 text-xs sm:grid-cols-[7rem_6rem_1fr]">
                              <span className="font-medium text-slate-700">{factor.factor}</span>
                              <span className="hidden items-center gap-2 sm:flex">
                                <span className="h-1.5 w-16 overflow-hidden rounded bg-slate-200" aria-hidden="true">
                                  <span className="block h-full bg-indigo-500" style={{ width: `${pointsBarPercent(factor.points)}%` }} />
                                </span>
                                <span className="tabular-nums text-slate-500">{factor.points}</span>
                              </span>
                              <span className="text-slate-600">{factor.explanation}</span>
                            </li>
                          ))}
                        </ul>
                        {primary ? (
                          <div className="border-t border-slate-200 pt-2">
                            <p className="text-xs font-medium text-slate-700">Evidence</p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">{primary.evidenceExcerpt}</p>
                          </div>
                        ) : null}
                        <p className="text-xs text-slate-400">
                          Rule {signal.ruleId} v{signal.ruleVersion} · weights v{signal.configVersion} · <a className="underline" href={signal.url}>{signal.url}</a>
                        </p>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {worrying.length > 0 ? (
        <section aria-labelledby="sources-heading">
          <Card>
            <CardHeader>
              <CardTitle>
                <span id="sources-heading">Pages we cannot fully verify</span>
              </CardTitle>
            </CardHeader>
            <ul className="divide-y divide-slate-100">
              {worrying.slice(0, 6).map((source) => (
                <li key={source.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">{source.competitorName}</span>
                      <SourceHealthStateBadge health={source.health} />
                    </div>
                    <p className="text-xs text-slate-500">{source.health.reason}</p>
                  </div>
                </li>
              ))}
            </ul>
            <div className="border-t border-slate-100 px-5 py-3">
              <Link href="/sources" className="text-xs font-medium text-indigo-700 hover:text-indigo-900">
                All sources{worrying.length > 6 ? ` (${worrying.length - 6} more not shown)` : ""}
              </Link>
            </div>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
