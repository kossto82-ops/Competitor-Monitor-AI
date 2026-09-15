"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { jobStatusDisplay } from "@/lib/statusDisplay";

const POLL_INTERVAL_MS = 1200;
const MAX_POLL_MS = 60_000;

type LocalPhase = "idle" | "queued" | "scanning" | "completed" | "failed";

/**
 * Idle -> Queued -> Scanning -> Completed/Failed, driven by real polling
 * against GET /api/monitoring-jobs/{id} - never shown as "completed"
 * until the backend actually reports it (Phase 2 requirement: never
 * pretend a scan finished before the backend confirms it).
 */
export function ScanButton({
  monitoredUrlId,
  initialStatus,
}: {
  monitoredUrlId: string;
  initialStatus: { label: string; tone: "gray" | "blue" | "green" | "amber" | "red" | "purple" } | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<LocalPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  async function onScan() {
    setError(null);
    setPhase("queued");

    try {
      const response = await fetch(`/api/monitored-urls/${monitoredUrlId}/scan`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not start scan.");
        setPhase("idle");
        return;
      }

      const jobId: string = body.monitoringJobId;
      const startedAt = Date.now();

      pollTimer.current = setInterval(async () => {
        if (Date.now() - startedAt > MAX_POLL_MS) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setError("This scan is taking longer than expected.");
          return;
        }

        try {
          const jobResponse = await fetch(`/api/monitoring-jobs/${jobId}`);
          const jobBody = await jobResponse.json();
          if (!jobResponse.ok) return;

          const status: string = jobBody.job.status;
          if (status === "PENDING") setPhase("queued");
          else if (status === "RUNNING") setPhase("scanning");
          else if (status === "COMPLETED" || status === "FAILED") {
            if (pollTimer.current) clearInterval(pollTimer.current);
            setPhase(status === "COMPLETED" ? "completed" : "failed");
            router.refresh();
          }
        } catch {
          // transient poll failure - keep polling until MAX_POLL_MS
        }
      }, POLL_INTERVAL_MS);
    } catch {
      setError("Could not reach the server.");
      setPhase("idle");
    }
  }

  const isBusy = phase === "queued" || phase === "scanning";

  return (
    <div className="flex items-center gap-2" data-testid="scan-control">
      {phase === "idle" && initialStatus ? <Badge tone={initialStatus.tone}>{initialStatus.label}</Badge> : null}
      {phase === "queued" ? (
        <Badge tone="blue" data-testid="scan-phase-badge">
          Queued
        </Badge>
      ) : null}
      {phase === "scanning" ? (
        <Badge tone="blue" data-testid="scan-phase-badge">
          Scanning…
        </Badge>
      ) : null}
      {phase === "completed" ? (
        <Badge tone="green" data-testid="scan-phase-badge">
          Completed
        </Badge>
      ) : null}
      {phase === "failed" ? (
        <Badge tone="red" data-testid="scan-phase-badge">
          Failed
        </Badge>
      ) : null}

      <Button size="sm" variant="secondary" onClick={onScan} disabled={isBusy} data-testid="scan-now-button">
        {isBusy ? <Spinner /> : <ScanLine className="h-4 w-4" aria-hidden="true" />}
        {isBusy ? jobStatusDisplay(phase === "queued" ? "PENDING" : "RUNNING").label : "Scan now"}
      </Button>

      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
