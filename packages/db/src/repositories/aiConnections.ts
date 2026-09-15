import { decryptCredential, encryptCredential } from "@cma/security";
import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";

/**
 * Phase 3.1 (Section 6): the ONLY shape ever returned to an API caller,
 * including an organization's own admins. `encryptedApiKey` never
 * appears here - `hasApiKey` is the "API key configured" masked
 * indicator the brief asks for, never the key itself or any attempt to
 * partially reveal it.
 */
export interface SafeAiConnection {
  id: string;
  organizationId: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface AiConnectionRow {
  id: string;
  organizationId: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  encryptedApiKey: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toSafeAiConnection(row: AiConnectionRow): SafeAiConnection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    hasApiKey: row.encryptedApiKey.length > 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateAiConnectionInput {
  provider: string;
  model: string;
  baseUrl?: string | null;
  apiKey: string;
  enabled?: boolean;
}

export async function createAiConnection(organizationId: string, input: CreateAiConnectionInput): Promise<SafeAiConnection> {
  const row = await prisma.aiConnection.create({
    data: {
      organizationId,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      encryptedApiKey: encryptCredential(input.apiKey),
      enabled: input.enabled ?? true,
    },
  });
  return toSafeAiConnection(row);
}

export async function listAiConnectionsForOrg(organizationId: string): Promise<SafeAiConnection[]> {
  const rows = await prisma.aiConnection.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
  return rows.map(toSafeAiConnection);
}

export async function getAiConnectionForOrg(organizationId: string, id: string): Promise<SafeAiConnection> {
  const row = await prisma.aiConnection.findFirst({ where: { id, organizationId } });
  if (!row) throw new NotFoundError("AiConnection");
  return toSafeAiConnection(row);
}

export interface UpdateAiConnectionInput {
  provider?: string;
  model?: string;
  baseUrl?: string | null;
  /** Omit to leave the stored credential unchanged - only set this when the caller supplied a new key. */
  apiKey?: string;
  enabled?: boolean;
}

export async function updateAiConnection(organizationId: string, id: string, input: UpdateAiConnectionInput): Promise<SafeAiConnection> {
  const existing = await prisma.aiConnection.findFirst({ where: { id, organizationId } });
  if (!existing) throw new NotFoundError("AiConnection");

  const row = await prisma.aiConnection.update({
    where: { id },
    data: {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.apiKey !== undefined ? { encryptedApiKey: encryptCredential(input.apiKey) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  return toSafeAiConnection(row);
}

export async function deleteAiConnection(organizationId: string, id: string): Promise<void> {
  const existing = await prisma.aiConnection.findFirst({ where: { id, organizationId } });
  if (!existing) throw new NotFoundError("AiConnection");
  await prisma.aiConnection.delete({ where: { id } });
}

/**
 * Section 4 (multi-tenant requirement): the ONLY function in the
 * codebase that returns a DECRYPTED credential - called exclusively by
 * apps/worker's provider-resolution path (never by an API route, never
 * by anything that could put the result in an HTTP response). Picks
 * the most recently updated ENABLED connection if an organization has
 * more than one; there is no separate "default" flag in this phase
 * (Section 30: reuse/extend only where necessary) - if a customer needs
 * more than one enabled connection managed explicitly, that is future
 * work, not a gap introduced here.
 */
export interface DecryptedAiConnectionConfig {
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string;
}

export async function getEnabledAiConnectionConfigForOrg(organizationId: string): Promise<DecryptedAiConnectionConfig | null> {
  const row = await prisma.aiConnection.findFirst({
    where: { organizationId, enabled: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return null;
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    apiKey: decryptCredential(row.encryptedApiKey),
  };
}
