import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against the already-running real stack (Next.js dev server,
 * PostgreSQL, Redis, worker, and the Phase 1 fixture server) - see
 * DevRunbook.md for how to start each one. Deliberately does NOT use
 * Playwright's `webServer` auto-start: this suite exercises the real
 * worker + queue + database end to end, which are separate processes
 * Playwright itself has no business managing.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // tests share one Postgres/Redis; keep it deterministic
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:3101",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
