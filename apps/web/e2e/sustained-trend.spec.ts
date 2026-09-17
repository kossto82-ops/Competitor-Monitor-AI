import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, signup } from "./helpers";

// Same convention as pattern-intelligence.spec.ts - see that file's header comment for why
// seeding runs via a genuinely separate `node` process instead of importing @cma/db directly.
const SEED_SCRIPT = path.resolve(process.cwd(), "e2e/seedPatternEvents.mjs");

/**
 * Phase 14B: focused Playwright coverage for the Sustained Activity Trend
 * card (SustainedTrendCard) - see
 * docs/phases/PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md Section 11
 * (Option 3: competitor-detail-page-only, no Digest/AI/compare wiring) and
 * Section 19 (acceptance criteria). Reuses `seedPatternEvents.mjs` unmodified
 * (same script `pattern-intelligence.spec.ts` uses) - only the seeded event
 * shapes differ, chosen to land in the exact windows
 * `getSustainedActivityTrend` (packages/db/src/repositories/patterns.ts)
 * evaluates for a 30-day period: current [now-30,now), then [now-60,-30),
 * [now-90,-60), [now-120,-90), [now-150,-120).
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

/** `count` events, all landing on the same day-offset (the count itself is what matters to getActivityPattern, not the exact timestamp). */
function repeat(count: number, detectedAtDaysAgo: number): SeedEvent[] {
  return Array.from({ length: count }, () => ({ detectedAtDaysAgo }));
}

test.describe("Sustained Activity Trend (Phase 14B)", () => {
  test("A - sustained: a competitor with 3 consecutive above-baseline periods renders the sustained state", async ({ page }) => {
    const suffix = Date.now();
    const competitorId = await setUpCompetitor(page, "SustainedTrue", `sustained-true-${suffix}`);

    // current [0,30): 2 events; [30,60): 1 event; [60,90): 1 event; everything further back zero -
    // the zero-baseline special case makes every one of the 3 evaluated offsets ABOVE_BASELINE.
    seedPatternEvents(
      competitorId,
      [...repeat(2, 5), ...repeat(1, 35), ...repeat(1, 65)],
      160, // tracked long enough for a full 3-window sustained evaluation (>=150 days)
    );

    await page.goto(`/competitors/${competitorId}?days=30`);

    await expect(page.getByTestId("sustained-trend-direction-badge")).toHaveText("Above baseline");
    await expect(page.getByTestId("sustained-trend-headline")).toContainText("Sustained for 3 consecutive tracked periods");
    await expect(page.getByTestId("sustained-trend-not-enough-history")).toHaveCount(0);
    await expect(page.getByTestId("sustained-trend-no-current-pattern")).toHaveCount(0);
  });

  test("B - not enough history: a competitor whose current period qualifies but has no prior qualifying period shows the insufficient-history state", async ({ page }) => {
    const suffix = Date.now();
    const competitorId = await setUpCompetitor(page, "SustainedInsufficient", `sustained-insufficient-${suffix}`);

    // Tracked 100 days: the current window itself qualifies (>=90 days), but the immediately
    // preceding offset (its own "now" is 30 days earlier) has only 70 days of tracked history -
    // short of the 90-day floor it needs to qualify on its own.
    seedPatternEvents(competitorId, [...repeat(1, 5)], 100);

    await page.goto(`/competitors/${competitorId}?days=30`);

    await expect(page.getByTestId("sustained-trend-not-enough-history")).toBeVisible();
    await expect(page.getByTestId("sustained-trend-not-enough-history")).toContainText("Not enough history yet");
    await expect(page.getByTestId("sustained-trend-direction-badge")).toHaveCount(0);
  });

  test("C - trend did not hold: a reversal against the immediately preceding period renders the not-sustained state", async ({ page }) => {
    const suffix = Date.now();
    const competitorId = await setUpCompetitor(page, "SustainedReversal", `sustained-reversal-${suffix}`);

    // current [0,30): 5 events -> ABOVE its own baseline (avg(1,4,4)=3, ratio 1.67).
    // [30,60): 1 event -> that window's OWN current, compared to its baseline avg(4,4,4)=4,
    // ratio 0.25 -> BELOW_BASELINE. A reversal against the current window's ABOVE_BASELINE.
    seedPatternEvents(
      competitorId,
      [...repeat(5, 5), ...repeat(1, 35), ...repeat(4, 65), ...repeat(4, 95), ...repeat(4, 125)],
      200,
    );

    await page.goto(`/competitors/${competitorId}?days=30`);

    await expect(page.getByTestId("sustained-trend-direction-badge")).toHaveText("Above baseline");
    await expect(page.getByTestId("sustained-trend-headline")).toContainText("Trend did not hold");
    await expect(page.getByTestId("sustained-trend-not-enough-history")).toHaveCount(0);
  });
});
