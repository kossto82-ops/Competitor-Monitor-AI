import { getProductUsageSummaryForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent } from "@/components/ui/Card";

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Phase 5 (Section 20/21): a trustworthy usage snapshot, not a billing
 * page - no monetary figure is shown here at all, since @cma/ai's own
 * pricing table (Section 20: "if costUsd is unknown, keep it unknown")
 * cannot reliably price every configured provider/model. This page
 * exists to make usage visible and to give future plan/entitlement work
 * (Section 21) real numbers to design limits against - it enforces
 * nothing itself yet.
 */
export default async function UsagePage() {
  const session = await getSession();
  if (!session) return null;

  const usage = await getProductUsageSummaryForOrg(session.organizationId, startOfCurrentMonthUtc());

  const stats = [
    { label: "Competitors", value: usage.competitors },
    { label: "Monitored URLs", value: usage.monitoredUrls },
    { label: "Changes this month", value: usage.changesThisMonth },
    { label: "AI analyses this month", value: usage.aiAnalysesThisMonth },
    { label: "Reports generated", value: usage.reports },
    { label: "Emails sent", value: usage.emailsSent },
  ];

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Usage</h1>
        <p className="text-sm text-slate-500">
          A snapshot of how much you're using Competitor Monitor AI. This is not a billing page - there are no limits or
          charges yet.
        </p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 py-5 sm:grid-cols-3">
          {stats.map((stat) => (
            <div key={stat.label}>
              <p className="text-2xl font-semibold text-slate-900">{stat.value}</p>
              <p className="text-xs text-slate-500">{stat.label}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
