import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, signup } from "./helpers";

// Same subprocess-seeding approach as pattern-intelligence.spec.ts (Phase 7.1) - see that file's
// header comment for why seeding runs as a genuinely separate `node` process rather than an
// in-process import. Qualifying getActivityPattern requires 90+ days of real monitoring history,
// which no amount of real-time scanning inside a test timeout can produce.
const SEED_SCRIPT = path.resolve(process.cwd(), "e2e/seedPatternEvents.mjs");

/**
 * Phase 8 (PHASE8-DESIGN.md): focused Playwright coverage for the
 * Competitive Context extension to `/compare` - each test exercises real
 * application code (getCompetitiveContext in
 * packages/db/src/repositories/intelligence.ts, which reuses
 * getActivityPattern/getRepeatedPriceChangePatterns from patterns.ts
 * verbatim) against a REAL Postgres database through a REAL browser
 * session. Signup, competitor/URL creation, authentication, and every
 * assertion below exercise the real UI/database path; only historical
 * ChangeEvent seeding runs via seedPatternEvents.mjs.
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

/** Signs up, creates a competitor with one monitored URL, and returns its real id - same helper shape as pattern-intelligence.spec.ts. */
async function setUpCompetitorInOrg(page: import("@playwright/test").Page, competitorName: string, siteKey: string): Promise<string> {
  await addCompetitor(page, competitorName);
  await openCompetitor(page, competitorName);
  await addMonitoredUrl(page, siteKey);
  return page.url().split("/competitors/")[1]!.split("?")[0]!;
}

