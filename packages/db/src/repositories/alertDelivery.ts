import type { AlertLevel } from "@cma/core";
import { prisma } from "../client.js";

const HOUR_MS = 60 * 60_000;

export interface AlertEmailSettings {
  enabled: boolean;
  minLevel: AlertLevel;
  organizationName: string;
}

export async function getAlertEmailSettings(organizationId: string): Promise<AlertEmailSettings | null> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true, alertEmailsEnabled: true, alertEmailMinLevel: true } });
  return org ? { enabled: org.alertEmailsEnabled, minLevel: org.alertEmailMinLevel, organizationName: org.name } : null;
}

/** The organizations with an open alert from the last week: whose deferred alert emails may be due (scheduler entry point). */
export async function listOrganizationIdsWithOpenAlerts(now: Date = new Date()): Promise<string[]> {
  const rows = await prisma.alertEvent.findMany({
    where: { status: "OPEN", lastRaisedAt: { gte: new Date(now.getTime() - 7 * 24 * HOUR_MS) } },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });
  return rows.map((r) => r.organizationId);
}

export interface DeliveryRecord {
  alertId: string;
  levelSent: AlertLevel;
  status: "PENDING" | "SENT" | "FAILED";
  createdAt: Date;
}

/** What was already tried for these alerts and this recipient (tenant-scoped). */
export async function listAlertDeliveries(organizationId: string, recipient: string, alertIds: string[]): Promise<DeliveryRecord[]> {
  if (alertIds.length === 0) return [];
  const rows = await prisma.alertDelivery.findMany({
    where: { organizationId, recipient, alertId: { in: alertIds } },
    select: { alertId: true, levelSent: true, status: true, createdAt: true },
  });
  return rows;
}


/** When the organization's last alert email left, and how many left in the last hour (one email = one send time). */
export async function getAlertEmailActivity(organizationId: string, now: Date = new Date()): Promise<{ lastEmailAt: Date | null; emailsInLastHour: number }> {
  const sent = await prisma.alertDelivery.findMany({
    where: { organizationId, status: "SENT", sentAt: { gte: new Date(now.getTime() - HOUR_MS) } },
    select: { sentAt: true },
    distinct: ["sentAt"],
  });
  const last = await prisma.alertDelivery.findFirst({ where: { organizationId, status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } });
  return { lastEmailAt: last?.sentAt ?? null, emailsInLastHour: sent.length };
}

export interface ReservedDelivery {
  id: string;
  alertId: string;
  level: AlertLevel;
}

/**
 * Reserves the attempts of one email before anything is sent. The attempt number comes from what already
 * exists, and the unique key (alert, recipient, level, attempt) makes a second run that raced this one fail
 * for that alert instead of emailing it twice: such alerts are simply left out of the result.
 */
export async function reserveAlertDeliveries(organizationId: string, recipient: string, items: { alertId: string; level: AlertLevel }[]): Promise<ReservedDelivery[]> {
  const reserved: ReservedDelivery[] = [];
  for (const item of items) {
    const attempt = (await prisma.alertDelivery.count({ where: { alertId: item.alertId, recipient, levelSent: item.level } })) + 1;
    try {
      const row = await prisma.alertDelivery.create({ data: { organizationId, alertId: item.alertId, recipient, levelSent: item.level, attempt } });
      reserved.push({ id: row.id, alertId: item.alertId, level: item.level });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  return reserved;
}

export async function markAlertDeliveriesSent(ids: string[], sentAt: Date): Promise<void> {
  if (ids.length > 0) await prisma.alertDelivery.updateMany({ where: { id: { in: ids } }, data: { status: "SENT", sentAt, errorMessage: null } });
}

export async function markAlertDeliveriesFailed(ids: string[], message: string): Promise<void> {
  if (ids.length > 0) await prisma.alertDelivery.updateMany({ where: { id: { in: ids } }, data: { status: "FAILED", errorMessage: message.slice(0, 500) } });
}
