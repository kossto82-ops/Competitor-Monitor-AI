import {
  ALERT_COOLDOWN_HOURS,
  ALERT_LEVELS,
  DEFAULT_ALERT_RULES,
  decideAlert,
  validateAlertRules,
  type AlertLevel,
  type AlertRuleSpec,
  type AlertStatus,
  type SignalKind,
} from "@cma/core";
import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";
import { listPrioritizedSignals } from "./importance.js";

export class InvalidAlertRulesError extends Error {}

/** The organization's own rules when it has defined any, otherwise the built-in ones. */
export async function getActiveAlertRules(organizationId: string): Promise<AlertRuleSpec[]> {
  const rows = await prisma.alertRule.findMany({ where: { organizationId }, orderBy: { position: "asc" } });
  if (rows.length === 0) return DEFAULT_ALERT_RULES;
  return rows.map((r) => ({
    id: r.ruleKey,
    name: r.name,
    level: r.level,
    minImportance: r.minImportance,
    minConfidence: r.minConfidence,
    kinds: r.kinds as SignalKind[],
    enabled: r.enabled,
  }));
}

/** Replaces the organization's rules with this set (validated). An empty set goes back to the built-in rules. */
export async function replaceAlertRules(organizationId: string, rules: AlertRuleSpec[]): Promise<AlertRuleSpec[]> {
  const problem = validateAlertRules(rules);
  if (problem) throw new InvalidAlertRulesError(problem);
  await prisma.$transaction([
    prisma.alertRule.deleteMany({ where: { organizationId } }),
    ...rules.map((r, position) =>
      prisma.alertRule.create({
        data: { organizationId, ruleKey: r.id, name: r.name, level: r.level, minImportance: r.minImportance, minConfidence: r.minConfidence, kinds: r.kinds, enabled: r.enabled, position },
      }),
    ),
  ]);
  return getActiveAlertRules(organizationId);
}

const LEVEL_RANK: Record<AlertLevel, number> = { URGENT: 3, IMPORTANT: 2, NOTICE: 1 };
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export interface RaiseAlertsResult {
  evaluated: number;
  created: number;
  merged: number;
}

/**
 * Turns the organization's recent signals into alerts by its rules. Each signal is handled once (an alert
 * remembers the signals behind it); a signal that matches no rule today is looked at again next time, because
 * what makes it important (another competitor doing the same) can appear later. A repeat of the same page,
 * plan and kind within the cooldown joins the open alert: it counts as one more occurrence, never as a
 * second alert, and can only raise the alert's level.
 */
