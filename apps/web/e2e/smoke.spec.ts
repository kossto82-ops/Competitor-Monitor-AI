import { test, expect } from "@playwright/test";

test("signup form is interactive and reaches the dashboard", async ({ page }) => {
  const suffix = Date.now();
  await page.goto("/signup");

  await page.getByLabel("Organization name").fill(`Smoke Test Org ${suffix}`);
  await page.getByLabel("Email").fill(`smoke-${suffix}@example.test`);
  await page.getByLabel("Password").fill("a-long-enough-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});
