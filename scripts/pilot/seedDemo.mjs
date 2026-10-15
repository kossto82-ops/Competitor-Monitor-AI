// Creates (once) a small demo organization whose Today page has something on it: an urgent price change, an
// important plan change, a lone text change and a page that can only be partly verified. It is made through the
// same persistence code the pipeline uses, so what the page shows is what real scans would produce.
//   node scripts/pilot/seedDemo.mjs
// The login is generated on the first run and written to .local-infra/demo-credentials.txt (git-ignored); it is
// never printed. Local development only: never run it against anything but a local database.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to seed demo data into a database that is not local.");
const db = await import(pathToFileURL(join(root, "packages/db/dist/index.js")).href);
const bcrypt = createRequire(join(root, "apps/web/package.json"))("bcryptjs");
const { prisma } = db;

const EMAIL = "demo@demo-today.example.test";
if (await prisma.user.findFirst({ where: { email: EMAIL } })) {
  console.log("The demo organization already exists.");
  await prisma.$disconnect();
  process.exit(0);
}
const password = randomBytes(18).toString("base64url");
const { organization } = await db.createOrganizationWithOwner({ organizationName: "Demo - Today", email: EMAIL, passwordHash: await bcrypt.hash(password, 12) });
mkdirSync(join(root, ".local-infra"), { recursive: true });
writeFileSync(join(root, ".local-infra", "demo-credentials.txt"), `email: ${EMAIL}\npassword: ${password}\n`, { mode: 0o600 });

const plan = (key, label, value) => ({ type: "PRICE", key, label, value, currency: "EUR", raw: `${value} EUR` });
const event = (changeType, entityKey, oldValue, newValue, percentageChange, evidenceExcerpt, confidence = 0.9) => ({
  changeType, severity: "MEDIUM", confidence, entityKey, fieldPath: entityKey ?? "page.visibleText", oldValue, newValue, currency: entityKey ? "EUR" : null, percentageChange, evidenceExcerpt,
});
async function scan(competitorId, urlId, entities, state, events) {
  const job = await db.createRunningMonitoringJob(organization.id, urlId);
  await db.persistMonitoringResult(job.id, {
    organizationId: organization.id, monitoredUrlId: urlId, previousSnapshotId: null,
    extraction: { method: "CHEERIO", requestedUrl: "https://demo.test/", finalUrl: "https://demo.test/", httpStatus: 200, errorMessage: null, normalizedContent: "x", contentHash: "h", structuredDataHash: null, extractedEntities: entities, confidence: 1, warnings: [], durationMs: 1 },
    comparison: { verificationState: state, changeEvents: events },
    usage: { browserEscalated: false, aiCallMade: false },
  });
}
async function source(name, path) {
  const competitor = await db.createCompetitor(organization.id, { name, website: `https://${name.toLowerCase()}.example.test` });
  const url = await db.createMonitoredUrl(organization.id, competitor.id, { url: `https://${name.toLowerCase()}.example.test/${path}`, category: "PRICING_PAGE" });
  await prisma.monitoredUrl.update({ where: { id: url.id }, data: { lastSuccessfulScanAt: new Date(), lastAttemptAt: new Date() } });
  return { competitor, url };
}

const alpha = await source("Alpha", "pricing");
await db.setCompetitorRelevance(organization.id, alpha.competitor.id, 3);
await scan(alpha.competitor.id, alpha.url.id, [plan("plan:pro", "Pro (per month)", "49.00")], "NO_CHANGE", []);
await scan(alpha.competitor.id, alpha.url.id, [plan("plan:pro", "Pro (per month)", "72.00"), plan("plan:team", "Team (per month)", "129.00")], "CHANGED", [
  event("PRICE_CHANGE", "plan:pro", "49.00", "72.00", 46.94, "Pro (per month): 49.00 -> 72.00"),
  event("PRODUCT_ADDED", "plan:team", null, "129.00", null, "New plan detected: Team (per month) at 129.00 EUR"),
]);

const beta = await source("Beta", "tarifs");
await scan(beta.competitor.id, beta.url.id, [plan("plan:starter", "Starter (per month)", "20.00")], "NO_CHANGE", []);
await scan(beta.competitor.id, beta.url.id, [plan("plan:starter", "Starter (per month)", "24.00")], "CHANGED", [event("PRICE_CHANGE", "plan:starter", "20.00", "24.00", 20, "Starter (per month): 20.00 -> 24.00")]);

const gamma = await source("Gamma", "precios");
await scan(gamma.competitor.id, gamma.url.id, [plan("plan:basic", "Basic (per month)", "10.00")], "NO_CHANGE", []);
await scan(gamma.competitor.id, gamma.url.id, [plan("plan:basic", "Basic (per month)", "10.00")], "CHANGED", [
  event("CONTENT_CHANGE", null, null, null, null, 'Changed text: "…support hours [9-18 -> 9-19] on weekdays…"', 0.6),
]);

const delta = await source("Delta", "pricing");
await scan(delta.competitor.id, delta.url.id, [plan("plan:solo", "Solo (per month)", "15.00")], "NO_CHANGE", []);
for (let i = 0; i < 8; i += 1) await scan(delta.competitor.id, delta.url.id, [], "FAILED_TO_VERIFY", []);

console.log(`demo created: ${JSON.stringify(await db.raiseAlerts(organization.id))}; login saved to .local-infra/demo-credentials.txt`);
await prisma.$disconnect();
