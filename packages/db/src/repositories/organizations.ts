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
