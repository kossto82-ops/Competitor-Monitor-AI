import { test, expect } from "@playwright/test";
import { addCompetitor, addMonitoredUrl, makeTestOrg, openCompetitor, signup } from "./helpers";

test.describe("Tenant isolation (through the real UI/API, two real organizations)", () => {
  test("organization B cannot see organization A's competitors, URLs, or change events", async ({ browser }) => {
    const suffix = Date.now();
    const orgA = makeTestOrg("IsoA");
    const orgB = makeTestOrg("IsoB");
    const competitorNameA = `Org A Competitor ${suffix}`;

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signup(pageA, orgA);
    await addCompetitor(pageA, competitorNameA);
    await openCompetitor(pageA, competitorNameA);
    await addMonitoredUrl(pageA, `iso-${suffix}`);

    // Grab Org A's competitor id from the URL so Org B can try to hit it directly.
    const competitorAUrl = pageA.url();
    const competitorAId = competitorAUrl.split("/competitors/")[1];
    expect(competitorAId).toBeTruthy();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signup(pageB, orgB);

    // 1. Org B's own competitors list must not contain Org A's competitor.
    await pageB.goto("/competitors");
    await expect(pageB.getByText(competitorNameA)).toHaveCount(0);
    await expect(pageB.getByText("No competitors yet")).toBeVisible();

    // 2. Direct navigation to Org A's competitor detail page must not leak data.
    await pageB.goto(`/competitors/${competitorAId}`);
    const bodyText = await pageB.textContent("body");
    expect(bodyText).not.toContain(competitorNameA);

    // 3. API-level checks with Org B's own authenticated session.
    const competitorResponse = await pageB.request.get(`/api/competitors/${competitorAId}`);
    expect(competitorResponse.status()).toBe(404);

    const urlsResponse = await pageB.request.get(`/api/competitors/${competitorAId}/urls`);
    expect(urlsResponse.status()).toBe(200);
    const urlsBody = await urlsResponse.json();
    expect(urlsBody.monitoredUrls).toEqual([]);

    const scanResponse = await pageB.request.post(`/api/competitors/${competitorAId}/urls`, {
      data: { url: "https://sneaky.example.test/", category: "GENERAL" },
    });
    expect(scanResponse.status()).toBe(404);

    // 4. Org B's change-events list must never include Org A's data.
    const changeEventsResponse = await pageB.request.get("/api/change-events");
    expect(changeEventsResponse.status()).toBe(200);
    const changeEventsBody = await changeEventsResponse.json();
    expect(changeEventsBody.changeEvents.every((e: { monitoredUrl: { competitor: { name: string } } }) => e.monitoredUrl.competitor.name !== competitorNameA)).toBe(true);

    await contextA.close();
    await contextB.close();
  });
});
