import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const FIXTURE_BASE = process.env["E2E_FIXTURE_URL"] ?? "http://127.0.0.1:4100";

export interface TestOrg {
  organizationName: string;
  email: string;
  password: string;
}

export function makeTestOrg(label: string): TestOrg {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    organizationName: `E2E ${label} ${suffix}`,
    email: `e2e-${label.toLowerCase().replace(/\s+/g, "-")}-${suffix}@example.test`,
    password: "a-long-enough-password",
  };
}

export async function signup(page: Page, org: TestOrg): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(org.organizationName);
  await page.getByLabel("Email").fill(org.email);
  await page.getByLabel("Password").fill(org.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function login(page: Page, org: Pick<TestOrg, "email" | "password">): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(org.email);
  await page.getByLabel("Password").fill(org.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

export async function addCompetitor(page: Page, name: string): Promise<void> {
  await page.goto("/competitors");
  await page.getByRole("button", { name: "Add competitor" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Add competitor" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

/** Navigates to the competitor's detail page by clicking its row (avoids hardcoding URL shape in tests). */
export async function openCompetitor(page: Page, name: string): Promise<void> {
  await page.goto("/competitors");
  await page.getByText(name).first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

export async function addMonitoredUrl(page: Page, siteKey: string, options?: { category?: string }): Promise<void> {
  const url = `${FIXTURE_BASE}/site/${siteKey}/product`;
  await page.getByRole("button", { name: "Add URL" }).click();
  await page.getByLabel("URL").fill(url);
  if (options?.category) {
    await page.getByLabel("Category").selectOption(options.category);
  }
  await page.getByRole("button", { name: "Add URL" }).click();
  await expect(page.getByText(url).first()).toBeVisible();
}

export async function setFixtureState(
  siteKey: string,
  state: {
    mode?: "normal" | "403" | "429" | "malformed" | "timeout";
    products?: { name: string; price: string; currency: string; availability: string }[];
  },
): Promise<void> {
  const res = await fetch(`${FIXTURE_BASE}/site/${siteKey}/admin/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`Failed to set fixture state for ${siteKey}: ${res.status}`);
}

/**
 * Clicks "Scan now" within `rowLocator` (the <li> for one monitored URL)
 * and waits, via the real UI polling loop against the real backend, for
 * the button to become enabled again - i.e. for the real worker to have
 * actually finished processing the real BullMQ job. No fixed sleep.
 */
export async function triggerScanAndWaitForTerminalState(
  rowLocator: ReturnType<Page["locator"]>,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const scanButton = rowLocator.getByTestId("scan-now-button");
  await scanButton.click();
  // While busy the button is disabled and shows Queued/Scanning; once the
  // real backend (worker/BullMQ/Postgres) confirms COMPLETED or FAILED it
  // re-enables. No fixed sleep - this polls the real DOM state, which
  // itself is driven by the component's own polling of the real API.
  await expect(scanButton).toBeEnabled({ timeout: options.timeoutMs ?? 20_000 });
  return (await rowLocator.getByTestId("scan-phase-badge").textContent()) ?? "";
}
