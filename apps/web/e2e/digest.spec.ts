import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, signup } from "./helpers";

// Same subprocess-seeding approach as competitive-context.spec.ts / pattern-intelligence.spec.ts
// (Phase 7.1/8) - see seedPatternEvents.mjs's header comment for why seeding runs as a genuinely
// separate `node` process. Qualifying getActivityPattern requires 90+ days of real monitoring
// history, which no amount of real-time scanning inside a test timeout can produce.
const SEED_SCRIPT = path.resolve(process.cwd(), "e2e/seedPatternEvents.mjs");

/**
 * Phase 10 (PHASE10-VALIDATION-REPORT.md): focused Playwright coverage for
 * the deterministic Digest (/digest) - each test exercises real
 * application code (getDigestForOrganization in
 * packages/db/src/repositories/intelligence.ts, which composes
 * getActivityPattern / getRepeatedPriceChangePatterns verbatim) against a
 * REAL Postgres database through a REAL browser session. Signup,
 * competitor/URL creation, authentication, and every assertion below
 * exercise the real UI/database path; only historical ChangeEvent
 * seeding runs via seedPatternEvents.mjs.
 */
interface SeedEvent {
  changeType?: "PRICE_CHANGE" | "PRODUCT_ADDED" | "PRODUCT_REMOVED";
  entityKey?: string;
  detectedAtDaysAgo: number;
}

function seedPatternEvents(competitorId: string, events: SeedEvent[], backdateCreatedAtDays?: number): void {
  const payload = JSON.stringify({ competitorId, backdateCreatedAtDays, events });
  const output = execFileSync("node", [SEED_SCRIPT, payload], { encoding: "utf-8" });
  const result = JSON.parse(output) as { ok: boolean; error?: string };
  if (!result.ok) {
    throw new Error(`seedPatternEvents.mjs failed: ${result.error}`);
  }
}

/** Signs up, creates a competitor with one monitored URL, and returns its real id - same helper shape as competitive-context.spec.ts. */
async function setUpCompetitorInOrg(page: import("@playwright/test").Page, competitorName: string, siteKey: string): Promise<string> {
  await addCompetitor(page, competitorName);
  await openCompetitor(page, competitorName);
  await addMonitoredUrl(page, siteKey);
  return page.url().split("/competitors/")[1]!.split("?")[0]!;
}

