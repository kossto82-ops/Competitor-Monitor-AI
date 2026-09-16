import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, signup } from "./helpers";

// Playwright's config sets `testDir: "./e2e"` and is always run from `apps/web` per
// DevRunbook.md - `import.meta.url` is unavailable under Playwright's CJS-based TS transform on
// this machine, so resolve relative to the process cwd instead.
const SEED_SCRIPT = path.resolve(process.cwd(), "e2e/seedPatternEvents.mjs");

/**
 * Phase 7.1 (Section 19): focused Playwright coverage for the Pattern
 * Intelligence UI (PatternsCard) added in Phase 7 - the gap flagged in
 * PHASE7-VALIDATION.md's Known Gaps. Each test exercises real application
 * code (getActivityPattern / getRepeatedPriceChangePatterns in
 * packages/db/src/repositories/patterns.ts) against a REAL Postgres
 * database through a REAL browser session; historical ChangeEvent
 * seeding runs via `seedPatternEvents.mjs` as a genuinely separate `node`
 * process (see that file's header comment for why - importing
 * packages/db directly inside a Playwright spec throws a duplicate-
 * module-instance error specific to this machine's loader), because
 * qualifying the activity-vs-baseline pattern genuinely requires 90+
 * days of monitoring history (see PHASE7.1-VALIDATION-REPORT.md, "Window
 * Semantics") - no amount of real-time scanning inside a test timeout
 * can produce that. Signup, competitor/URL creation, authentication, and
 * every assertion below still exercise the real UI/API/database path.
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

/** Signs up, creates a competitor with one monitored URL, and returns its real id. */
async function setUpCompetitor(page: import("@playwright/test").Page, orgLabel: string, siteKey: string): Promise<string> {
  const org = makeTestOrg(orgLabel);
  const competitorName = `${orgLabel} Co ${Date.now()}`;

  await signup(page, org);
  await addCompetitor(page, competitorName);
  await openCompetitor(page, competitorName);
  await addMonitoredUrl(page, siteKey);

  return page.url().split("/competitors/")[1]!.split("?")[0]!;
}

test.describe("Pattern Intelligence (Phase 7.1)", () => {
  test("A - insufficient history: a freshly-tracked competitor shows the insufficient-history state, never a false trend claim", async ({ page }) => {
    const suffix = Date.now();
    const competitorId = await setUpCompetitor(page, "PatternInsufficient", `pattern-insufficient-${suffix}`);

    // A handful of recent events - not enough ELAPSED TRACKED TIME (competitor was JUST
    // created, default createdAt) for even one qualifying historical window, regardless of
    // how many current-window events exist.
    seedPatternEvents(competitorId, [{ detectedAtDaysAgo: 5 }, { detectedAtDaysAgo: 2 }]);

    await page.goto(`/competitors/${competitorId}?days=30`);

    await expect(page.getByTestId("activity-pattern-insufficient-history")).toBeVisible();
    await expect(page.getByTestId("activity-pattern-badge")).toHaveText("Not enough history yet");
    // The claim-bearing detail line must NOT be rendered when insufficient.
    await expect(page.getByTestId("activity-pattern-detail")).toHaveCount(0);
  });

  test("B - sufficient history, pattern does not qualify: activity in line with baseline, and a single price change is not yet a repeated pattern", async ({ page }) => {
    const suffix = Date.now();
    const competitorId = await setUpCompetitor(page, "PatternNoQualify", `pattern-no-qualify-${suffix}`);

    // Backdate well past the 90-day minimum so the pattern CAN evaluate. Current window: 2 events
    // (steady-10 + the lone price change below). Each of the 3 historical windows also gets 2
    // events, so baselineAverage = 2 and ratio = 2/2 = 1.0 -> AT_BASELINE (current window activity
    // is exactly in line with its own history, not a notable deviation). The lone-plan price
    // change is the only PRICE_CHANGE for its entity in the window - must NOT be treated as a
    // repeated pattern (that requires >=2 for the SAME entityKey).
    seedPatternEvents(
      competitorId,
      [
        { entityKey: "steady-10", detectedAtDaysAgo: 10 },
        { entityKey: "lone-plan", changeType: "PRICE_CHANGE", detectedAtDaysAgo: 3 },
        { entityKey: "h1-a", detectedAtDaysAgo: 40 },
        { entityKey: "h1-b", detectedAtDaysAgo: 50 },
        { entityKey: "h2-a", detectedAtDaysAgo: 70 },
        { entityKey: "h2-b", detectedAtDaysAgo: 80 },
        { entityKey: "h3-a", detectedAtDaysAgo: 100 },
        { entityKey: "h3-b", detectedAtDaysAgo: 110 },
      ],
      150,
    );

    await page.goto(`/competitors/${competitorId}?days=30`);

    await expect(page.getByTestId("activity-pattern-badge")).toHaveText("In line with recent baseline");
    await expect(page.getByTestId("activity-pattern-detail")).toBeVisible(); // sufficient history: the claim-bearing line IS rendered
    await expect(page.getByTestId("activity-pattern-insufficient-history")).toHaveCount(0); // distinct from state A

    await expect(page.getByTestId("repeated-price-pattern-empty")).toBeVisible();
    await expect(page.getByTestId("repeated-price-pattern-item")).toHaveCount(0);
  });

  test("C - pattern qualifies: above-baseline activity and repeated price changes render with numbers matching the seeded arithmetic exactly", async ({ page }) => {
    const suffix = Date.now();
    const competitorId = await setUpCompetitor(page, "PatternQualifies", `pattern-qualifies-${suffix}`);

    // Baseline: 1 event in each of the 3 historical 30-day windows -> baselineAverage = 1.
    // Current window: 4 events (ratio 4x >= 1.5 threshold -> ABOVE_BASELINE), as two pairs of
    // same-entity price changes (both qualifying repeated-price-change patterns).
    seedPatternEvents(
      competitorId,
      [
        { entityKey: "baseline-plan", detectedAtDaysAgo: 45 },
        { entityKey: "baseline-plan", detectedAtDaysAgo: 75 },
        { entityKey: "baseline-plan", detectedAtDaysAgo: 105 },
        { entityKey: "pro-plan", detectedAtDaysAgo: 20 },
        { entityKey: "pro-plan", detectedAtDaysAgo: 10 },
        { entityKey: "basic-plan", detectedAtDaysAgo: 5 },
        { entityKey: "basic-plan", detectedAtDaysAgo: 1 },
      ],
      150,
    );

    await page.goto(`/competitors/${competitorId}?days=30`);

    await expect(page.getByTestId("activity-pattern-badge")).toHaveText("Above recent baseline");
    await expect(page.getByTestId("activity-pattern-detail")).toContainText("4 recorded changes in the last 30 days");
    await expect(page.getByTestId("activity-pattern-detail")).toContainText("average of 1");
    await expect(page.getByTestId("activity-pattern-detail")).toContainText("3 preceding 30-day periods");
    await expect(page.getByTestId("activity-pattern-detail")).toContainText("4x the baseline average");

    const repeatedSection = page.getByTestId("repeated-price-pattern-section");
    const items = repeatedSection.getByTestId("repeated-price-pattern-item");
    await expect(items).toHaveCount(2); // pro-plan (2 changes) and basic-plan (2 changes) both qualify
    await expect(repeatedSection.getByText("pro-plan")).toBeVisible();
    await expect(repeatedSection.getByText("basic-plan")).toBeVisible();
  });
});
