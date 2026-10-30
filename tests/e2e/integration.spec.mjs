import { test, expect } from "@playwright/test";

test("live dashboard shows only API data, persists approval, and labels coverage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to ShadowLens" })).toBeVisible();
  await page.getByLabel("Owner password").fill("Synthetic-only E2E owner 2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("LIVE DATA")).toBeVisible();
  await expect(page.locator(".metric").filter({ hasText: "AI site visits observed" }).locator("strong")).toHaveText("1");
  await expect(page.locator(".metric").filter({ hasText: "Guarded attempts" }).locator("strong")).toHaveText("1");
  await expect(page.getByText(/Unsupported domains observed: CHATGPT/)).toBeVisible();
  await expect(page.getByText("Stale · not recently observed")).toBeVisible();
  await page.getByLabel("Window").selectOption("14");
  await expect(page.getByLabel("Window")).toHaveValue("14");
  await page.getByLabel("Timezone").selectOption("Asia/Kolkata");
  await expect(page.getByText("Asia/Kolkata local dates.")).toBeVisible();

  await page.getByRole("button", { name: "Tools" }).click();
  const chatgptRow = page.getByRole("row").filter({ hasText: "CHATGPT" });
  await expect(chatgptRow).toContainText("UNPROTECTED · unsupported");
  await expect(chatgptRow).toContainText("0");
  await chatgptRow.getByRole("combobox").selectOption("APPROVED");
  await chatgptRow.getByRole("button", { name: "Save" }).click();
  await expect(chatgptRow.getByRole("combobox")).toHaveValue("APPROVED");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to ShadowLens" })).toBeVisible();
  await page.getByLabel("Owner password").fill("Synthetic-only E2E owner 2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Tools" }).click();
  await expect(page.getByRole("row").filter({ hasText: "CHATGPT" }).getByRole("combobox")).toHaveValue("APPROVED");

  await page.getByRole("button", { name: "Events" }).click();
  await expect(page.getByText("Metadata only. Raw prompts are never displayed.")).toBeVisible();
  await expect(page.getByText("E2E_PRIVATE_SENTINEL", { exact: false })).toHaveCount(0);
  await expect(page.getByText("BLOCKED")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to ShadowLens" })).toBeVisible();
});

test("live dashboard shows service failure and never substitutes mock data", async ({ page }) => {
  await page.route("**/api/v1/auth/me", route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Local service unavailable" })).toBeVisible();
  await expect(page.getByText("MOCK DATA")).toHaveCount(0);
  await expect(page.getByText("18", { exact: true })).toHaveCount(0);
});
