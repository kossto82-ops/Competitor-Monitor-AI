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

test.describe("Monitoring workflow (real worker, real queue, real fixture server)", () => {
  test("scan now goes Idle -> Queued/Scanning -> Completed, and a real Snapshot-backed status appears", async ({
    page,
  }) => {
    const org = makeTestOrg("ScanFlow");
    const suffix = Date.now();
    const siteKey = `mw-baseline-${suffix}`;
    const competitorName = `Scan Test Co ${suffix}`;

    await setFixtureState(siteKey, {
      mode: "normal",
      products: [{ name: "Example Pro", price: "49.00", currency: "EUR", availability: "Available" }],
    });

    await signup(page, org);
    await addCompetitor(page, competitorName);
    await openCompetitor(page, competitorName);
    await addMonitoredUrl(page, siteKey);

    const row = page.locator("li", { hasText: siteKey });
    await expect(row.getByTestId("scan-now-button")).toBeVisible();

    const finalPhase = await triggerScanAndWaitForTerminalState(row);
    expect(finalPhase).toBe("Completed");

    // First scan is always a baseline - no prior snapshot to compare against.
    await expect(row.getByText("No changes detected")).toBeVisible();
  });

  test("a real price change on the fixture server is detected as a real ChangeEvent after a second scan", async ({
    page,
  }) => {
    const org = makeTestOrg("PriceChange");
    const suffix = Date.now();
    const siteKey = `mw-price-${suffix}`;
    const competitorName = `Price Change Co ${suffix}`;

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

    // Mutate the real fixture server, then scan again.
    await setFixtureState(siteKey, {
      products: [{ name: "Example Pro", price: "39.00", currency: "EUR", availability: "Available" }],
    });
    await triggerScanAndWaitForTerminalState(row);

    await expect(row.getByText(/Price changed from/)).toBeVisible();
    await expect(row.getByText(/49\.00/)).toBeVisible();
    await expect(row.getByText(/39\.00/)).toBeVisible();
  });

  test("a fixture 403 is reported as 'Could not verify', never as a false change", async ({ page }) => {
    const org = makeTestOrg("FailedVerify");
    const suffix = Date.now();
    const siteKey = `mw-403-${suffix}`;
    const competitorName = `Blocked Co ${suffix}`;

    await setFixtureState(siteKey, { mode: "403" });

    await signup(page, org);
    await addCompetitor(page, competitorName);
    await openCompetitor(page, competitorName);
    await addMonitoredUrl(page, siteKey);

    const row = page.locator("li", { hasText: siteKey });
    await triggerScanAndWaitForTerminalState(row);

    await page.reload(); // pick up the persisted latestSnapshot/verification state via the server component
    const reloadedRow = page.locator("li", { hasText: siteKey });

    // The critical distinction (Section 6 of the brief): a failed fetch
    // must render as "Could not verify", never as "no changes" and never
    // as an invented removal/change.
    await expect(reloadedRow.getByText("Could not verify this page")).toBeVisible();
    await expect(reloadedRow.getByText("No changes detected")).toHaveCount(0);
    await expect(reloadedRow.getByText(/Product removed|Price changed/)).toHaveCount(0);
  });
});
