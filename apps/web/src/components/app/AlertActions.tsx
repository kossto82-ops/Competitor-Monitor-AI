"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/Button";

/** Phase 29 D5: mark an alert as seen, or dismiss it. A dismissed alert is not reopened; the next change is a new one. */
export function AlertActions({ alertId, status }: { alertId: string; status: "OPEN" | "ACKNOWLEDGED" | "DISMISSED" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: "ACKNOWLEDGED" | "DISMISSED") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/alerts/${alertId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!response.ok) {
        setError("Could not update the alert. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex flex-wrap items-center gap-1.5">
        {status === "OPEN" ? (
          <Button size="sm" variant="secondary" onClick={() => set("ACKNOWLEDGED")} disabled={busy}>
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Seen
          </Button>
        ) : (
          <span className="text-xs text-slate-400">Seen</span>
        )}
        <Button size="sm" variant="ghost" onClick={() => set("DISMISSED")} disabled={busy} aria-label="Dismiss this alert">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Dismiss
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
