/**
 * Runs once when the Next.js server starts (before it accepts requests).
 * Refuses to boot with a placeholder, short or reused secret, instead of
 * running with sessions and stored credentials effectively unprotected
 * (Phase 29 / A4). Node runtime only: the checks use no Edge-safe APIs.
 *
 * In production a failed check must END the process: a throw from here
 * leaves Next.js alive answering every request with a 500, which a
 * process supervisor would consider healthy and never restart or alert on.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { assertStartupConfig } = await import("@cma/security");
  try {
    assertStartupConfig(process.env, { needsAuthSecret: true });
  } catch (err) {
    if (process.env["NODE_ENV"] === "production") {
      console.error(`[web] refusing to start. ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    throw err;
  }
}
