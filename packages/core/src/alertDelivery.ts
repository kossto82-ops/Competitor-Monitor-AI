import { ALERT_LEVELS, type AlertLevel, type AlertStatus } from "./alertRules.js";

/**
 * Phase 29 D5b: which alerts go out by email, and when. Pure planning, like the rest of the alert logic: the
 * worker only fetches what this needs and applies the answer.
 *
 * Principles: an alert is emailed once per level (a repeat never re-sends it, a rise from IMPORTANT to URGENT
 * does), several alerts that are ready together share ONE email, an alert somebody already saw or dismissed is
 * never emailed, and a flood is impossible: a gap between emails, an hourly cap, and a cap per email.
 */
export const ALERT_EMAIL_MIN_INTERVAL_MINUTES = 15;
export const ALERT_EMAIL_MAX_PER_HOUR = 6;
export const ALERT_EMAIL_MAX_ALERTS_PER_EMAIL = 20;
export const ALERT_EMAIL_MAX_ATTEMPTS = 3;
/** A delivery reserved this recently and not finished is still being sent by another run. */
export const ALERT_EMAIL_IN_FLIGHT_MINUTES = 5;

const RANK: Record<AlertLevel, number> = { URGENT: 3, IMPORTANT: 2, NOTICE: 1 };

export interface AlertForDelivery {
  id: string;
  level: AlertLevel;
  status: AlertStatus;
  importance: number;
  occurrences: number;
}

export interface AlertDeliveryRecord {
  alertId: string;
  levelSent: AlertLevel;
  status: "PENDING" | "SENT" | "FAILED";
  createdAt: Date;
}

export interface PlanAlertEmailInput {
  enabled: boolean;
  /** Alerts below this level are never emailed (they still appear on the Today page). */
  minLevel: AlertLevel;
  alerts: readonly AlertForDelivery[];
  /** Earlier delivery attempts to THIS recipient. */
  deliveries: readonly AlertDeliveryRecord[];
  /** When the organization's last alert email left, and how many left in the last hour. */
  lastEmailAt: Date | null;
  emailsInLastHour: number;
  now: Date;
}

export interface PlannedAlert {
  alertId: string;
  level: AlertLevel;
  /** True when this alert was emailed before at a lower level and has since become more urgent. */
  upgraded: boolean;
}

export interface AlertEmailPlan {
  send: boolean;
  alerts: PlannedAlert[];
  /** Why nothing is sent, or a short note on what is. Never empty. */
  reason: string;
}

export function levelAtLeast(level: AlertLevel, minimum: AlertLevel): boolean {
  return RANK[level] >= RANK[minimum];
}

export function planAlertEmail(input: PlanAlertEmailInput): AlertEmailPlan {
  if (!input.enabled) return { send: false, alerts: [], reason: "Alert emails are turned off for this organization." };

  const ready: (PlannedAlert & { importance: number })[] = [];
  for (const alert of input.alerts) {
    if (alert.status !== "OPEN") continue; // seen or dismissed: nobody needs telling
    if (!levelAtLeast(alert.level, input.minLevel)) continue;
    const mine = input.deliveries.filter((d) => d.alertId === alert.id);
    const sentRank = Math.max(0, ...mine.filter((d) => d.status === "SENT").map((d) => RANK[d.levelSent]));
    if (sentRank >= RANK[alert.level]) continue; // already told at this level or a higher one
    // Another run reserved it a moment ago and has not finished: wait for its result instead of sending twice.
    const inFlight = mine.some((d) => d.status === "PENDING" && RANK[d.levelSent] >= RANK[alert.level] && input.now.getTime() - d.createdAt.getTime() < ALERT_EMAIL_IN_FLIGHT_MINUTES * 60_000);
    if (inFlight) continue;
    const failedAtThisLevel = mine.filter((d) => d.status === "FAILED" && d.levelSent === alert.level).length;
    if (failedAtThisLevel >= ALERT_EMAIL_MAX_ATTEMPTS) continue; // gave up: the alert is still on the Today page
    ready.push({ alertId: alert.id, level: alert.level, upgraded: sentRank > 0, importance: alert.importance });
  }
  if (ready.length === 0) return { send: false, alerts: [], reason: "No alert is waiting to be emailed." };

  const hasUrgent = ready.some((a) => a.level === "URGENT");
  if (input.emailsInLastHour >= ALERT_EMAIL_MAX_PER_HOUR) {
    return { send: false, alerts: [], reason: `The limit of ${ALERT_EMAIL_MAX_PER_HOUR} alert emails per hour was reached; the alerts go out later.` };
  }
  if (!hasUrgent && input.lastEmailAt && input.now.getTime() - input.lastEmailAt.getTime() < ALERT_EMAIL_MIN_INTERVAL_MINUTES * 60_000) {
    return { send: false, alerts: [], reason: `An alert email left less than ${ALERT_EMAIL_MIN_INTERVAL_MINUTES} minutes ago; these alerts wait and go out together.` };
  }

  const ordered = ready.sort((a, b) => RANK[b.level] - RANK[a.level] || b.importance - a.importance);
  const chosen = ordered.slice(0, ALERT_EMAIL_MAX_ALERTS_PER_EMAIL).map(({ alertId, level, upgraded }) => ({ alertId, level, upgraded }));
  const rest = ordered.length - chosen.length;
  return { send: true, alerts: chosen, reason: rest > 0 ? `${chosen.length} alerts in this email; ${rest} more go out next.` : `${chosen.length} alert${chosen.length === 1 ? "" : "s"} in this email.` };
}

/** The subject line: the most urgent level first, so it can be told apart in a crowded inbox. */
export function alertEmailSubject(alerts: readonly { level: AlertLevel; title: string; upgraded?: boolean }[]): string {
  const top = [...alerts].sort((a, b) => RANK[b.level] - RANK[a.level])[0];
  if (!top) return "Competitor alert";
  const label = top.level === "URGENT" ? "Urgent" : top.level === "IMPORTANT" ? "Important" : "Notice";
  const more = alerts.length > 1 ? ` (+${alerts.length - 1} more)` : "";
  return `[${label}] ${top.upgraded ? "Now more urgent: " : ""}${top.title}${more}`;
}

export const ALERT_EMAIL_LEVELS = ALERT_LEVELS;
