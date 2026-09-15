import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path mapping. Vitest does
    // not read tsconfig paths on its own; route/lib tests that import via
    // the "@/..." alias (matching real production import style) would
    // otherwise fail to resolve.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // Playwright's own spec files live under e2e/ and must never be picked
    // up by vitest's default `**/*.spec.ts` glob - without this exclude,
    // `npm test` tries to run them as vitest tests and fails immediately
    // with "Playwright Test did not expect test.describe() to be called
    // here", masking whatever real unit test results follow.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