test.describe("Competitive Context (Phase 8)", () => {
  test("1 - multiple competitors: the compare table renders one row per selected competitor via the real checkbox form, and preserves the caller's requested order (no ranking/reordering) on direct navigation", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("CtxMulti");
    await signup(page, org);

    const idA = await setUpCompetitorInOrg(page, `Multi A ${suffix}`, `ctx-multi-a-${suffix}`);
    const idB = await setUpCompetitorInOrg(page, `Multi B ${suffix}`, `ctx-multi-b-${suffix}`);
    const idC = await setUpCompetitorInOrg(page, `Multi C ${suffix}`, `ctx-multi-c-${suffix}`);

    seedPatternEvents(idA, [{ detectedAtDaysAgo: 3 }]);
    seedPatternEvents(idB, [{ detectedAtDaysAgo: 5 }]);
    seedPatternEvents(idC, [{ detectedAtDaysAgo: 1 }]);

    // Real checkbox form interaction, not a deep link - proves the actual UI wiring works. The
    // browser submits checked checkboxes in DOM order (listCompetitorsForOrg orders by
    // createdAt desc, i.e. C, B, A here), not click order - so this only asserts presence/count,
    // not a specific order; order preservation itself is asserted below via direct navigation.
    await page.goto("/compare");
    await page.getByRole("checkbox").and(page.locator(`[value="${idA}"]`)).check();
    await page.getByRole("checkbox").and(page.locator(`[value="${idB}"]`)).check();
    await page.getByRole("checkbox").and(page.locator(`[value="${idC}"]`)).check();
    await page.getByRole("button", { name: "Compare" }).click();

    await expect(page.getByTestId("compare-table")).toBeVisible();
    const formRows = page.getByTestId("compare-row");
    await expect(formRows).toHaveCount(3);
    await expect(page.getByTestId("compare-table")).toContainText(`Multi A ${suffix}`);
    await expect(page.getByTestId("compare-table")).toContainText(`Multi B ${suffix}`);
    await expect(page.getByTestId("compare-table")).toContainText(`Multi C ${suffix}`);

    // Order matches the requested query-string order exactly (C, A, B - deliberately not
    // creation order and not alphabetical) - compareCompetitors' own convention (Phase 6),
    // reused verbatim by getCompetitiveContext: no ranking/reordering imposed anywhere.
    await page.goto(`/compare?competitorIds=${idC}&competitorIds=${idA}&competitorIds=${idB}&days=30`);
    const orderedRows = page.getByTestId("compare-row");
    await expect(orderedRows).toHaveCount(3);
    await expect(orderedRows.nth(0)).toContainText(`Multi C ${suffix}`);
    await expect(orderedRows.nth(1)).toContainText(`Multi A ${suffix}`);
    await expect(orderedRows.nth(2)).toContainText(`Multi B ${suffix}`);
  });

  test("2 - different history ages: a freshly-tracked competitor shows explicit insufficient-history, never hidden or silently zeroed", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("CtxHistoryAges");
    await signup(page, org);

    const freshId = await setUpCompetitorInOrg(page, `Fresh Co ${suffix}`, `ctx-fresh-${suffix}`);
    const establishedId = await setUpCompetitorInOrg(page, `Established Co ${suffix}`, `ctx-established-${suffix}`);

    // Fresh: default createdAt (today) - can never qualify regardless of event count.
    seedPatternEvents(freshId, [{ detectedAtDaysAgo: 5 }, { detectedAtDaysAgo: 2 }]);

    // Established: backdated past the 90-day minimum, baseline 1/window, current 4 -> qualifies, ABOVE_BASELINE.
    seedPatternEvents(
      establishedId,
      [
        { entityKey: "e-45", detectedAtDaysAgo: 45 },
        { entityKey: "e-75", detectedAtDaysAgo: 75 },
        { entityKey: "e-105", detectedAtDaysAgo: 105 },
        { entityKey: "e-1", detectedAtDaysAgo: 1 },
        { entityKey: "e-5", detectedAtDaysAgo: 5 },
        { entityKey: "e-10", detectedAtDaysAgo: 10 },
        { entityKey: "e-20", detectedAtDaysAgo: 20 },
      ],
      150,
    );

    await page.goto(`/compare?competitorIds=${freshId}&competitorIds=${establishedId}&days=30`);

    const rows = page.getByTestId("compare-row");
    await expect(rows).toHaveCount(2);

    const freshRow = rows.filter({ hasText: `Fresh Co ${suffix}` });
    const establishedRow = rows.filter({ hasText: `Established Co ${suffix}` });

    // Insufficient history: badge present, but NO detail line (never a fabricated claim over thin data).
    await expect(freshRow.getByTestId("compare-pattern-badge")).toHaveText("Not enough history yet");
    await expect(freshRow.getByTestId("compare-pattern-detail")).toHaveCount(0);

    // Sufficient + qualifying: badge AND detail line both present, still visible in the SAME table.
    await expect(establishedRow.getByTestId("compare-pattern-badge")).toHaveText("Above recent baseline");
    await expect(establishedRow.getByTestId("compare-pattern-detail")).toBeVisible();
  });

  test("3 - different baseline states: ABOVE/AT/BELOW/insufficient render with the exact badge text for deterministically seeded data", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("CtxStates");
    await signup(page, org);

    const insufficientId = await setUpCompetitorInOrg(page, `State Insufficient ${suffix}`, `ctx-state-insuff-${suffix}`);
    const aboveId = await setUpCompetitorInOrg(page, `State Above ${suffix}`, `ctx-state-above-${suffix}`);
    const atId = await setUpCompetitorInOrg(page, `State At ${suffix}`, `ctx-state-at-${suffix}`);
    const belowId = await setUpCompetitorInOrg(page, `State Below ${suffix}`, `ctx-state-below-${suffix}`);

    seedPatternEvents(insufficientId, [{ detectedAtDaysAgo: 2 }]);

    // Above: baseline 1/window (3 windows), current 4 -> ratio 4.0 >= 1.5
    seedPatternEvents(
      aboveId,
      [
        { entityKey: "a1", detectedAtDaysAgo: 45 },
        { entityKey: "a2", detectedAtDaysAgo: 75 },
        { entityKey: "a3", detectedAtDaysAgo: 105 },
        { entityKey: "ac1", detectedAtDaysAgo: 1 },
        { entityKey: "ac2", detectedAtDaysAgo: 5 },
        { entityKey: "ac3", detectedAtDaysAgo: 10 },
        { entityKey: "ac4", detectedAtDaysAgo: 20 },
      ],
      150,
    );

    // At: baseline 2/window, current 2 -> ratio 1.0
    seedPatternEvents(
      atId,
      [
        { entityKey: "t1", detectedAtDaysAgo: 40 },
        { entityKey: "t2", detectedAtDaysAgo: 50 },
        { entityKey: "t3", detectedAtDaysAgo: 70 },
        { entityKey: "t4", detectedAtDaysAgo: 80 },
        { entityKey: "t5", detectedAtDaysAgo: 100 },
        { entityKey: "t6", detectedAtDaysAgo: 110 },
        { entityKey: "tc1", detectedAtDaysAgo: 3 },
        { entityKey: "tc2", detectedAtDaysAgo: 10 },
      ],
      150,
    );

    // Below: baseline 4/window, current 0
    seedPatternEvents(
      belowId,
      [
        { entityKey: "b1", detectedAtDaysAgo: 32 },
        { entityKey: "b2", detectedAtDaysAgo: 35 },
        { entityKey: "b3", detectedAtDaysAgo: 38 },
        { entityKey: "b4", detectedAtDaysAgo: 41 },
        { entityKey: "b5", detectedAtDaysAgo: 62 },
        { entityKey: "b6", detectedAtDaysAgo: 65 },
        { entityKey: "b7", detectedAtDaysAgo: 68 },
        { entityKey: "b8", detectedAtDaysAgo: 71 },
        { entityKey: "b9", detectedAtDaysAgo: 92 },
        { entityKey: "b10", detectedAtDaysAgo: 95 },
        { entityKey: "b11", detectedAtDaysAgo: 98 },
        { entityKey: "b12", detectedAtDaysAgo: 101 },
      ],
      150,
    );

    await page.goto(
      `/compare?competitorIds=${insufficientId}&competitorIds=${aboveId}&competitorIds=${atId}&competitorIds=${belowId}&days=30`,
    );

    const rows = page.getByTestId("compare-row");
    await expect(rows).toHaveCount(4);

    await expect(rows.filter({ hasText: `State Insufficient ${suffix}` }).getByTestId("compare-pattern-badge")).toHaveText("Not enough history yet");
    await expect(rows.filter({ hasText: `State Above ${suffix}` }).getByTestId("compare-pattern-badge")).toHaveText("Above recent baseline");
    await expect(rows.filter({ hasText: `State At ${suffix}` }).getByTestId("compare-pattern-badge")).toHaveText("In line with recent baseline");
    await expect(rows.filter({ hasText: `State Below ${suffix}` }).getByTestId("compare-pattern-badge")).toHaveText("Below recent baseline");
  });

  test("4 - evidence: the most-recent-change link navigates from an aggregate context metric to its underlying ChangeEvent evidence page", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("CtxEvidence");
    await signup(page, org);

    const id = await setUpCompetitorInOrg(page, `Evidence Co ${suffix}`, `ctx-evidence-${suffix}`);
    seedPatternEvents(id, [{ detectedAtDaysAgo: 10 }, { detectedAtDaysAgo: 1, entityKey: "latest-plan" }]);

    await page.goto(`/compare?competitorIds=${id}&days=30`);

    const link = page.getByTestId("compare-latest-change-link");
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/changes\//);
    // The evidence page (Phase 3/5) - same assertion evidence.spec.ts already uses for this heading.
    await expect(page.getByText("This is evidence, not an inference")).toBeVisible();
  });

  test("5 - tenant isolation: organization B cannot see organization A's competitive context, even when requesting A's competitorId directly", async ({ browser }) => {
    const suffix = Date.now();
    const orgA = makeTestOrg("CtxIsoA");
    const orgB = makeTestOrg("CtxIsoB");

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signup(pageA, orgA);
    const competitorAName = `Iso Ctx Competitor ${suffix}`;
    const competitorAId = await setUpCompetitorInOrg(pageA, competitorAName, `ctx-iso-${suffix}`);
    // Heavy above-baseline activity in Org A - must never surface for Org B.
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

    // Org B's own competitor picker must never list Org A's competitor.
    await pageB.goto("/compare");
    await expect(pageB.getByText(competitorAName)).toHaveCount(0);

    // Direct navigation with Org A's competitorId, from Org B's own authenticated session.
    await pageB.goto(`/compare?competitorIds=${competitorAId}&days=30`);
    await expect(pageB.getByTestId("compare-row")).toHaveCount(0);
    await expect(pageB.getByText("Nothing to compare")).toBeVisible();
    const bodyText = await pageB.textContent("body");
    expect(bodyText).not.toContain(competitorAName);

    await contextA.close();
    await contextB.close();
  });

  test("6 - mobile: the compare table introduces no new document-level horizontal overflow at 375px", async ({ page }) => {
    const suffix = Date.now();
    const org = makeTestOrg("CtxMobile");
    await signup(page, org);

    const id = await setUpCompetitorInOrg(page, `Mobile Co ${suffix}`, `ctx-mobile-${suffix}`);
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
    await page.goto(`/compare?competitorIds=${id}&days=30`);
    await expect(page.getByTestId("compare-row")).toHaveCount(1);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
