// Phase 11: standalone Node subprocess-seeding script, same rationale and
// convention as seedPatternEvents.mjs's header comment (Playwright's
// esbuild loader + npm workspace symlinks cannot import packages/db/dist
// directly inside a spec file on this machine).
//
// Deterministically produces a FAILED DigestAiInterpretation row for a
// given organization/days without depending on a real (or even fake)
// provider ever throwing - there is no other reliable way to exercise
// "AI failure never destroys the deterministic Digest" in a real
// browser E2E run, since the shared apps/worker process in this dev
// environment always resolves a working fake provider fallback outside
// production (see resolveAiProvider.ts). This script proves the UI
// renders the FAILED state correctly and that the deterministic feed
// above it is completely unaffected, independent of how a real FAILED
// row would have been produced in production.
//
// Usage: node seedFailedDigestInterpretation.mjs '<JSON payload>'
// Payload shape: { competitorId: string, days: number, errorMessage: string }
// organizationId is resolved from competitorId (same pattern as
// seedPatternEvents.mjs) so the calling spec only ever needs the id it
// already has from the browser's own URL.

import { prisma, getOrCreateDigestAiInterpretationSlot, markDigestAiInterpretationRunning, markDigestAiInterpretationFailed } from "../../../packages/db/dist/index.js";

async function main() {
  const payload = JSON.parse(process.argv[2]);
  const { competitorId, days, errorMessage } = payload;

  const competitor = await prisma.competitor.findUniqueOrThrow({ where: { id: competitorId }, select: { organizationId: true } });
  const organizationId = competitor.organizationId;

  const slot = await getOrCreateDigestAiInterpretationSlot(organizationId, days, "digest-interpretation-v1");
  await markDigestAiInterpretationRunning(slot.id);
  await markDigestAiInterpretationFailed(slot.id, errorMessage);

  console.log(JSON.stringify({ ok: true }));
}

main()
  .catch((err) => {
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
