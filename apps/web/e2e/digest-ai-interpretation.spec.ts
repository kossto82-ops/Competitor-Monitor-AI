import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, signup } from "./helpers";

// Same subprocess-seeding approach as digest.spec.ts / pattern-intelligence.spec.ts - see
// seedPatternEvents.mjs's header comment for why seeding runs as a genuinely separate `node`
// process. Requires apps/worker running with CMA_AI_PROVIDER=fake (see DevRunbook.md) so this
// suite is deterministic and free, never calling a real paid model - identical rationale to
// ai-analysis.spec.ts.
const SEED_PATTERN_SCRIPT = path.resolve(process.cwd(), "e2e/seedPatternEvents.mjs");
const SEED_FAILED_INTERPRETATION_SCRIPT = path.resolve(process.cwd(), "e2e/seedFailedDigestInterpretation.mjs");

interface SeedEvent {
  changeType?: "PRICE_CHANGE" | "PRODUCT_ADDED" | "PRODUCT_REMOVED";
  entityKey?: string;
  detectedAtDaysAgo: number;
}

function seedPatternEvents(competitorId: string, events: SeedEvent[], backdateCreatedAtDays?: number): void {
  const payload = JSON.stringify({ competitorId, backdateCreatedAtDays, events });
  const output = execFileSync("node", [SEED_PATTERN_SCRIPT, payload], { encoding: "utf-8" });
  const result = JSON.parse(output) as { ok: boolean; error?: string };
  if (!result.ok) throw new Error(`seedPatternEvents.mjs failed: ${result.error}`);
}

function seedFailedDigestInterpretation(competitorId: string, days: number, errorMessage: string): void {
  const payload = JSON.stringify({ competitorId, days, errorMessage });
  const output = execFileSync("node", [SEED_FAILED_INTERPRETATION_SCRIPT, payload], { encoding: "utf-8" });
  const result = JSON.parse(output) as { ok: boolean; error?: string };
  if (!result.ok) throw new Error(`seedFailedDigestInterpretation.mjs failed: ${result.error}`);
}

async function setUpCompetitorInOrg(page: import("@playwright/test").Page, competitorName: string, siteKey: string): Promise<string> {
  await addCompetitor(page, competitorName);
  await openCompetitor(page, competitorName);
  await addMonitoredUrl(page, siteKey);
  return page.url().split("/competitors/")[1]!.split("?")[0]!;
}

/**
 * Phase 11 (PHASE11-VALIDATION-REPORT.md): focused Playwright coverage for
 * the Digest's optional Tier-4 AI interpretation layer. Every test here
 * exercises real application code (the /api/digest/interpretation route,
 * the real BullMQ queue/worker, digestInterpretationPipeline.ts,
 * @cma/ai's buildDigestInterpretationInput/analyzeAndValidateDigest)
 * against a REAL Postgres database and a REAL Redis-backed worker
 * through a REAL browser session - only the fake AiProvider is a test
 * double (CMA_AI_PROVIDER=fake), exactly like ai-analysis.spec.ts.
 */
