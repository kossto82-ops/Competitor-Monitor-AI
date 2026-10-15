// Rebuilds the entity history (plans and prices followed across scans, Phase 29 D1) of the pilot from the
// snapshots it already holds. Stop the worker first (scripts/pilot/stop.ps1): it writes the same rows.
//   node scripts/pilot/backfillEntities.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = await import(pathToFileURL(join(root, "packages/db/dist/index.js")).href);
const owner = await db.prisma.user.findFirst({ where: { email: process.argv[2] ?? "pilot@pricing-pilot.example.test" } });
if (!owner) throw new Error("The pilot has not been set up (node scripts/pilot/seedPilot.mjs).");

const result = await db.backfillEntityHistory(owner.organizationId, { force: true });
console.log(`rebuilt ${result.sources} sources from ${result.snapshots} verified snapshots\n`);
const sources = await db.listSourceHealthForOrg(owner.organizationId);
for (const s of sources) {
  const history = await db.listEntityHistory(owner.organizationId, s.id);
  const versions = history.flatMap((e) => e.versions);
  const by = (o) => versions.filter((v) => v.origin === o).length;
  console.log(`${s.competitorName.padEnd(16)} entities ${String(history.length).padStart(3)} (absent ${history.filter((e) => e.status === "ABSENT").length})  versions: first ${by("FIRST_SEEN")}, change ${by("CHANGE")}, baseline ${by("BASELINE")}, reappeared ${by("REAPPEARED")}`);
}

// Signals (Phase 29 D2) are promoted from the change events that already exist.
const signals = await db.backfillSignals(owner.organizationId);
console.log(`\nsignals: ${signals.events} events -> ${signals.created} created, ${signals.attached} attached to an existing signal, ${signals.skipped} not promoted`);
for (const s of await db.listSignals(owner.organizationId)) {
  console.log(`  ${s.occurredAt.toISOString().slice(0, 16)} ${s.competitorName.padEnd(10)} ${s.kind.padEnd(14)} ${s.title} (confidence ${s.confidence}, evidence ${s.evidenceCount})`);
}
await db.prisma.$disconnect();
