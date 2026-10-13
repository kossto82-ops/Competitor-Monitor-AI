// Proves that a REAL price change on a REAL page layout is detected, without waiting for a competitor to
// reprice. For each of the pilot's pages it downloads the live HTML once (like the pilot does), then runs the
// real pipeline (extractor -> comparison -> database) three times in a throwaway organization:
//   scan 1: the page as it is            -> baseline
//   scan 2: one plan's price raised 20%  -> must produce a PRICE_CHANGE naming that plan
//   scan 3: the page as it is again      -> must produce the PRICE_CHANGE back
// Nothing touches the pilot's own organization; the throwaway organization is deleted at the end.
//   node scripts/pilot/simulateChange.mjs [name-fragment ...]      e.g.  node scripts/pilot/simulateChange.mjs freshworks brevo
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const cheerio = createRequire(import.meta.url)("cheerio");
const load = (p) => import(pathToFileURL(join(root, p)).href);
const db = await load("packages/db/dist/index.js");
const { CheerioExtractor, defaultFetch, createRobotsCheckerFromEnv } = await load("packages/extraction/dist/index.js");
const { runMonitoringJob, createDefaultPipelineDeps } = await load("apps/worker/dist/pipeline.js");
const { prisma } = db;

const PAGES = [
  ["Freshworks CRM", "https://www.freshworks.com/crm/pricing/"],
  ["Brevo", "https://www.brevo.com/pricing/"],
  ["Mailchimp", "https://mailchimp.com/pricing/marketing/"],
  ["Zoho CRM", "https://www.zoho.com/crm/zohocrm-pricing.html"],
];
const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
const pages = PAGES.filter(([name]) => wanted.length === 0 || wanted.some((w) => name.toLowerCase().includes(w)));

const runId = Date.now();
const { organization } = await db.createOrganizationWithOwner({
  organizationName: `Simulation ${runId}`,
  email: `simulation-${runId}@example.test`,
  passwordHash: "not-a-real-hash",
});

const num = (v) => Number(String(v).replace(/,/g, ""));
const numberForms = (value) => {
  const n = Number(value);
  const fixed = n.toFixed(2);
  return [...new Set([String(n), fixed, n.toLocaleString("en-US"), Number(fixed).toLocaleString("en-US", { minimumFractionDigits: 2 })])];
};

/** `form` as a number of its own: not part of 15,001-20,000, 2026 or 20.5. */
const standalone = (form) => new RegExp(String.raw`(?<![\d.,])` + form.replace(/[.]/g, String.raw`\.`) + String.raw`(?![\d]|[.,]\d)`);

/** Every way of writing `value` that this page might use in its HTML, as ready-made modified pages. */
function* variants(html, value, newValue) {
  // 1. machine-readable prices inside <script> JSON ("price":"9" or "price":9)
  for (const form of numberForms(value)) {
    const re = new RegExp(String.raw`"(price|lowPrice|highPrice)"\s*:\s*"?` + form.replace(/[.]/g, String.raw`\.`) + String.raw`"?(?=[,}\s])`, "g");
    for (const m of html.matchAll(re)) {
      const replacement = m[0].replace(form, String(newValue));
      yield html.slice(0, m.index) + replacement + html.slice(m.index + m[0].length);
    }
    // an offer often repeats its price in a nested specification: change every copy at once as well
    if (html.search(re) >= 0) yield html.replace(re, (m) => m.replace(form, String(newValue)));
  }
  // 2. visible price text (the number is often a text node of its own, next to a currency sign)
  const $ = cheerio.load(html);
  const nodes = [];
  $("body *").contents().each((_, node) => {
    if (node.type !== "text") return;
    const text = node.data ?? "";
    if (numberForms(value).some((form) => standalone(form).test(text))) nodes.push(node);
  });
  // short text nodes first: a price sits in a node of its own, a "15,001-20,000" option list does not
  nodes.sort((a, b) => (a.data ?? "").trim().length - (b.data ?? "").trim().length);
  for (const node of nodes.slice(0, 80)) {
    const original = node.data;
    for (const form of numberForms(value)) {
      const re = standalone(form);
      if (re.test(original)) { node.data = original.replace(re, (m) => m.replace(form, String(newValue))); break; }
    }
    yield $.html();
    node.data = original;
  }
}

