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
