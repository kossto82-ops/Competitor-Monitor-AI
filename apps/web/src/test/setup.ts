import { vi } from "vitest";

/**
 * Route tests exercise handler logic, not Redis: by default the rate
 * limiter allows everything. Tests that care about limiting override
 * these mocks (vi.mocked(hit)...), and rateLimit.test.ts imports the
 * real module with vi.importActual.
 */
vi.mock("@/lib/rateLimit", () => ({
  hit: vi.fn(async (_key: string, limit: number) => ({ allowed: true, count: 1, limit, retryAfterSeconds: 0 })),
  peek: vi.fn(async (_key: string, limit: number) => ({ allowed: true, count: 0, limit, retryAfterSeconds: 0 })),
  reset: vi.fn(async () => undefined),
}));
