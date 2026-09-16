import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, setFixtureState, signup, triggerScanAndWaitForTerminalState } from "./helpers";

/**
 * Phase 5 (Section 30/31): the complete real customer journey, driven
 * through the actual browser against the actual stack - real Postgres,
 * real Redis, real BullMQ, real worker, real Next.js, real Chromium.
 *
 * The AI step uses a REAL AiConnection this organization creates
 * through the UI (provider=openai, model from CMA_AI_MODEL env, a real
 * OPENAI_API_KEY) - NOT the worker's CMA_AI_PROVIDER=fake env fallback
 * that other E2E suites rely on. Per resolveAiProviderForOrg's strict
 * precedence (Section 4), an organization's own AiConnection always
 * wins over any env fallback, so this genuinely proves "the customer's
 * own configuration, not a hidden default" even with the worker running
 * in its normal fake-fallback E2E mode.
 *
 * Requires (see DevRunbook.md §7/7b):
 *   - fixture server on 4100, apps/worker with CMA_ALLOW_PRIVATE_TARGETS=true
 *     and CMA_AI_ENCRYPTION_KEY set, apps/web with the same + a real
 *     OPENAI_API_KEY reachable via CMA_AI_MODEL/OPENAI_API_KEY env for
 *     THIS TEST FILE (read below, used only to fill the browser form -
 *     never read by production code).
 *   - Skipped entirely if OPENAI_API_KEY is not set, to avoid an
 *     accidental real charge in a plain CI run.
 */
const REAL_OPENAI_KEY = process.env["OPENAI_API_KEY"];
const REAL_MODEL = process.env["CMA_AI_MODEL"];

test.describe("Phase 5: complete customer journey", () => {
  test.skip(!REAL_OPENAI_KEY || !REAL_MODEL, "Requires OPENAI_API_KEY and CMA_AI_MODEL for the real-AI step - see DevRunbook.md");

  test("signup -> competitor -> URL -> scan -> verified change -> customer's own AI connection -> real AI analysis -> evidence, with no hidden model default", async ({
    page,
  }) => {
    const org = makeTestOrg("Journey");
    const suffix = Date.now();
    const siteKey = `journey-${suffix}`;
    const competitorName = `Journey Co ${suffix}`;

    // --- 1. Signup (Section 1: no developer knowledge required) ---
    await setFixtureState(siteKey, { mode: "normal", products: [{ name: "Pro Plan", price: "49.00", currency: "EUR", availability: "Available" }] });
    await signup(page, org);

    // First-run dashboard explains the product in plain language (Section 1/2) - no internal terms.
    await expect(page.getByText("Monitor your competitors")).toBeVisible();
    await expect(page.getByText(/ChangeEvent|BullMQ|AiAnalysis|snapshot/i)).toHaveCount(0);

    // --- 2. Add first competitor + URL (Section 3/4) ---
    await addCompetitor(page, competitorName);
    await openCompetitor(page, competitorName);
    await addMonitoredUrl(page, siteKey);

    const row = page.locator("li", { hasText: siteKey });

    // --- 3. Run first scan (Section 10) - baseline, no changes yet ---
    const baselinePhase = await triggerScanAndWaitForTerminalState(row);
    expect(baselinePhase).toBe("Completed");
    await expect(row.getByText("No changes detected")).toBeVisible();

    // --- 4. A real price change, verified by a second scan (Section 10) ---
    await setFixtureState(siteKey, { products: [{ name: "Pro Plan", price: "59.00", currency: "EUR", availability: "Available" }] });
    await triggerScanAndWaitForTerminalState(row);
    await expect(row.getByText(/Price changed from/)).toBeVisible();

    // --- 5. Configure the organization's OWN AI provider (Section 6) ---
    await page.goto("/settings/ai");
    await page.getByLabel("Provider").selectOption("openai");
    await page.getByLabel("Model").fill(REAL_MODEL!);
    // The model field genuinely starts empty (Section 7/32 regression fix) - fill it explicitly ourselves.
    await expect(page.getByLabel("Model")).toHaveValue(REAL_MODEL!);
    await page.getByLabel("API key").fill(REAL_OPENAI_KEY!);

    // --- 6. Test the connection BEFORE saving (Section 9) - a real provider call ---
    await page.getByTestId("test-ai-connection-button").click();
    await expect(page.getByTestId("form-test-result")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("form-test-result")).toContainText("Connection successful");

    await page.getByTestId("save-ai-connection-button").click();
    await expect(page.getByTestId("ai-connections-list")).toBeVisible();
    await expect(page.getByTestId("ai-connection-row")).toContainText(REAL_MODEL!);

    // --- 7. Trigger AI analysis on the verified change (Section 6/7/8) ---
    await openCompetitor(page, competitorName);
    await row.getByText(/Price changed from/).click();
    await expect(page).toHaveURL(/\/changes\//);
    const changeUrl = page.url();
    const changeEventId = changeUrl.split("/changes/")[1]!;

    await expect(page.getByText("This is evidence, not an inference")).toBeVisible();
    await expect(page.getByText("EUR59.00")).toBeVisible();

    const panel = page.getByTestId("ai-analysis-panel");
    await panel.getByTestId("ai-analyze-button").click();
    await expect(panel.getByTestId("ai-analysis-result")).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("ai-analysis-status-badge")).toHaveText("Analysis ready");

    // --- 8. Prove the persisted analysis used EXACTLY the organization's own configured provider/model (Section 31) ---
    const analysisResponse = await page.request.get(`/api/change-events/${changeEventId}/analysis`);
    const analysisBody = await analysisResponse.json();
    expect(analysisBody.analysis.provider).toBe("openai");
    expect(analysisBody.analysis.model).toBe(REAL_MODEL);
    expect(analysisBody.analysis.model).not.toBe("gpt-5.6-luna");

    // Deterministic evidence is untouched by the AI step.
    await expect(page.getByText("EUR59.00")).toBeVisible();

    // --- 9. Historical intelligence: the timeline shows this change (Section 15) ---
    await openCompetitor(page, competitorName);
    await expect(page.getByText(/Price changed from/).first()).toBeVisible();
    await expect(page.getByText("Timeline")).toBeVisible();
  });
});