export async function raiseAlerts(organizationId: string, options: { now?: Date } = {}): Promise<RaiseAlertsResult> {
  const now = options.now ?? new Date();
  const rules = await getActiveAlertRules(organizationId);
  const { signals } = await listPrioritizedSignals(organizationId, { since: new Date(now.getTime() - LOOKBACK_MS), limit: 500, now });
  const result: RaiseAlertsResult = { evaluated: 0, created: 0, merged: 0 };
  if (signals.length === 0) return result;

  const handled = new Set((await prisma.alertSignal.findMany({ where: { organizationId, signalId: { in: signals.map((s) => s.id) } }, select: { signalId: true } })).map((l) => l.signalId));
  // Oldest first, so that a burst of repeats collapses into the alert of its first signal.
  const pending = signals.filter((s) => !handled.has(s.id)).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  for (const signal of pending) {
    result.evaluated += 1;
    const decision = decideAlert(
      {
        id: signal.id,
        kind: signal.kind as SignalKind,
        title: signal.title,
        summary: signal.summary,
        entityKey: signal.entityKey,
        monitoredUrlId: signal.monitoredUrlId,
        competitorId: signal.competitorId,
        competitorName: signal.competitorName,
        confidence: signal.confidence,
        occurredAt: signal.occurredAt,
        evidenceCount: signal.evidenceCount,
        importance: signal.importance,
        tier: signal.tier,
        factors: signal.factors,
      },
      rules,
    );
    if (!decision) continue;

    const cooldownStart = new Date(signal.occurredAt.getTime() - ALERT_COOLDOWN_HOURS * 60 * 60_000);
    const open = await prisma.alertEvent.findFirst({
      where: { organizationId, dedupeKey: decision.dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] }, lastRaisedAt: { gte: cooldownStart } },
      orderBy: { lastRaisedAt: "desc" },
    });
    if (open) {
      const higher = LEVEL_RANK[decision.level] > LEVEL_RANK[open.level];
      await prisma.$transaction([
        prisma.alertSignal.create({ data: { organizationId, alertId: open.id, signalId: signal.id } }),
        prisma.alertEvent.update({
          where: { id: open.id },
          data: {
            occurrences: { increment: 1 },
            lastRaisedAt: signal.occurredAt > open.lastRaisedAt ? signal.occurredAt : open.lastRaisedAt,
            importance: Math.max(open.importance, signal.importance),
            // Only ever upgraded: a repeat cannot quietly downgrade an alert somebody may already have seen.
            ...(higher ? { level: decision.level, ruleKey: decision.rule.id, ruleName: decision.rule.name, explanation: decision.explanation } : {}),
          },
        }),
      ]);
      result.merged += 1;
      continue;
    }
    await prisma.alertEvent.create({
      data: {
        organizationId,
        competitorId: signal.competitorId,
        monitoredUrlId: signal.monitoredUrlId,
        ruleKey: decision.rule.id,
        ruleName: decision.rule.name,
        level: decision.level,
        title: decision.title,
        explanation: decision.explanation,
        importance: signal.importance,
        confidence: signal.confidence,
        dedupeKey: decision.dedupeKey,
        firstRaisedAt: signal.occurredAt,
        lastRaisedAt: signal.occurredAt,
        signals: { create: { organizationId, signalId: signal.id } },
      },
    });
    result.created += 1;
  }
  return result;
}

export interface AlertListItem {
  id: string;
  level: AlertLevel;
  status: AlertStatus;
  title: string;
  explanation: string;
  importance: number;
  confidence: number;
  ruleName: string;
  occurrences: number;
  firstRaisedAt: Date;
  lastRaisedAt: Date;
  competitorId: string;
  competitorName: string;
  monitoredUrlId: string;
  url: string;
  signalIds: string[];
}

/** Alerts of the organization, most urgent first and newest first among equals (tenant-scoped). */
export async function listAlerts(organizationId: string, options: { status?: AlertStatus; limit?: number } = {}): Promise<AlertListItem[]> {
  const rows = await prisma.alertEvent.findMany({
    where: { organizationId, ...(options.status ? { status: options.status } : {}) },
    orderBy: { lastRaisedAt: "desc" },
    take: options.limit ?? 200,
    include: { monitoredUrl: { select: { url: true, competitor: { select: { name: true } } } }, signals: { select: { signalId: true } } },
  });
  return rows
    .map((r) => ({
      id: r.id,
      level: r.level,
      status: r.status,
      title: r.title,
      explanation: r.explanation,
      importance: r.importance,
      confidence: r.confidence,
      ruleName: r.ruleName,
      occurrences: r.occurrences,
      firstRaisedAt: r.firstRaisedAt,
      lastRaisedAt: r.lastRaisedAt,
      competitorId: r.competitorId,
      competitorName: r.monitoredUrl.competitor.name,
      monitoredUrlId: r.monitoredUrlId,
      url: r.monitoredUrl.url,
      signalIds: r.signals.map((s) => s.signalId),
    }))
    .sort((a, b) => ALERT_LEVELS.indexOf(a.level) - ALERT_LEVELS.indexOf(b.level) || b.lastRaisedAt.getTime() - a.lastRaisedAt.getTime());
}

/** Marks an alert as seen or dismissed (tenant-scoped). A dismissed alert is not reopened by a repeat: the next one is a new alert. */
export async function setAlertStatus(organizationId: string, alertId: string, status: AlertStatus): Promise<void> {
  const result = await prisma.alertEvent.updateMany({ where: { id: alertId, organizationId }, data: { status, statusChangedAt: new Date() } });
  if (result.count === 0) throw new NotFoundError("Alert");
}
