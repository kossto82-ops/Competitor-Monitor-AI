import type { UpdateOrganizationSettingsInput } from "@cma/core";
import { prisma } from "../client.js";

export interface CreateOrganizationInput {
  organizationName: string;
  email: string;
  passwordHash: string;
}

export async function createOrganizationWithOwner(input: CreateOrganizationInput) {
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { name: input.organizationName } });
    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: input.email,
        passwordHash: input.passwordHash,
        role: "OWNER",
      },
    });
    return { organization, user };
  });
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export async function getOrganizationById(organizationId: string) {
  return prisma.organization.findUnique({ where: { id: organizationId } });
}

/**
 * Scoped by organizationId even though `id` alone is already unique -
 * the same "never trust a single id without also checking tenant
 * ownership" discipline as every other repository function here.
 */
export async function getUserForOrg(organizationId: string, userId: string) {
  return prisma.user.findFirst({ where: { id: userId, organizationId } });
}

/**
 * Phase 5 (Section 18): the customer-facing email/report preferences -
 * daily report enabled/disabled, recipient override, timezone. An empty
 * string for `reportRecipientEmail` clears the override (falls back to
 * the OWNER's email, see dailyReports.ts's getReportRecipientEmailForOrg).
 */
export async function updateOrganizationSettings(organizationId: string, input: UpdateOrganizationSettingsInput) {
  return prisma.organization.update({
    where: { id: organizationId },
    data: {
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.dailyReportEnabled !== undefined ? { dailyReportEnabled: input.dailyReportEnabled } : {}),
      ...(input.reportRecipientEmail !== undefined ? { reportRecipientEmail: input.reportRecipientEmail || null } : {}),
    },
  });
}
