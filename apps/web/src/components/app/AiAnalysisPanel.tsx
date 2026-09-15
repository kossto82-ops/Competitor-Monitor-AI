"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { aiAnalysisStatusDisplay, aiConfidenceDisplay } from "@/lib/statusDisplay";

const POLL_INTERVAL_MS = 1200;
const MAX_POLL_MS = 60_000;

/**
 * Mirrors @cma/ai's SUPPORTED_AI_CHANGE_TYPES (Section 2 of the brief).
 * Kept as a small local constant rather than importing @cma/ai into the
 * client bundle - this is the only place the UI needs to know which
 * types are supported, purely to decide whether to render the control
 * at all. The server route is the real enforcement point (422 for an
 * unsupported type); this is just so the button is never shown for a
 * change the backend would reject anyway.
 */
const SUPPORTED_AI_CHANGE_TYPES = new Set(["PRICE_CHANGE", "PRODUCT_ADDED", "PRODUCT_REMOVED"]);

export interface AiAnalysisData {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  summary: string | null;
  facts: unknown;
  interpretations: unknown;
  speculation: unknown;
  confidence: string | null;
  provider: string | null;
  model: string | null;
  errorMessage: string | null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function AiAnalysisPanel({
  changeEventId,
  changeType,
  initialAnalysis,
}: {
  changeEventId: string;
  changeType: string;
  initialAnalysis: AiAnalysisData | null;
}) {
  const [analysis, setAnalysis] = useState<AiAnalysisData | null>(initialAnalysis);
  const [error, setError] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function startPolling() {
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        if (pollTimer.current) clearInterval(pollTimer.current);
        setError("Analysis is taking longer than expected.");
        return;
      }
      try {
        const response = await fetch(`/api/change-events/${changeEventId}/analysis`);
        const body = await response.json();
        if (!response.ok) return;
        if (body.analysis) {
          setAnalysis(body.analysis);
          if (body.analysis.status === "COMPLETED" || body.analysis.status === "FAILED") {
            if (pollTimer.current) clearInterval(pollTimer.current);
          }
        }
      } catch {
        // transient poll failure - keep polling until MAX_POLL_MS
      }
    }, POLL_INTERVAL_MS);
  }

  async function onAnalyze() {
    setError(null);
    setIsTriggering(true);
    try {
      const response = await fetch(`/api/change-events/${changeEventId}/analysis`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not start analysis.");
        return;
      }
      setAnalysis(body.analysis);
      if (body.analysis.status === "PENDING" || body.analysis.status === "RUNNING") {
        startPolling();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setIsTriggering(false);
    }
  }

  if (!SUPPORTED_AI_CHANGE_TYPES.has(changeType)) return null;

  const status = analysis?.status ?? null;
  const isBusy = status === "PENDING" || status === "RUNNING";

  return (
    <Card data-testid="ai-analysis-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-500" aria-hidden="true" />
          AI interpretation
        </CardTitle>
        {status ? (
          <Badge tone={aiAnalysisStatusDisplay(status).tone} data-testid="ai-analysis-status-badge">
            {aiAnalysisStatusDisplay(status).label}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!analysis || status === "FAILED" ? (
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" onClick={onAnalyze} disabled={isTriggering || isBusy} data-testid="ai-analyze-button">
              {isTriggering ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {status === "FAILED" ? "Retry analysis" : "Analyze this change"}
            </Button>
            {status === "FAILED" ? (
              <span className="text-xs text-slate-500" data-testid="ai-analysis-error">
                {analysis?.errorMessage ?? "The analysis could not be completed."}
              </span>
            ) : null}
          </div>
        ) : null}

        {isBusy ? (
          <p className="text-sm text-slate-500">
            {status === "PENDING" ? "Waiting to start…" : "The AI is interpreting this change…"}
          </p>
        ) : null}

        {status === "COMPLETED" ? (
          <div className="space-y-4" data-testid="ai-analysis-result">
            <p className="text-xs text-slate-500">
              This section is AI-generated interpretation, not additional evidence - see the deterministic evidence above for
              what was actually measured.
            </p>

            {analysis!.summary ? <p className="text-sm font-medium text-slate-900">{analysis!.summary}</p> : null}

            {analysis!.confidence ? (
              <Badge tone={aiConfidenceDisplay(analysis!.confidence).tone}>{aiConfidenceDisplay(analysis!.confidence).label}</Badge>
            ) : null}

            {asStringList(analysis!.facts).length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Facts</p>
                <ul className="list-inside list-disc space-y-1 text-sm text-slate-700" data-testid="ai-analysis-facts">
                  {asStringList(analysis!.facts).map((fact, i) => (
                    <li key={i}>{fact}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {asStringList(analysis!.interpretations).length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Interpretation</p>
                <ul className="list-inside list-disc space-y-1 text-sm text-slate-700" data-testid="ai-analysis-interpretations">
                  {asStringList(analysis!.interpretations).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {asStringList(analysis!.speculation).length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Speculation</p>
                <ul className="list-inside list-disc space-y-1 text-sm text-slate-500" data-testid="ai-analysis-speculation">
                  {asStringList(analysis!.speculation).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {analysis!.provider ? (
              <p className="text-xs text-slate-400">
                Generated by {analysis!.provider}
                {analysis!.model ? ` (${analysis!.model})` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
