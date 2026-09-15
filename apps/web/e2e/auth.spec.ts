import { test, expect } from "@playwright/test";
import { login, logout, makeTestOrg, signup } from "./helpers";

test.describe("Authentication", () => {
  test("signup creates a real organization and reaches the dashboard", async ({ page }) => {
    const org = makeTestOrg("Signup");
    await signup(page, org);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("login with the credentials just created succeeds", async ({ page }) => {
    const org = makeTestOrg("Login");
    await signup(page, org);
    await logout(page);

    await login(page, org);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("login with a wrong password is rejected with a generic error", async ({ page }) => {
    const org = makeTestOrg("BadLogin");
    await signup(page, org);
    await logout(page);

    await page.goto("/login");
    await page.getByLabel("Email").fill(org.email);
    await page.getByLabel("Password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Invalid email or password" })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("logout clears the session and returns to login", async ({ page }) => {
    const org = makeTestOrg("Logout");
    await signup(page, org);
    await logout(page);
    await expect(page.getByText("Sign in to your account")).toBeVisible();
  });

  test("unauthenticated access to a protected page redirects to login", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated access to a protected API route is rejected with 401, not data", async ({ request }) => {
    const response = await request.get("/api/competitors");
    expect(response.status()).toBe(401);
  });
});
