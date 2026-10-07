// Creates (once) the organization the pricing pilot runs on, with the two competitor groups the customer
// chose, and registers every pricing page for an hourly scan. Idempotent: running it again adds nothing.
//   node scripts/pilot/seedPilot.mjs
// A login for the web UI is generated on the first run and written to .local-infra/pilot-credentials.txt
// (git-ignored); it is never printed.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = await import(pathToFileURL(join(root, "packages/db/dist/index.js")).href);
const requireFromWeb = createRequire(join(root, "apps/web/package.json"));
const bcrypt = requireFromWeb("bcryptjs");

const ORG_NAME = "Pricing pilot (8 sites)";
const OWNER_EMAIL = "pilot@pricing-pilot.example.test";
const SCAN_EVERY_MINUTES = 60;

const GROUPS = {
  "marketing tools": [
    ["ActiveCampaign", "https://www.activecampaign.com/pricing"],
    ["Klaviyo", "https://www.klaviyo.com/pricing"],
    ["Brevo", "https://www.brevo.com/pricing/"],
    ["Mailchimp", "https://mailchimp.com/pricing/marketing/"],
  ],
  "b2b saas (crm)": [
    ["Zoho CRM", "https://www.zoho.com/crm/zohocrm-pricing.html"],
    ["Freshworks CRM", "https://www.freshworks.com/crm/pricing/"],
    ["Pipedrive", "https://www.pipedrive.com/en/pricing"],
    ["HubSpot CRM", "https://www.hubspot.com/pricing/crm"],
  ],
};

const { prisma } = db;
let owner = await prisma.user.findFirst({ where: { email: OWNER_EMAIL } });
let organization;
if (owner) {
  organization = await db.getOrganizationById(owner.organizationId);
  console.log(`pilot organization already exists (${organization.id})`);
} else {
  const password = randomBytes(18).toString("base64url");
  const created = await db.createOrganizationWithOwner({ organizationName: ORG_NAME, email: OWNER_EMAIL, passwordHash: await bcrypt.hash(password, 12) });
  organization = created.organization;
  mkdirSync(join(root, ".local-infra"), { recursive: true });
  writeFileSync(join(root, ".local-infra", "pilot-credentials.txt"), `email: ${OWNER_EMAIL}\npassword: ${password}\n`, { mode: 0o600 });
  console.log(`pilot organization created (${organization.id}); login saved to .local-infra/pilot-credentials.txt`);
}

// Reproducible readings: pages are requested as an English (US) visitor; no email, nothing else to configure.
await db.updateOrganizationSettings(organization.id, { marketLocale: "en-US", dailyReportEnabled: false, timezone: "UTC" });

const existingCompetitors = await db.listCompetitorsWithSummaryForOrg(organization.id);
let added = 0;
for (const [group, sites] of Object.entries(GROUPS)) {
  for (const [name, url] of sites) {
    let competitor = existingCompetitors.find((c) => c.name === name);
    if (!competitor) competitor = await db.createCompetitor(organization.id, { name, website: new URL(url).origin, notes: `pilot group: ${group}` });
    const urls = await db.listMonitoredUrlsForOrg(organization.id, competitor.id);
    if (!urls.some((u) => u.url === url)) {
      const created = await db.createMonitoredUrl(organization.id, competitor.id, { url, label: `${name} pricing`, category: "PRICING_PAGE" });
      await db.updateMonitoredUrl(organization.id, created.id, { scanFrequencyMinutes: SCAN_EVERY_MINUTES });
      added += 1;
    }
  }
}
console.log(`registered ${added} new monitored URL(s); each is scanned every ${SCAN_EVERY_MINUTES} minutes`);
await prisma.$disconnect();
