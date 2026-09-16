import Link from "next/link";
import { FileText } from "lucide-react";
import { listReportsForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { reportStatusDisplay } from "@/lib/statusDisplay";

function formatReportDate(reportDate: Date | string): string {
  const d = typeof reportDate === "string" ? new Date(reportDate) : reportDate;
  return new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(d);
}

/** Section 14: minimal report history - just a list, no advanced analytics yet. */
export default async function ReportsPage() {
  const session = await getSession();
  if (!session) return null;

  const reports = await listReportsForOrg(session.organizationId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Reports</h1>
        <p className="text-sm text-slate-500">Your daily competitor intelligence reports.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          {reports.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-8 w-8" />}
              title="No reports yet"
              description="A daily report is generated automatically once monitoring detects changes for the first time."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {reports.map((report) => {
                const status = reportStatusDisplay(report.status);
                return (
                  <li key={report.id}>
                    <Link href={`/reports/${report.id}`} className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900">{formatReportDate(report.reportDate)}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {report.changeCount} change{report.changeCount === 1 ? "" : "s"} · {report.competitorsWithChangesCount} of{" "}
                          {report.competitorCount} competitor{report.competitorCount === 1 ? "" : "s"} changed
                        </p>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