test.describe("Deterministic Digest (Phase 10)", () => {
  test("1 - empty state: a brand-new organization with zero competitors sees the onboarding explainer, never an empty digest implying no changes exist anywhere", async ({ page }) => {
    const org = makeTestOrg("DigestEmptyOrg");
    await signup(page, org);

    await page.goto("/digest");
    await expect(page.getByRole("heading", { name: "Digest" })).toBeVisible();
    await expect(page.getByText("Monitor your competitors")).toBeVisible();
    await expect(page.getByTestId("digest-feed")).toHaveCount(0);
  });

  test("2 - recent changes: raw verified ChangeEvents appear as digest items for a freshly-tracked competitor with no qualifying pattern yet", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestRawChanges");
    await signup(page, org);

    const competitorName = `Digest Fresh Co ${suffix}`;
    const id = await setUpCompetitorInOrg(page, competitorName, `digest-fresh-${suffix}`);
    seedPatternEvents(id, [{ detectedAtDaysAgo: 1, entityKey: "pro-plan" }, { detectedAtDaysAgo: 3, changeType: "PRICE_CHANGE", entityKey: "basic-plan" }]);

    await page.goto("/digest?days=30");

    await expect(page.getByTestId("digest-feed")).toBeVisible();
    // Two raw ChangeEvents seeded, both PRICE_CHANGE - exactly two CHANGE_EVENT items, no LIFECYCLE
    // roll-up (no PRODUCT_ADDED/PRODUCT_REMOVED in this window) and no pattern item.
    const changeItems = page.locator('[data-testid="digest-item"][data-digest-kind="CHANGE_EVENT"]');
    await expect(changeItems).toHaveCount(2);
    await expect(page.getByTestId("digest-feed")).toContainText(competitorName);
    // No pattern item yet - the competitor was created today (INSUFFICIENT_HISTORY).
    await expect(page.locator('[data-testid="digest-item"][data-digest-kind="ACTIVITY_PATTERN"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="digest-item"][data-digest-kind="LIFECYCLE"]')).toHaveCount(0);
  });

  test("3 - qualifying activity pattern: appears with the same badge vocabulary as /compare, and its evidence link navigates to a real ChangeEvent", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestQualifyingPattern");
    await signup(page, org);

    const competitorName = `Digest Established Co ${suffix}`;
    const id = await setUpCompetitorInOrg(page, competitorName, `digest-established-${suffix}`);

    // Baseline 1/window (3 historical windows), current 4 -> ratio 4.0 >= 1.5 -> ABOVE_BASELINE.
    seedPatternEvents(
      id,
      [
        { entityKey: "b-45", detectedAtDaysAgo: 45 },
        { entityKey: "b-75", detectedAtDaysAgo: 75 },
        { entityKey: "b-105", detectedAtDaysAgo: 105 },
        { entityKey: "c-1", detectedAtDaysAgo: 1 },
        { entityKey: "c-5", detectedAtDaysAgo: 5 },
        { entityKey: "c-10", detectedAtDaysAgo: 10 },
        { entityKey: "c-20", detectedAtDaysAgo: 20 },
      ],
      150,
    );

    await page.goto("/digest?days=30");

    const patternItem = page.locator('[data-testid="digest-item"][data-digest-kind="ACTIVITY_PATTERN"]');
    await expect(patternItem).toHaveCount(1);
    await expect(patternItem.getByTestId("digest-pattern-badge")).toHaveText("Above recent baseline");

    await patternItem.getByTestId("digest-evidence-link").click();
    await expect(page).toHaveURL(/\/changes\//);
    await expect(page.getByText("This is evidence, not an inference")).toBeVisible();
  });

  test("4 - repeated price-change pattern: appears only for the qualifying entity (>= 2 price changes) and links to real evidence", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestRepeatedPrice");
    await signup(page, org);

    const competitorName = `Digest Repeat Co ${suffix}`;
    const id = await setUpCompetitorInOrg(page, competitorName, `digest-repeat-${suffix}`);
    seedPatternEvents(id, [
      { changeType: "PRICE_CHANGE", entityKey: "pro-plan", detectedAtDaysAgo: 10 },
      { changeType: "PRICE_CHANGE", entityKey: "pro-plan", detectedAtDaysAgo: 2 },
      { changeType: "PRICE_CHANGE", entityKey: "basic-plan", detectedAtDaysAgo: 5 },
    ]);

    await page.goto("/digest?days=30");

    const repeatedItem = page.locator('[data-testid="digest-item"][data-digest-kind="REPEATED_PRICE_CHANGE"]');
    await expect(repeatedItem).toHaveCount(1);
    await expect(repeatedItem).toContainText("2 times");

    await repeatedItem.getByTestId("digest-evidence-link").click();
    await expect(page).toHaveURL(/\/changes\//);
    await expect(page.getByText("This is evidence, not an inference")).toBeVisible();
  });

  test("5 - cross-competitor context: 'N of M tracked competitors above baseline' reflects only qualifying, currently-above-baseline competitors", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestCrossCompetitor");
    await signup(page, org);

    const aboveId = await setUpCompetitorInOrg(page, `Digest Above Co ${suffix}`, `digest-cc-above-${suffix}`);
    await setUpCompetitorInOrg(page, `Digest Fresh Co ${suffix}`, `digest-cc-fresh-${suffix}`);

    seedPatternEvents(
      aboveId,
      [
        { entityKey: "b1", detectedAtDaysAgo: 45 },
        { entityKey: "b2", detectedAtDaysAgo: 75 },
        { entityKey: "b3", detectedAtDaysAgo: 105 },
        { entityKey: "c1", detectedAtDaysAgo: 1 },
        { entityKey: "c2", detectedAtDaysAgo: 5 },
        { entityKey: "c3", detectedAtDaysAgo: 10 },
        { entityKey: "c4", detectedAtDaysAgo: 20 },
      ],
      150,
    );

    await page.goto("/digest?days=30");
    await expect(page.getByTestId("digest-cross-competitor-context")).toContainText("1 of 2");
  });

  test("6 - tenant isolation: organization B never sees organization A's digest items, competitors, or evidence", async ({ browser }) => {
    const suffix = Date.now();
    const orgA = makeTestOrg("DigestIsoA");
    const orgB = makeTestOrg("DigestIsoB");

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signup(pageA, orgA);
    const competitorAName = `Digest Iso Competitor ${suffix}`;
    const competitorAId = await setUpCompetitorInOrg(pageA, competitorAName, `digest-iso-${suffix}`);
    seedPatternEvents(
      competitorAId,
      [
        { entityKey: "iso1", detectedAtDaysAgo: 45 },
        { entityKey: "iso2", detectedAtDaysAgo: 75 },
        { entityKey: "iso3", detectedAtDaysAgo: 105 },
        { entityKey: "isoc1", detectedAtDaysAgo: 1 },
        { entityKey: "isoc2", detectedAtDaysAgo: 5 },
        { entityKey: "isoc3", detectedAtDaysAgo: 10 },
        { entityKey: "isoc4", detectedAtDaysAgo: 20 },
      ],
      150,
    );

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signup(pageB, orgB);

    // Org B has zero competitors of its own - must see the onboarding explainer, never Org A's data.
    await pageB.goto("/digest");
    await expect(pageB.getByText("Monitor your competitors")).toBeVisible();
    const bodyText = await pageB.textContent("body");
    expect(bodyText).not.toContain(competitorAName);
    expect(bodyText).not.toContain("Above recent baseline");

    await contextA.close();
    await contextB.close();
  });

  test("7 - mobile: the digest feed introduces no new document-level horizontal overflow at 375px", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestMobile");
    await signup(page, org);

    const id = await setUpCompetitorInOrg(page, `Digest Mobile Co ${suffix}`, `digest-mobile-${suffix}`);
    seedPatternEvents(
      id,
      [
        { entityKey: "m1", detectedAtDaysAgo: 45 },
        { entityKey: "m2", detectedAtDaysAgo: 75 },
        { entityKey: "m3", detectedAtDaysAgo: 105 },
        { entityKey: "a-really-quite-long-entity-name-for-wrapping-stress-test", changeType: "PRICE_CHANGE", detectedAtDaysAgo: 1 },
        { entityKey: "a-really-quite-long-entity-name-for-wrapping-stress-test", changeType: "PRICE_CHANGE", detectedAtDaysAgo: 5 },
      ],
      150,
    );

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/digest?days=30");
    await expect(page.getByTestId("digest-feed")).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
