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

test.describe("Change evidence detail", () => {
  test("opening a real change event shows real previous/current values, snapshots, and the source URL", async ({
    page,
  }) => {
    const org = makeTestOrg("Evidence");
    const suffix = Date.now();
    const siteKey = `ev-${suffix}`;
    const competitorName = `Evidence Co ${suffix}`;

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

    // Section-by-section evidence checks (Phase 2 spec's required fields).
    await expect(page.getByText("Price change")).toBeVisible();
    await expect(page.getByText("Previous value")).toBeVisible();
    await expect(page.getByText("EUR49.00")).toBeVisible();
    await expect(page.getByText("Current value")).toBeVisible();
    await expect(page.getByText("EUR39.00")).toBeVisible();
    await expect(page.getByText(/-20.4/)).toBeVisible(); // percentage change

    await expect(page.getByText("This is evidence, not an inference")).toBeVisible();

    await expect(page.getByText("Previous snapshot")).toBeVisible();
    await expect(page.getByText("Current snapshot")).toBeVisible();
    await expect(page.getByText("Extraction method").first()).toBeVisible();
    await expect(page.getByText("CHEERIO").first()).toBeVisible();
    await expect(page.getByText("Verification").first()).toBeVisible();

    const sourceLink = page.getByRole("link", { name: new RegExp(siteKey) });
    await expect(sourceLink).toBeVisible();
    await expect(sourceLink).toHaveAttribute("href", new RegExp(siteKey));
  });

  test("the change feed lists the same real change event and links to the same evidence", async ({ page }) => {
    const org = makeTestOrg("EvidenceFeed");
    const suffix = Date.now();
    const siteKey = `evf-${suffix}`;
    const competitorName = `Evidence Feed Co ${suffix}`;

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

    await page.goto("/changes");
    // Phase 5 added a competitor filter <select> above the list, whose <option> text
    // also matches the competitor's name but is not visible - .last() targets the actual change row.
    await expect(page.getByText(competitorName).last()).toBeVisible();
    await expect(page.getByText(/Price changed from/)).toBeVisible();

    await page.getByText(/Price changed from/).click();
    await expect(page).toHaveURL(/\/changes\//);
    await expect(page.getByText("EUR10.00")).toBeVisible();
    await expect(page.getByText("EUR12.00")).toBeVisible();
  });
});
