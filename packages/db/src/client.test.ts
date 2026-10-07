import { describe, expect, it } from "vitest";
import { countPrismaQueries, prisma } from "./client.js";

async function databaseIsReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();

/**
 * countPrismaQueries backs every "bounded number of queries" assertion in this package. It was the
 * source of three intermittent CI failures (a pool health-check `SELECT 1` counted as a query, and the
 * tail of one measurement landing inside the next one), so it is tested directly: the same fixed shape
 * of queries must always count the same, even back to back and with concurrent statements.
 */
describe.skipIf(!reachable)("countPrismaQueries", () => {
  it("counts exactly the statements of the call, independent of timing, across back-to-back windows", { timeout: 60_000 }, async () => {
    await prisma.organization.count(); // warm the connection pool

    for (let i = 0; i < 12; i += 1) {
      const first = await countPrismaQueries(async () => {
        await Promise.all([prisma.organization.count(), prisma.organization.count(), prisma.organization.count()]);
      });
      const second = await countPrismaQueries(async () => {
        await prisma.organization.findMany({ take: 1 });
        await Promise.all([prisma.organization.count(), prisma.user.count(), prisma.competitor.count()]);
        // An idle gap makes the pool re-validate the connection (the `SELECT 1` it must not count).
        if (i % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 80));
      });
      expect([first, second], `iteration ${i}`).toEqual([3, 4]);
    }
  });

  it("counts nothing for a call that issues no query, and does not count its own flush statements", async () => {
    expect(await countPrismaQueries(async () => undefined)).toBe(0);
  });

  it("does not leak the statements of earlier un-awaited work into the next window", async () => {
    // Fire-and-forget work started before the window: its statements belong to no window.
    const stray = Promise.all([prisma.organization.count(), prisma.organization.count()]);
    await stray;
    expect(await countPrismaQueries(async () => undefined)).toBe(0);
  });
});
