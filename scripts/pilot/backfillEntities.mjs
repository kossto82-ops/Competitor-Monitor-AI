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
const owner = await db.prisma.user.findFirst({ where: { email: "pilot@pricing-pilot.example.test" } });
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
await db.prisma.$disconnect();
