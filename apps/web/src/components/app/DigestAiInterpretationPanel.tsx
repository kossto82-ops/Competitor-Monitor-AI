"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { aiAnalysisStatusDisplay } from "@/lib/statusDisplay";

const POLL_INTERVAL_MS = 1200;
const MAX_POLL_MS = 60_000;

export interface AiInterpretationClaimData {
  text: string;
  evidenceChangeEventIds: string[];
}

export interface AiInterpretationHypothesisData extends AiInterpretationClaimData {
  confidence: "LOW" | "MEDIUM";
}

export interface DigestAiInterpretationData {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  summary: string | null;
  observations: unknown;
  interpretations: unknown;
  hypotheses: unknown;
  provider: string | null;
  model: string | null;
  windowEnd: string | Date | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  errorMessage: string | null;
}

function asClaimList(value: unknown): AiInterpretationClaimData[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AiInterpretationClaimData =>
      typeof item === "object" && item !== null && typeof (item as AiInterpretationClaimData).text === "string",
  );
}

function asHypothesisList(value: unknown): AiInterpretationHypothesisData[] {
  return asClaimList(value).filter((item): item is AiInterpretationHypothesisData => "confidence" in item);
}

/**
 * Phase 11 (Section 24/26 of the brief): renders the three structurally
 * distinct claim categories (FACT/INTERPRETATION/HYPOTHESIS) with an
 * explicit "AI interpretation" label and a real evidence link per claim
 * - never a bare, unattributed sentence. Every evidence link resolves
 * to the SAME real `/changes/[id]` evidence page every other digest
 * item already links to (Phase 10) - this component never fabricates
 * its own citation surface.
 */
function EvidenceLink({ evidenceChangeEventIds }: { evidenceChangeEventIds: string[] }) {
  const firstId = evidenceChangeEventIds[0];
  if (!firstId) return null;
  return (
    <Link href={`/changes/${firstId}`} className="ml-2 text-xs font-medium text-indigo-600 hover:text-indigo-700">
      View evidence →
    </Link>
  );
}

export function DigestAiInterpretationPanel({
  days,
  initialInterpretation,
}: {
  days: number;
  initialInterpretation: DigestAiInterpretationData | null;
}) {
  const [interpretation, setInterpretation] = useState<DigestAiInterpretationData | null>(initialInterpretation);
  const [error, setError] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setInterpretation(initialInterpretation);
  }, [initialInterpretation]);

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
        setError("Interpretation is taking longer than expected.");
        return;
      }
      try {
        const response = await fetch(`/api/digest/interpretation?days=${days}`);
        const body = await response.json();
        if (!response.ok) return;
        if (body.interpretation) {
          setInterpretation(body.interpretation);
          if (body.interpretation.status === "COMPLETED" || body.interpretation.status === "FAILED") {
            if (pollTimer.current) clearInterval(pollTimer.current);
          }
        }
      } catch {
        // transient poll failure - keep polling until MAX_POLL_MS
      }
    }, POLL_INTERVAL_MS);
  }

  async function onInterpret() {
    setError(null);
    setIsTriggering(true);
    try {
      const response = await fetch(`/api/digest/interpretation?days=${days}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not start interpretation.");
        return;
      }
      setInterpretation(body.interpretation);
      if (body.interpretation.status === "PENDING" || body.interpretation.status === "RUNNING") {
        startPolling();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setIsTriggering(false);
    }
  }

  const status = interpretation?.status ?? null;
  const isBusy = status === "PENDING" || status === "RUNNING";
  const observations = asClaimList(interpretation?.observations);
  const interpretations = asClaimList(interpretation?.interpretations);
  const hypotheses = asHypothesisList(interpretation?.hypotheses);

  return (
    <Card data-testid="digest-ai-interpretation-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-500" aria-hidden="true" />
          AI interpretation
        </CardTitle>
        {status ? (
          <Badge tone={aiAnalysisStatusDisplay(status).tone} data-testid="digest-ai-status-badge">
            {aiAnalysisStatusDisplay(status).label}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!interpretation || status === "FAILED" ? (
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={onInterpret}
              disabled={isTriggering || isBusy}
              data-testid="digest-ai-interpret-button"
            >
              {isTriggering ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {status === "FAILED" ? "Retry interpretation" : "Interpret this digest"}
            </Button>
            {status === "FAILED" ? (
              <span className="text-xs text-slate-500" data-testid="digest-ai-error">
                {interpretation?.errorMessage ?? "The interpretation could not be completed."}
              </span>
            ) : null}
          </div>
        ) : null}

        {isBusy ? (
          <p className="text-sm text-slate-500">
            {status === "PENDING" ? "Waiting to start…" : "The AI is interpreting this digest…"}
          </p>
        ) : null}

        {status === "COMPLETED" && interpretation ? (
          <div className="space-y-4" data-testid="digest-ai-result">
            <p className="text-xs text-slate-500">
              This section is AI-generated interpretation of the verified evidence above, not additional evidence itself.
              Every statement below cites the real evidence it is based on.
            </p>

            {interpretation.summary ? <p className="text-sm font-medium text-slate-900">{interpretation.summary}</p> : null}

            {observations.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Observation</p>
                <ul className="space-y-2 text-sm text-slate-700" data-testid="digest-ai-observations">
                  {observations.map((item, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-1">
                      <span>{item.text}</span>
                      <EvidenceLink evidenceChangeEventIds={item.evidenceChangeEventIds} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {interpretations.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Interpretation</p>
                <ul className="space-y-2 text-sm text-slate-700" data-testid="digest-ai-interpretations">
                  {interpretations.map((item, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-1">
                      <span>{item.text}</span>
                      <EvidenceLink evidenceChangeEventIds={item.evidenceChangeEventIds} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {hypotheses.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Hypothesis</p>
                <ul className="space-y-2 text-sm text-slate-500" data-testid="digest-ai-hypotheses">
                  {hypotheses.map((item, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-1">
                      <Badge tone={item.confidence === "MEDIUM" ? "amber" : "gray"}>{item.confidence === "MEDIUM" ? "Medium confidence" : "Low confidence"}</Badge>
                      <span>{item.text}</span>
                      <EvidenceLink evidenceChangeEventIds={item.evidenceChangeEventIds} />
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-400">
                  Hypotheses are hedged possibilities, not established facts - the available data does not confirm why any
                  change happened.
                </p>
              </div>
            ) : null}

            {observations.length === 0 && interpretations.length === 0 && hypotheses.length === 0 ? (
              <p className="text-sm text-slate-500" data-testid="digest-ai-insufficient-evidence">
                There is not enough verified activity in this period for the AI to add an interpretation.
              </p>
            ) : null}

            {interpretation.provider && interpretation.provider !== "none" ? (
              <p className="text-xs text-slate-400" data-testid="digest-ai-metadata">
                Generated by {interpretation.provider}
                {interpretation.model ? ` (${interpretation.model})` : ""}
                {interpretation.inputTokens !== null && interpretation.outputTokens !== null
                  ? ` · ${interpretation.inputTokens} + ${interpretation.outputTokens} tokens`
                  : ""}
                {interpretation.durationMs !== null ? ` · ${(interpretation.durationMs / 1000).toFixed(1)}s` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
