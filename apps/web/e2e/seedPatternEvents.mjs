// Phase 7.1: standalone Node script (NOT loaded through Playwright's TS
// transform) that seeds real ChangeEvent rows directly via @cma/db for
// pattern-intelligence.spec.ts. Run as a child process from the spec via
// child_process.execFileSync - importing packages/db/dist directly INSIDE
// a Playwright spec file throws `TypeError: Cannot redefine property:
// NotFoundError` (a duplicate-module-instance issue specific to
// Playwright's esbuild-based loader + npm workspace symlinks on this
// machine); running as a genuinely separate `node` process sidesteps it
// entirely, matching the existing scripts/validation/*.mjs convention
// used by other phases for the same kind of direct-DB seeding need.
//
// Usage: node seedPatternEvents.mjs '<JSON payload>'
// Payload shape: { competitorId: string, backdateCreatedAtDays?: number,
//                   events: [{ changeType?, entityKey?, detectedAtDaysAgo }] }
// organizationId/monitoredUrlId are resolved from competitorId here (the
// competitor's first monitored URL) so the calling spec only ever needs
// the id it already has from the browser's own URL.
// Prints JSON `{ ok: true }` to stdout on success, or `{ ok: false, error }`.

import { prisma } from "../../../packages/db/dist/index.js";

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  const payload = JSON.parse(process.argv[2]);
  const { competitorId, backdateCreatedAtDays, events } = payload;

  const competitor = await prisma.competitor.findUniqueOrThrow({ where: { id: competitorId }, select: { organizationId: true } });
  const monitoredUrl = await prisma.monitoredUrl.findFirstOrThrow({ where: { competitorId }, select: { id: true } });
  const organizationId = competitor.organizationId;
  const monitoredUrlId = monitoredUrl.id;

  if (typeof backdateCreatedAtDays === "number") {
    await prisma.competitor.update({
      where: { id: competitorId },
      data: { createdAt: new Date(Date.now() - backdateCreatedAtDays * DAY) },
    });
  }

  for (const event of events ?? []) {
    const job = await prisma.monitoringJob.create({ data: { organizationId, monitoredUrlId, status: "COMPLETED" } });
    const snapshot = await prisma.snapshot.create({
      data: {
        organizationId,
        monitoredUrlId,
        monitoringJobId: job.id,
        extractionMethod: "CHEERIO",
        verificationState: "CHANGED",
        normalizedContent: "content",
        confidence: 1,
      },
    });
    await prisma.changeEvent.create({
      data: {
        organizationId,
        monitoredUrlId,
        currentSnapshotId: snapshot.id,
        changeType: event.changeType ?? "PRICE_CHANGE",
        severity: "MEDIUM",
        confidence: 0.9,
        entityKey: event.entityKey ?? "pro-plan",
        fieldPath: "product.price",
        oldValue: "10.00",
        newValue: "12.00",
        currency: "USD",
        percentageChange: 20,
        evidenceExcerpt: "evidence",
        detectedAt: new Date(Date.now() - event.detectedAtDaysAgo * DAY),
      },
    });
  }

  await prisma.$disconnect();
  process.stdout.write(JSON.stringify({ ok: true }));
}

main().catch(async (err) => {
  await prisma.$disconnect().catch(() => undefined);
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
  process.exitCode = 1;
});
