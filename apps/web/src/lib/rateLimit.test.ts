import { describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";

// The suite-wide setup mocks this module; here we test the real one.
const real = await vi.importActual<typeof import("./rateLimit")>("./rateLimit");

/** In-memory store with a controllable clock, for deterministic window behaviour. */
function memoryStore() {
  let now = 0;
  const data = new Map<string, { count: number; expiresAt: number }>();
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry && entry.expiresAt <= now) data.delete(key);
    return data.get(key);
  };
  return {
    advance: (seconds: number) => {
      now += seconds;
    },
    store: {
      async incr(key: string, windowSeconds: number) {
        const entry = live(key) ?? { count: 0, expiresAt: now + windowSeconds };
        entry.count += 1;
        data.set(key, entry);
        return { count: entry.count, ttlSeconds: entry.expiresAt - now };
      },
      async read(key: string) {
        const entry = live(key);
        return { count: entry?.count ?? 0, ttlSeconds: entry ? entry.expiresAt - now : 0 };
      },
      async del(key: string) {
        data.delete(key);
      },
    },
  };
}

describe("rate limiter (fixed window)", () => {
  it("allows up to the limit, then blocks and reports when to retry", async () => {
    const { store } = memoryStore();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await real.hit("k", 3, 60, store));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ count: 4, limit: 3, retryAfterSeconds: 60 });
  });

  it("starts a fresh window once the previous one has expired", async () => {
    const { store, advance } = memoryStore();
    for (let i = 0; i < 4; i++) await real.hit("k", 3, 60, store);
    advance(61);
    expect((await real.hit("k", 3, 60, store)).allowed).toBe(true);
  });

  it("keeps separate keys (tenants, actions) independent", async () => {
    const { store } = memoryStore();
    for (let i = 0; i < 5; i++) await real.hit("org-a", 3, 60, store);
    expect((await real.hit("org-a", 3, 60, store)).allowed).toBe(false);
    expect((await real.hit("org-b", 3, 60, store)).allowed).toBe(true);
  });

  it("peek does not count, and reset clears the window", async () => {
    const { store } = memoryStore();
    await real.hit("k", 2, 60, store);
    await real.hit("k", 2, 60, store);

    expect((await real.peek("k", 2, store)).allowed).toBe(false);
    expect((await real.peek("k", 2, store)).count).toBe(2); // unchanged by peeking

    await real.reset("k", store);
    expect((await real.peek("k", 2, store)).allowed).toBe(true);
  });

  it("fails OPEN (never locks users out) when the store errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {
      incr: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      read: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      del: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };

    expect((await real.hit("k", 1, 60, broken)).allowed).toBe(true);
    expect((await real.peek("k", 1, broken)).allowed).toBe(true);
    await expect(real.reset("k", broken)).resolves.toBeUndefined();
    error.mockRestore();
  });
});

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";

async function redisIsReachable(): Promise<boolean> {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 1500 });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

describe.skipIf(!(await redisIsReachable()))("rate limiter against real Redis", () => {
  it("counts atomically across concurrent requests and expires the window", async () => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const store = real.createRedisRateLimitStore(redis);
    const key = `test-${Date.now()}-${Math.random()}`;
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => real.hit(key, 4, 2, store)));
      expect(results.filter((r) => r.allowed)).toHaveLength(4);
      expect(results.filter((r) => !r.allowed)).toHaveLength(6);
      expect(Math.max(...results.map((r) => r.retryAfterSeconds))).toBeLessThanOrEqual(2);

      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect((await real.hit(key, 4, 2, store)).allowed).toBe(true);
    } finally {
      await store.del(key);
      redis.disconnect();
    }
  });

  it("the TTL is set once, on the first hit (later hits do not extend the window)", async () => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const store = real.createRedisRateLimitStore(redis);
    const key = `test-ttl-${Date.now()}-${Math.random()}`;
    try {
      const first = await store.incr(key, 30);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = await store.incr(key, 30);
      expect(second.ttlSeconds).toBeLessThan(first.ttlSeconds);
    } finally {
      await store.del(key);
      redis.disconnect();
    }
  });
});
