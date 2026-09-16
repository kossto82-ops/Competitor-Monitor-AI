"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select, Label } from "@/components/ui/Input";

const FREQUENCY_OPTIONS = [
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Daily" },
  { minutes: 10080, label: "Weekly" },
];

export interface MonitoredUrlActionsData {
  id: string;
  isActive: boolean;
  scanFrequencyMinutes: number;
}

/**
 * Phase 5 (Section 4/5): pause/resume and a real (backend-enforced,
 * see apps/worker/src/enqueueAll.ts's listDueMonitoredUrls) scan
 * frequency control - not a decorative dropdown.
 */
export function MonitoredUrlActions({ url }: { url: MonitoredUrlActionsData }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [frequency, setFrequency] = useState(url.scanFrequencyMinutes);
  const [showFrequency, setShowFrequency] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetch(`/api/monitored-urls/${url.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setShowFrequency((v) => !v)} aria-label="Scan frequency">
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button size="sm" variant="secondary" onClick={() => patch({ isActive: !url.isActive })} disabled={busy}>
          {url.isActive ? (
            <>
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              Pause
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              Resume
            </>
          )}
        </Button>
      </div>
      {showFrequency ? (
        <div className="flex items-center gap-2">
          <Label htmlFor={`freq-${url.id}`} className="sr-only">
            Scan frequency
          </Label>
          <Select
            id={`freq-${url.id}`}
            value={frequency}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              setFrequency(minutes);
              void patch({ scanFrequencyMinutes: minutes });
            }}
          >
            {FREQUENCY_OPTIONS.map((opt) => (
              <option key={opt.minutes} value={opt.minutes}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  );
}
