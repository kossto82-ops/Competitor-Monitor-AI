import { Redis } from "ioredis";

/**
 * Phase 29 / A3: fixed-window counters in Redis (already required by the
 * queue), shared by every web instance.
 *
 * Failure policy: FAIL OPEN. If Redis cannot be reached the limiter lets
 * the request through and logs, instead of locking every customer out of
 * login because a cache is down. The cost-bearing routes also enqueue
 * jobs in the same Redis, so they fail on their own in that situation;
 * the limiter is not the last line for them.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Hits recorded in the current window, including this one for `hit`. */
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  /** Atomically increments the window counter (creating it with a TTL on first use). */
  incr(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
  read(key: string): Promise<{ count: number; ttlSeconds: number }>;
  del(key: string): Promise<void>;
}

const KEY_PREFIX = "cma:rl:";

export function createRedisRateLimitStore(redis: Redis): RateLimitStore {
  return {
    async incr(key, windowSeconds) {
      const results = await redis.multi().incr(KEY_PREFIX + key).expire(KEY_PREFIX + key, windowSeconds, "NX").ttl(KEY_PREFIX + key).exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
      return { count, ttlSeconds: ttl > 0 ? ttl : windowSeconds };
    },
    async read(key) {
      const [count, ttl] = await Promise.all([redis.get(KEY_PREFIX + key), redis.ttl(KEY_PREFIX + key)]);
      return { count: Number(count ?? 0), ttlSeconds: ttl > 0 ? ttl : 0 };
    },
    async del(key) {
      await redis.del(KEY_PREFIX + key);
    },
  };
}

let defaultStore: RateLimitStore | null = null;

function getDefaultStore(): RateLimitStore {
  if (!defaultStore) {
    const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
      // Short, bounded waits: a dead Redis must not hang a login request.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      commandTimeout: 750,
      lazyConnect: true,
    });
    let warned = false;
    redis.on("error", (err: Error) => {
      if (!warned) {
        warned = true;
        console.error("[rate-limit] Redis unavailable, limits are not being enforced:", err.message);
      }
    });
    redis.on("ready", () => {
      warned = false;
    });
    defaultStore = createRedisRateLimitStore(redis);
    (defaultStore as RateLimitStore & { redis?: Redis }).redis = redis;
  }
  return defaultStore;
}

async function ensureConnected(store: RateLimitStore): Promise<void> {
  const redis = (store as RateLimitStore & { redis?: Redis }).redis;
  if (redis && redis.status === "wait") await redis.connect();
}

/** Records one hit and reports whether it is within `limit` for the current window. */
export async function hit(key: string, limit: number, windowSeconds: number, store: RateLimitStore = getDefaultStore()): Promise<RateLimitResult> {
  try {
    await ensureConnected(store);
    const { count, ttlSeconds } = await store.incr(key, windowSeconds);
    return { allowed: count <= limit, count, limit, retryAfterSeconds: ttlSeconds };
  } catch (err) {
    console.error(`[rate-limit] hit(${key}) failed open:`, err instanceof Error ? err.message : err);
    return { allowed: true, count: 0, limit, retryAfterSeconds: 0 };
  }
}

/** Reads the window counter without recording a hit (used to block before counting only failures). */
export async function peek(key: string, limit: number, store: RateLimitStore = getDefaultStore()): Promise<RateLimitResult> {
  try {
    await ensureConnected(store);
    const { count, ttlSeconds } = await store.read(key);
    return { allowed: count < limit, count, limit, retryAfterSeconds: ttlSeconds };
  } catch (err) {
    console.error(`[rate-limit] peek(${key}) failed open:`, err instanceof Error ? err.message : err);
    return { allowed: true, count: 0, limit, retryAfterSeconds: 0 };
  }
}

export async function reset(key: string, store: RateLimitStore = getDefaultStore()): Promise<void> {
  try {
    await ensureConnected(store);
    await store.del(key);
  } catch (err) {
    console.error(`[rate-limit] reset(${key}) failed:`, err instanceof Error ? err.message : err);
  }
}
