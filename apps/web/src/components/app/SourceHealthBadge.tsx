import { deriveSourceHealth, type SourceHealthInput, type SourceHealthState } from "@cma/core";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

const DISPLAY: Record<SourceHealthState, { label: string; tone: BadgeTone }> = {
  HEALTHY: { label: "Healthy", tone: "green" },
  DEGRADED: { label: "Failing", tone: "amber" },
  STALE: { label: "Stale", tone: "red" },
  PENDING: { label: "Not scanned yet", tone: "gray" },
  PAUSED: { label: "Paused", tone: "amber" },
  DISABLED: { label: "Stopped automatically", tone: "red" },
};

/** Health of one monitored source, with the plain-language reason as a tooltip. */
export function SourceHealthBadge({ source }: { source: SourceHealthInput }) {
  const health = deriveSourceHealth(source);
  const display = DISPLAY[health.state];
  return (
    <Badge tone={display.tone} title={health.reason}>
      {display.label}
    </Badge>
  );
}
