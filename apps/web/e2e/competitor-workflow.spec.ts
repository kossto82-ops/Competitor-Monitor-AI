import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, signup } from "./helpers";

test.describe("Competitor workflow", () => {
  test("create a competitor, add a monitored URL, and see it reflected on the dashboard", async ({ page }) => {
    const org = makeTestOrg("CompetitorFlow");
    const suffix = Date.now();
    const competitorName = `Acme Corp ${suffix}`;

    await signup(page, org);
    await addCompetitor(page, competitorName);

    await openCompetitor(page, competitorName);
    await addMonitoredUrl(page, `cw-${suffix}`);

    // Real dashboard aggregate query must reflect the real rows just created.
    await page.goto("/dashboard");
    await expect(page.getByTestId("stat-competitors-value")).toHaveText("1");
    await expect(page.getByTestId("stat-monitored-urls-value")).toHaveText("1");
  });

  test("adding a monitored URL under a competitor that does not exist for this org is rejected", async ({ page }) => {
    const org = makeTestOrg("BadCompetitorId");
    await signup(page, org);

    const response = await page.request.post("/api/competitors/does-not-exist/urls", {
      data: { url: "https://example.com/", category: "GENERAL" },
    });
    expect(response.status()).toBe(404);
  });
});