test.describe("Digest AI interpretation (Phase 11)", () => {
  test("1 - a qualifying activity pattern can be interpreted end to end: pending -> completed, with a structured, evidence-linked result, while the deterministic feed stays fully intact", async ({
    page,
  }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestAiHappy");
    await signup(page, org);

    const competitorName = `Digest AI Co ${suffix}`;
    const id = await setUpCompetitorInOrg(page, competitorName, `digest-ai-${suffix}`);

    // Same seeding shape as digest.spec.ts test 3: baseline 1/window, current 4 -> ABOVE_BASELINE.
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

    // The deterministic evidence is present before any AI action is taken.
    const patternItem = page.locator('[data-testid="digest-item"][data-digest-kind="ACTIVITY_PATTERN"]');
    await expect(patternItem).toHaveCount(1);

    const panel = page.getByTestId("digest-ai-interpretation-panel");
    await expect(panel).toBeVisible();
    await panel.getByTestId("digest-ai-interpret-button").click();

    await expect(panel.getByTestId("digest-ai-status-badge")).toBeVisible();
    await expect(panel.getByTestId("digest-ai-result")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("digest-ai-status-badge")).toHaveText("Analysis ready");
    await expect(page.getByText("AI-generated interpretation")).toBeVisible();
    await expect(panel.getByTestId("digest-ai-observations")).toBeVisible();

    // Every AI claim exposes a real evidence link - clicking it lands on the same
    // real ChangeEvent evidence page every other digest item links to (Phase 10).
    await panel.getByTestId("digest-ai-observations").getByText("View evidence →").first().click();
    await expect(page).toHaveURL(/\/changes\//);
    await expect(page.getByText("This is evidence, not an inference")).toBeVisible();

    // The deterministic Digest feed is completely unaffected by the AI action.
    await page.goto("/digest?days=30");
    await expect(page.locator('[data-testid="digest-item"][data-digest-kind="ACTIVITY_PATTERN"]')).toHaveCount(1);
  });

  test("2 - re-opening the digest after interpretation shows the already-completed result without re-triggering a new job", async ({
    page,
  }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestAiPersist");
    await signup(page, org);

    const competitorName = `Digest AI Persist Co ${suffix}`;
    const id = await setUpCompetitorInOrg(page, competitorName, `digest-ai-persist-${suffix}`);
    seedPatternEvents(id, [{ detectedAtDaysAgo: 1, entityKey: "pro-plan" }]);

    await page.goto("/digest?days=30");
    const panel = page.getByTestId("digest-ai-interpretation-panel");
    await panel.getByTestId("digest-ai-interpret-button").click();
    await expect(panel.getByTestId("digest-ai-result")).toBeVisible({ timeout: 20_000 });

    await page.reload();
    const reloadedPanel = page.getByTestId("digest-ai-interpretation-panel");
    await expect(reloadedPanel.getByTestId("digest-ai-result")).toBeVisible();
    // No "Interpret" button once already completed - nothing to trigger again on a plain reload.
    await expect(reloadedPanel.getByTestId("digest-ai-interpret-button")).toHaveCount(0);
  });

  test("3 - AI failure never destroys the deterministic Digest: the feed above renders fully, the panel shows a Retry control, no fabricated interpretation appears", async ({
    page,
  }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestAiFailure");
    await signup(page, org);

    const competitorName = `Digest AI Failure Co ${suffix}`;
    const id = await setUpCompetitorInOrg(page, competitorName, `digest-ai-failure-${suffix}`);
    seedPatternEvents(id, [{ detectedAtDaysAgo: 1, entityKey: "pro-plan" }]);
    seedFailedDigestInterpretation(id, 30, "provider timed out");

    await page.goto("/digest?days=30");

    // The deterministic feed rendered normally, independent of the AI failure below.
    await expect(page.getByTestId("digest-feed")).toBeVisible();
    await expect(page.locator('[data-testid="digest-item"][data-digest-kind="CHANGE_EVENT"]')).toHaveCount(1);

    const panel = page.getByTestId("digest-ai-interpretation-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("digest-ai-status-badge")).toHaveText("Analysis unavailable");
    await expect(panel.getByTestId("digest-ai-error")).toContainText("provider timed out");
    await expect(panel.getByTestId("digest-ai-interpret-button")).toHaveText(/Retry interpretation/);
    await expect(panel.getByTestId("digest-ai-result")).toHaveCount(0);
  });

  test("4 - tenant isolation: Org B never sees Org A's AI interpretation content, even after Org A completes one", async ({ browser }) => {
    const suffixA = Date.now();
    const orgA = makeTestOrg("DigestAiTenantA");
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signup(pageA, orgA);
    const competitorNameA = `Digest AI Tenant A Co ${suffixA}`;
    const idA = await setUpCompetitorInOrg(pageA, competitorNameA, `digest-ai-tenant-a-${suffixA}`);
    seedPatternEvents(idA, [{ detectedAtDaysAgo: 1, entityKey: "pro-plan" }]);

    await pageA.goto("/digest?days=30");
    const panelA = pageA.getByTestId("digest-ai-interpretation-panel");
    await panelA.getByTestId("digest-ai-interpret-button").click();
    await expect(panelA.getByTestId("digest-ai-result")).toBeVisible({ timeout: 20_000 });
    await contextA.close();

    const orgB = makeTestOrg("DigestAiTenantB");
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signup(pageB, orgB);

    await pageB.goto("/digest?days=30");
    // Org B has zero competitors of its own - onboarding explainer, never Org A's data or AI panel.
    await expect(pageB.getByText("Monitor your competitors")).toBeVisible();
    await expect(pageB.getByTestId("digest-ai-interpretation-panel")).toHaveCount(0);
    const bodyText = await pageB.textContent("body");
    expect(bodyText).not.toContain(competitorNameA);
    await contextB.close();
  });

  test("5 - mobile (375x812): the AI interpretation panel renders alongside a populated deterministic feed with no horizontal overflow", async ({
    page,
  }) => {
    const suffix = Date.now();
    const org = makeTestOrg("DigestAiMobile");
    await signup(page, org);

    const competitorName = `Digest AI Mobile Co ${suffix}`;
    const id = await setUpCompetitorInOrg(page, competitorName, `digest-ai-mobile-${suffix}`);
    seedPatternEvents(id, [{ detectedAtDaysAgo: 1, entityKey: "pro-plan" }]);

    // Same convention as digest.spec.ts test 7: set the mobile viewport AFTER setup navigation,
    // not before - the pre-existing mobile sidebar/nav layout (documented as an unrelated known
    // limitation in PHASE10-VALIDATION-REPORT.md Section 15) otherwise hides the setup UI itself.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/digest?days=30");
    await expect(page.getByTestId("digest-ai-interpretation-panel")).toBeVisible();

    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasOverflow).toBe(false);
  });
});
