// What the pricing pilot has observed so far. Read-only.
//   node scripts/pilot/status.mjs
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = await import(pathToFileURL(join(root, "packages/db/dist/index.js")).href);
const { prisma } = db;

const owner = await prisma.user.findFirst({ where: { email: "pilot@pricing-pilot.example.test" } });
if (!owner) {
  console.log("The pilot has not been set up yet: run  node scripts/pilot/seedPilot.mjs");
  process.exit(0);
}
const orgId = owner.organizationId;
const ago = (d) => (d ? `${Math.round((Date.now() - d.getTime()) / 60000)} min ago` : "never");

const rows = await db.listSourceHealthForOrg(orgId);
const jobs = await prisma.monitoringJob.groupBy({ by: ["monitoredUrlId", "status"], where: { organizationId: orgId }, _count: true });
const snaps = await prisma.snapshot.groupBy({ by: ["monitoredUrlId", "verificationState"], where: { organizationId: orgId }, _count: true });
const events = await prisma.changeEvent.findMany({ where: { organizationId: orgId }, select: { monitoredUrlId: true, changeType: true, severity: true } });
const first = await prisma.monitoringJob.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });

console.log(`Pilot running since: ${first ? first.createdAt.toISOString() : "no scan yet"}  (${first ? ((Date.now() - first.createdAt.getTime()) / 3_600_000).toFixed(1) : 0} h)\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("source", 18)} ${pad("health", 9)} ${pad("scans ok/fail", 14)} ${pad("verified/changed/unverified", 28)} ${pad("events", 7)} last success`);
let totals = { ok: 0, fail: 0, events: 0 };
for (const r of rows) {
  const j = (s) => jobs.filter((x) => x.monitoredUrlId === r.id && x.status === s).reduce((n, x) => n + x._count, 0);
  const s = (v) => snaps.filter((x) => x.monitoredUrlId === r.id && x.verificationState === v).reduce((n, x) => n + x._count, 0);
  const ev = events.filter((e) => e.monitoredUrlId === r.id).length;
  totals.ok += j("COMPLETED"); totals.fail += j("FAILED"); totals.events += ev;
  console.log(`${pad(r.competitorName, 18)} ${pad(r.health.state, 9)} ${pad(`${j("COMPLETED")}/${j("FAILED")}`, 14)} ${pad(`${s("NO_CHANGE")}/${s("CHANGED")}/${s("FAILED_TO_VERIFY")}`, 28)} ${pad(ev, 7)} ${ago(r.lastSuccessfulScanAt)}`);
}
const byType = {};
for (const e of events) byType[`${e.changeType}/${e.severity}`] = (byType[`${e.changeType}/${e.severity}`] ?? 0) + 1;
console.log(`\nTotal: ${totals.ok} scans completed, ${totals.fail} failed, ${totals.events} change events`);
console.log("Events by type/severity:", Object.keys(byType).length ? JSON.stringify(byType) : "none");
await prisma.$disconnect();