/** The first plan price whose change shows up in the extracted data as exactly that one plan changing. */
async function findAlteration(html, entities, extractHtml) {
  const targets = entities.filter((e) => e.type === "PRICE" && /^(plan|jsonld):/.test(e.key) && num(e.value) > 0);
  for (const target of targets) {
    const newValue = Math.round(num(target.value) * 1.2);
    if (newValue === Math.round(num(target.value))) continue;
    let tried = 0;
    for (const modified of variants(html, target.value, newValue)) {
      if (++tried > 60) break;
      const after = await extractHtml(modified);
      if (process.env.SIM_DEBUG && tried <= 2) console.log(`  [debug] ${target.key}=${target.value}->${newValue} variant ${tried}: ${after.extractedEntities.filter((e) => e.type === 'PRICE' && num(e.value) !== num((entities.find((b) => b.key === e.key) ?? e).value)).map((e) => e.key + '=' + e.value).join(', ') || 'no change'}`);
      const changed = after.extractedEntities.filter((e) => e.type === "PRICE" && num(e.value) !== num((entities.find((b) => b.key === e.key) ?? e).value));
      if (changed.length === 1 && changed[0].key === target.key && num(changed[0].value) === newValue) {
        return { html: modified, key: target.key, from: target.value, to: String(newValue) };
      }
    }
  }
  return null;
}

const results = [];
try {
  for (const [name, url] of pages) {
    const row = { name, outcome: "", detail: "" };
    results.push(row);
    try {
      const live = await new CheerioExtractor(defaultFetch, createRobotsCheckerFromEnv()).extract({ url });
      if (live.errorMessage) { row.outcome = "SKIPPED"; row.detail = `live page not readable: ${live.errorMessage.slice(0, 80)}`; continue; }
      const page = await defaultFetch(url, {});
      const extractHtml = (html) => new CheerioExtractor(async () => ({ status: 200, finalUrl: url, body: html })).extract({ url });
      // the baseline entities must come from the very HTML that gets altered (a page can differ between two downloads)
      const baseline = await extractHtml(page.body);
      const changed = await findAlteration(page.body, baseline.extractedEntities, extractHtml);
      if (!changed) { row.outcome = "SKIPPED"; row.detail = `no plan price could be altered in isolation (${live.extractedEntities.filter((e) => e.type === "PRICE").length} price entities)`; continue; }

      const competitor = await db.createCompetitor(organization.id, { name });
      const monitored = await db.createMonitoredUrl(organization.id, competitor.id, { url, category: "PRICING_PAGE" });
      let body = page.body;
      const deps = { ...createDefaultPipelineDeps(), extractor: new CheerioExtractor(async () => ({ status: 200, finalUrl: url, body })) };
      const scan = async (html) => { body = html; return runMonitoringJob({ organizationId: organization.id, monitoredUrlId: monitored.id }, deps); };

      const s1 = await scan(page.body);
      const s2 = await scan(changed.html);
      const s3 = await scan(page.body);
      const events = await prisma.changeEvent.findMany({ where: { monitoredUrlId: monitored.id }, orderBy: { detectedAt: "asc" } });
      const price = events.filter((e) => e.changeType === "PRICE_CHANGE");
      const other = events.filter((e) => e.changeType !== "PRICE_CHANGE").map((e) => e.changeType);
      const up = price.find((e) => e.entityKey === changed.key && Number(e.newValue) > Number(e.oldValue));
      const back = price.find((e) => e.entityKey === changed.key && Number(e.newValue) < Number(e.oldValue));
      row.outcome = up && back ? "DETECTED" : "MISSED";
      row.detail = `${changed.key}: ${changed.from} -> ${changed.to}; states ${s1.verificationState}/${s2.verificationState}/${s3.verificationState}; ` +
        `up=${up ? `${up.oldValue}->${up.newValue} ${up.percentageChange}% ${up.severity}` : "none"}; back=${back ? "yes" : "none"}; ` +
        `other events: ${other.length ? other.join(",") : "none"}`;
    } catch (error) {
      row.outcome = "ERROR";
      row.detail = String(error?.message ?? error).slice(0, 200);
    }
  }
} finally {
  await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined);
  await prisma.$disconnect();
}
for (const r of results) console.log(`${r.outcome.padEnd(9)} ${r.name.padEnd(15)} ${r.detail}`);
