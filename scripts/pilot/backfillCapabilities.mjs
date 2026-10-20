// Reads what each pilot page says its service can do (Phase 29 F1) from the snapshots already stored, and sets the
// capability lists each pilot organization reads. Stop the worker first (scripts/pilot/stop.ps1): it writes the same rows.
//   node scripts/pilot/backfillCapabilities.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = await import(pathToFileURL(join(root, "packages/db/dist/index.js")).href);
// The call-answering pilots read the telephone-service list as well as the general one.
const PACKS = { "pilot@pricing-pilot.example.test": ["general"], "pilot-es@pricing-pilot.example.test": ["general", "call-answering"], "pilot-fr@pricing-pilot.example.test": ["general", "call-answering"] };
for (const [email, packs] of Object.entries(PACKS)) {
  const owner = await db.prisma.user.findFirst({ where: { email } });
  if (!owner) continue;
  await db.updateOrganizationSettings(owner.organizationId, { capabilityPacks: packs });
  const result = await db.backfillCapabilityObservations(owner.organizationId, { force: true });
  const matrix = await db.getCapabilityMatrix(owner.organizationId);
  console.log(`${email}: packs ${packs.join("+")}, ${result.pages} pages from ${result.snapshots} snapshots`);
  for (const c of matrix.competitors) console.log("   " + c.name.padEnd(19) + String(Object.values(c.cells).filter((x) => x?.state === "PRESENT").length).padStart(3) + " capabilities seen, " + c.verifiedPages + " verified page(s)");
}
await db.prisma.$disconnect();
