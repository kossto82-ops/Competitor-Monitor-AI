import { decryptCredential, encryptCredential } from "@cma/security";
import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";

/**
 * Phase 29 / A2b: an organization's own SMTP account. Same rules as
 * AiConnection: the ONLY shape an API caller ever sees is
 * SafeSmtpConnection (`hasPassword`, never the password, not even
 * encrypted), and exactly one function returns the decrypted password.
 * One connection per organization (`organizationId` is unique), so every
 * query is keyed by it directly - there is no id to mix up across tenants.
 */
export interface SafeSmtpConnection {
  id: string;
  organizationId: string;
  host: string;
  port: number;
  security: "ssl" | "starttls";
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface SmtpConnectionRow {
  id: string;
  organizationId: string;
  host: string;
  port: number;
  security: string;
  username: string | null;
  encryptedPassword: string | null;
  fromAddress: string;
  fromName: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toSafe(row: SmtpConnectionRow): SafeSmtpConnection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    host: row.host,
    port: row.port,
    security: row.security === "ssl" ? "ssl" : "starttls",
    username: row.username,
    hasPassword: !!row.encryptedPassword,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getSmtpConnectionForOrg(organizationId: string): Promise<SafeSmtpConnection | null> {
  const row = await prisma.organizationSmtpConnection.findUnique({ where: { organizationId } });
  return row ? toSafe(row) : null;
}

export interface UpsertSmtpConnectionInput {
  host: string;
  port: number;
  security: "ssl" | "starttls";
  username?: string | null;
  /** undefined = keep the stored password, null = remove it, string = replace it. */
  password?: string | null;
  fromAddress: string;
  fromName?: string | null;
  enabled?: boolean;
}

export async function upsertSmtpConnectionForOrg(organizationId: string, input: UpsertSmtpConnectionInput): Promise<SafeSmtpConnection> {
  const passwordData =
    input.password === undefined ? {} : { encryptedPassword: input.password === null ? null : encryptCredential(input.password) };

  const shared = {
    host: input.host,
    port: input.port,
    security: input.security,
    username: input.username ?? null,
    fromAddress: input.fromAddress,
    fromName: input.fromName ?? null,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...passwordData,
  };

  const row = await prisma.organizationSmtpConnection.upsert({
    where: { organizationId },
    create: { organizationId, ...shared },
    update: shared,
  });
  return toSafe(row);
}

export async function deleteSmtpConnectionForOrg(organizationId: string): Promise<void> {
  const result = await prisma.organizationSmtpConnection.deleteMany({ where: { organizationId } });
  if (result.count === 0) throw new NotFoundError("SmtpConnection");
}

export interface DecryptedSmtpConfig {
  host: string;
  port: number;
  security: "ssl" | "starttls";
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
}

/**
 * The ONLY function that returns the decrypted SMTP password. Used by
 * the worker (report delivery) and by the settings "send test email"
 * route, in memory, for a single connection attempt - never logged and
 * never sent to a browser. Returns null when the organization has no
 * connection or has disabled it, so callers fall back to the operator's
 * default delivery.
 */
export async function getEnabledSmtpConfigForOrg(organizationId: string): Promise<DecryptedSmtpConfig | null> {
  const row = await prisma.organizationSmtpConnection.findUnique({ where: { organizationId } });
  if (!row || !row.enabled) return null;
  return {
    host: row.host,
    port: row.port,
    security: row.security === "ssl" ? "ssl" : "starttls",
    username: row.username,
    password: row.encryptedPassword ? decryptCredential(row.encryptedPassword) : null,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
  };
}
