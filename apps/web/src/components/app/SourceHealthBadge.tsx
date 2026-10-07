import { deriveSourceHealth, type SourceHealth, type SourceHealthInput, type SourceHealthState } from "@cma/core";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

export const SOURCE_HEALTH_DISPLAY: Record<SourceHealthState, { label: string; tone: BadgeTone }> = {
  HEALTHY: { label: "Healthy", tone: "green" },
  DEGRADED: { label: "Failing", tone: "amber" },
  STALE: { label: "Stale", tone: "red" },
  PENDING: { label: "Not scanned yet", tone: "gray" },
  PAUSED: { label: "Paused", tone: "amber" },
  DISABLED: { label: "Stopped automatically", tone: "red" },
};

/** Badge for an already-derived health, with the plain-language reason as a tooltip. */
export function SourceHealthStateBadge({ health }: { health: SourceHealth }) {
  const display = SOURCE_HEALTH_DISPLAY[health.state];
  return (
    <Badge tone={display.tone} title={health.reason}>
      {display.label}
    </Badge>
  );
}

/** Health of one monitored source, derived on the spot from its stored facts. */
export function SourceHealthBadge({ source }: { source: SourceHealthInput }) {
  return <SourceHealthStateBadge health={deriveSourceHealth(source)} />;
}
