import { test, expect } from "@playwright/test";
import { makeTestOrg, signup } from "./helpers";

/**
 * Phase 3.1, Section 27: real-browser validation of AI connection
 * management - creating a connection, confirming the API key is never
 * displayed or leaked over the network, and tenant isolation between
 * two real organizations. Does not trigger a real AI analysis through
 * this connection (provider="openai" here uses a placeholder key that
 * is never actually called in this suite) - the worker's use of a
 * resolved AiConnection is covered at the unit level
 * (apps/worker/src/resolveAiProvider.test.ts), and the fake-provider
 * end-to-end analysis path is covered by ai-analysis.spec.ts.
 */
test.describe("AI connection management", () => {
  test("creating a connection shows masked metadata only, never the API key, and it survives a reload", async ({ page }) => {
    const org = makeTestOrg("AiConnCreate");
    await signup(page, org);

    await page.goto("/settings/ai");
    await page.getByTestId("save-ai-connection-button").click();
    await page.getByLabel("Model").fill("gpt-5.6-luna");
    await page.getByLabel("API key").fill("sk-e2e-placeholder-should-never-be-shown");
    await page.getByTestId("save-ai-connection-button").click();

    const row = page.getByTestId("ai-connection-row").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("API key configured");
    await expect(row).not.toContainText("sk-e2e-placeholder-should-never-be-shown");

    // The key must never appear anywhere in the rendered page HTML either.
    const html = await page.content();
    expect(html).not.toContain("sk-e2e-placeholder-should-never-be-shown");

    await page.reload();
    await expect(page.getByTestId("ai-connection-row").first()).toContainText("API key configured");
  });

  test("the API response for listing connections never includes the key in any field", async ({ page }) => {
    const org = makeTestOrg("AiConnNetwork");
    await signup(page, org);

    await page.goto("/settings/ai");
    await page.getByTestId("save-ai-connection-button").click();
    await page.getByLabel("Model").fill("gpt-5.6-luna");
    await page.getByLabel("API key").fill("sk-network-check-value");
    await page.getByTestId("save-ai-connection-button").click();
    await expect(page.getByTestId("ai-connection-row").first()).toBeVisible();

    const response = await page.request.get("/api/ai-connections");
    const body = await response.text();
    expect(body).not.toContain("sk-network-check-value");
    expect(body).not.toMatch(/"(encryptedApiKey|apiKey)":/);
  });

  test("tenant isolation: organization B cannot list, read, or modify organization A's AI connection", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const orgA = makeTestOrg("AiConnTenantA");
    const orgB = makeTestOrg("AiConnTenantB");
    await signup(pageA, orgA);
    await signup(pageB, orgB);

    await pageA.goto("/settings/ai");
    await pageA.getByTestId("save-ai-connection-button").click();
    await pageA.getByLabel("Model").fill("gpt-5.6-luna");
    await pageA.getByLabel("API key").fill("sk-org-a-secret");
    await pageA.getByTestId("save-ai-connection-button").click();
    await expect(pageA.getByTestId("ai-connection-row").first()).toBeVisible();

    const connectionId = await pageA.evaluate(async () => {
      const res = await fetch("/api/ai-connections");
      const body = await res.json();
      return body.connections[0].id as string;
    });

    // Org B's own list is empty - it never sees org A's connection.
    await pageB.goto("/settings/ai");
    await expect(pageB.getByTestId("ai-connections-list")).toHaveCount(0);

    // Org B cannot fetch, modify, or delete org A's connection by id.
    const getStatus = await pageB.evaluate(async (id) => (await fetch(`/api/ai-connections/${id}`)).status, connectionId);
    expect(getStatus).toBe(404);

    const patchStatus = await pageB.evaluate(
      async (id) => (await fetch(`/api/ai-connections/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status,
      connectionId,
    );
    expect(patchStatus).toBe(404);

    const deleteStatus = await pageB.evaluate(async (id) => (await fetch(`/api/ai-connections/${id}`, { method: "DELETE" })).status, connectionId);
    expect(deleteStatus).toBe(404);

    // Org A's connection is untouched by B's attempts.
    await pageA.reload();
    await expect(pageA.getByTestId("ai-connection-row").first()).toContainText("Enabled");

    await contextA.close();
    await contextB.close();
  });

  test("disabling and deleting a connection works from the UI", async ({ page }) => {
    const org = makeTestOrg("AiConnLifecycle");
    await signup(page, org);

    await page.goto("/settings/ai");
    await page.getByTestId("save-ai-connection-button").click();
    await page.getByLabel("Model").fill("gpt-5.6-luna");
    await page.getByLabel("API key").fill("sk-lifecycle-value");
    await page.getByTestId("save-ai-connection-button").click();

    const row = page.getByTestId("ai-connection-row").first();
    await expect(row).toContainText("Enabled");
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row).toContainText("Disabled");

    await row.getByRole("button", { name: "Delete connection" }).click();
    await expect(page.getByTestId("ai-connection-row")).toHaveCount(0);
  });
});
