"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";

export interface CapabilityAiRunView {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  requestedAt: string;
  pagesChecked: number;
  pagesRemaining: number;
  findings: number;
  rejectedCount: number;
  failedPages: number;
  errorMessage: string | null;
}

/**
 * Phase 29 F3: the on-demand AI check. It only runs when somebody clicks, with the organization's own key, over a
 * bounded batch of pages, and says in plain words what it did and what it did not.
 */
export function CapabilityAiPanel({ initialRun, canRun, hasConnection }: { initialRun: CapabilityAiRunView | null; canRun: boolean; hasConnection: boolean }) {
  const router = useRouter();
  const [run, setRun] = useState<CapabilityAiRunView | null>(initialRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = run?.status === "PENDING" || run?.status === "RUNNING";

  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/capabilities/ai-check");
      if (!response.ok) return;
      const body = (await response.json()) as { run: CapabilityAiRunView | null };
      setRun(body.run);
      if (body.run && body.run.status !== "PENDING" && body.run.status !== "RUNNING") router.refresh();
    } catch {
      // The next poll tries again.
    }
  }, [router]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [running, poll]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/capabilities/ai-check", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not start the check.");
        return;
      }
      setRun(body.run);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl space-y-1">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <Sparkles className="h-4 w-4 text-indigo-500" aria-hidden="true" />
              Look for what the rules missed, with AI
            </h2>
            <p className="text-xs leading-relaxed text-slate-500">
              The fixed rules only find the wording they know. This reads the pages again with your own AI key and asks only about the capabilities the rules did not find, including the ones you added.
              Every finding must quote the page word for word; anything it cannot quote is dropped. What it finds is shown as an <span className="font-medium text-slate-700">AI inference</span>, never as a rule match, and it never raises an alert.
            </p>
          </div>
          {canRun ? (
            <Button onClick={start} disabled={busy || running || !hasConnection}>
              {running ? "Checking…" : busy ? "Starting…" : "Check with AI"}
            </Button>
          ) : null}
        </div>

        {!hasConnection ? (
          <p className="text-xs text-amber-700">
            No AI connection is switched on. <Link href="/settings/ai" className="underline">Add your own key</Link> to use this.
          </p>
        ) : null}
        {!canRun ? <p className="text-xs text-slate-500">Reading the pages with AI is available to the members who run scans.</p> : null}
        {error ? <p className="text-xs text-red-600">{error}</p> : null}

        {run?.status === "COMPLETED" ? (
          <p className="text-xs text-slate-600">
            Last check: read {run.pagesChecked} page{run.pagesChecked === 1 ? "" : "s"}, {run.findings} inference{run.findings === 1 ? "" : "s"} kept
            {run.rejectedCount > 0 ? `, ${run.rejectedCount} dropped because the quote could not be confirmed` : ""}
            {run.failedPages > 0 ? `, ${run.failedPages} page${run.failedPages === 1 ? "" : "s"} could not be read and will be tried next time` : ""}.
            {run.pagesRemaining > 0 ? ` ${run.pagesRemaining} more page${run.pagesRemaining === 1 ? " is" : "s are"} waiting: run it again to read the next batch.` : " Nothing else is waiting."}
          </p>
        ) : null}
        {run?.status === "FAILED" ? <p className="text-xs text-red-600">The last check did not finish: {run.errorMessage ?? "unknown error"}</p> : null}
      </CardContent>
    </Card>
  );
}
