import { test, expect } from "@playwright/test";
import {
  addCompetitor,
  addMonitoredUrl,
  makeTestOrg,
  openCompetitor,
  setFixtureState,
  signup,
  triggerScanAndWaitForTerminalState,
} from "./helpers";

/**
 * Phase 3 (Section 14): exercises the real queue/worker/UI path for AI
 * analysis end to end. Requires apps/worker to be running with
 * CMA_AI_PROVIDER=fake (see DevRunbook.md) so this suite is
 * deterministic and free, never calling a real paid model - identical
 * in spirit to CMA_ALLOW_PRIVATE_TARGETS letting the monitoring E2E
 * suite hit the fixture server instead of the real internet.
 */
test.describe("AI change analysis", () => {
  test("triggering analysis on a real price-change event goes pending -> completed with a structured result, while the original evidence stays visible", async ({
    page,
  }) => {
    const org = makeTestOrg("AiAnalysis");
    const suffix = Date.now();
    const siteKey = `ai-${suffix}`;
    const competitorName = `AI Analysis Co ${suffix}`;

    await setFixtureState(siteKey, {
      mode: "normal",
      products: [{ name: "Example Pro", price: "49.00", currency: "EUR", availability: "Available" }],
    });

    await signup(page, org);
    await addCompetitor(page, competitorName);
    await openCompetitor(page, competitorName);
    await addMonitoredUrl(page, siteKey);

    const row = page.locator("li", { hasText: siteKey });
    await triggerScanAndWaitForTerminalState(row); // baseline

    await setFixtureState(siteKey, {
      products: [{ name: "Example Pro", price: "39.00", currency: "EUR", availability: "Available" }],
    });
    await triggerScanAndWaitForTerminalState(row);

    await row.getByText(/Price changed from/).click();
    await expect(page).toHaveURL(/\/changes\//);

    // The deterministic evidence is still there, unaffected by anything below.
    await expect(page.getByText("This is evidence, not an inference")).toBeVisible();
    await expect(page.getByText("EUR39.00")).toBeVisible();

    const panel = page.getByTestId("ai-analysis-panel");
    await expect(panel).toBeVisible();

    await panel.getByTestId("ai-analyze-button").click();

    // Pending/running, driven by real polling against the real API/worker - no fixed sleep.
    await expect(panel.getByTestId("ai-analysis-status-badge")).toBeVisible();

    await expect(panel.getByTestId("ai-analysis-result")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("ai-analysis-status-badge")).toHaveText("Analysis ready");
    await expect(panel.getByTestId("ai-analysis-facts")).toBeVisible();
    await expect(panel.getByText("AI-generated interpretation")).toBeVisible();

    // Evidence is still visible alongside the completed AI result (Section 13/14).
    await expect(page.getByText("EUR39.00")).toBeVisible();
  });

  test("re-opening the change detail page after analysis shows the already-completed result without re-triggering", async ({
    page,
  }) => {
    const org = makeTestOrg("AiAnalysisPersist");
    const suffix = Date.now();
    const siteKey = `aip-${suffix}`;
    const competitorName = `AI Persist Co ${suffix}`;

    await setFixtureState(siteKey, {
      mode: "normal",
      products: [{ name: "Widget", price: "10.00", currency: "EUR", availability: "Available" }],
    });

    await signup(page, org);
    await addCompetitor(page, competitorName);
    await openCompetitor(page, competitorName);
    await addMonitoredUrl(page, siteKey);

    const row = page.locator("li", { hasText: siteKey });
    await triggerScanAndWaitForTerminalState(row);
    await setFixtureState(siteKey, { products: [{ name: "Widget", price: "12.00", currency: "EUR", availability: "Available" }] });
    await triggerScanAndWaitForTerminalState(row);

    await row.getByText(/Price changed from/).click();
    await expect(page).toHaveURL(/\/changes\//);
    const changeUrl = page.url();

    const panel = page.getByTestId("ai-analysis-panel");
    await panel.getByTestId("ai-analyze-button").click();
    await expect(panel.getByTestId("ai-analysis-result")).toBeVisible({ timeout: 20_000 });

    await page.goto(changeUrl);
    const reloadedPanel = page.getByTestId("ai-analysis-panel");
    await expect(reloadedPanel.getByTestId("ai-analysis-result")).toBeVisible();
    // No "Analyze" button once already completed - nothing to trigger again.
    await expect(reloadedPanel.getByTestId("ai-analyze-button")).toHaveCount(0);
  });

  test("a change type with no AI analysis support (content change) never shows an Analyze control", async ({ page }) => {
    const org = makeTestOrg("AiAnalysisUnsupported");
    const suffix = Date.now();
    const siteKey = `aiu-${suffix}`;
    const competitorName = `AI Unsupported Co ${suffix}`;

    await setFixtureState(siteKey, {
      mode: "normal",
      products: [{ name: "Widget", price: "10.00", currency: "EUR", availability: "Available" }],
    });

    await signup(page, org);
    await addCompetitor(page, competitorName);
    await openCompetitor(page, competitorName);
    await addMonitoredUrl(page, siteKey);

    const row = page.locator("li", { hasText: siteKey });
    await triggerScanAndWaitForTerminalState(row);
    // Same product/price, but the fixture's free-text content changes -
    // the deterministic engine emits CONTENT_CHANGE, not PRICE_CHANGE.
    await setFixtureState(siteKey, {
      products: [{ name: "Widget", price: "10.00", currency: "EUR", availability: "Backordered" }],
    });
    await triggerScanAndWaitForTerminalState(row);

    await page.goto("/changes");
    // Phase 5 added a competitor filter <select> above the list, whose <option> text
    // also matches the competitor's name but is not visible - .last() targets the actual change row.
    await page.getByText(competitorName).last().click();
    await expect(page).toHaveURL(/\/changes\//);
    await expect(page.getByTestId("ai-analysis-panel")).toHaveCount(0);
  });
});
