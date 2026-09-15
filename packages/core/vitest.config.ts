import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This package is pure types/enums/zod schemas re-exported and
    // exercised by consumers (see apps/web/src/lib/schemas.test.ts) -
    // it has no behavior of its own to unit test yet.
    passWithNoTests: true,
  },
});
