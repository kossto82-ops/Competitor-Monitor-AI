import { PrismaClient } from "../generated/client/index.js";

/**
 * One PrismaClient instance per process. Next.js dev mode hot-reloads
 * modules, which would otherwise create a fresh client (and connection
 * pool) on every edit - so the instance is cached on `globalThis` in
 * non-production environments.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}
