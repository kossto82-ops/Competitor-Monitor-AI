/**
 * Runs once when the Next.js server starts (before it accepts requests).
 * Refuses to boot with a placeholder, short or reused secret, instead of
 * running with sessions and stored credentials effectively unprotected
 * (Phase 29 / A4). Node runtime only: the checks use no Edge-safe APIs.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { assertStartupConfig } = await import("@cma/security");
  assertStartupConfig(process.env, { needsAuthSecret: true });
}
