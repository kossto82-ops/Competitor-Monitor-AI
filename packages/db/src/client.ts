import { PrismaClient } from "../generated/client/index.js";

/**
 * One PrismaClient instance per process. Next.js dev mode hot-reloads
 * modules, which would otherwise create a fresh client (and connection
 * pool) on every edit - so the instance is cached on `globalThis` in
 * non-production environments.
 *
 * `log: [{ emit: "event", level: "query" }]` makes every executed SQL
 * query available via `prisma.$on("query", ...)` without printing
 * anything to stdout/console - it's inert until something subscribes.
 * Phase 2.1 uses this for `countPrismaQueries` below, so repository
 * tests can assert a function issues a bounded number of queries
 * (catching an N+1 regression) instead of just trusting the doc comment.
 */
/**
 * A plain `PrismaClient` type annotation would erase the `log` config's
 * generic event-name parameter (TypeScript would infer `$on`'s event
 * union as `never`) - going through `ReturnType` instead keeps it, so
 * `prisma.$on("query", ...)` below type-checks.
 */
function createPrismaClient() {
  return new PrismaClient({ log: [{ emit: "event", level: "query" }] });
}
type PrismaClientSingleton = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClientSingleton };

export const prisma: PrismaClientSingleton = globalForPrisma.prisma ?? createPrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}

let observing = false;
let queryCount = 0;
// Prisma's connection pool validates a connection with a literal `SELECT 1` before handing it out
// when it has been idle for a moment, and logs that probe as an ordinary "query" event. It is not a
// query the code under test issued, it appears at random (more often on a loaded machine), and
// counting it made every query-count assertion intermittently one too high. Real application queries
// are never a bare `SELECT 1`, so ignoring exactly that statement loses nothing.
const POOL_HEALTH_CHECK = "SELECT 1";

// Prisma also delivers "query" events asynchronously: the events of the last statements of an
// awaited call can arrive after the call has returned. Measured on CI, the digest query-bound test
// saw 25 and 31 statements where each run is 28 (25 + 31 = 2 x 28): the tail of the first
// measurement landed inside the second. A fixed sleep only makes that less likely, so the window is
// closed with a marker statement instead - events arrive in order, hence once the marker's own event
// is seen, every event of everything issued before it has been delivered.
const FLUSH_MARKER = "cma_query_log_flush_marker";
const FLUSH_TIMEOUT_MS = 5_000;
let onFlushMarker: (() => void) | null = null;

prisma.$on("query", (event) => {
  const statement = event.query.trim();
  if (statement.includes(FLUSH_MARKER)) {
    onFlushMarker?.();
    return;
  }
  if (observing && statement !== POOL_HEALTH_CHECK) queryCount += 1;
});

async function flushQueryEvents(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS); // never hang a test run on a lost event
    onFlushMarker = () => {
      clearTimeout(timer);
      resolve();
    };
    prisma.$queryRawUnsafe(`SELECT '${FLUSH_MARKER}'`).catch(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  onFlushMarker = null;
}

/**
 * Test-only instrumentation: runs `fn`, counting every real SQL query
 * Prisma issues on the shared client while it runs. Not used by
 * production code - only by repository tests that need to assert "this
 * stays O(1) queries as row count grows", not just "the JSON output
 * looks right".
 */
export async function countPrismaQueries(fn: () => Promise<unknown>): Promise<number> {
  await flushQueryEvents(); // whatever ran just before must not leak into this window
  queryCount = 0;
  observing = true;
  try {
    await fn();
    await flushQueryEvents(); // ...and this window's own tail must not leak out of it
    return queryCount;
  } finally {
    observing = false;
  }
}
