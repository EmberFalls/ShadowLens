import { test, expect } from "@playwright/test";

test("live dashboard shows only API data, persists approval, and labels coverage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to ShadowLens" })).toBeVisible();
  await page.getByLabel("Owner password").fill("Synthetic-only E2E owner 2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("LIVE DATA")).toBeVisible();
  await expect(page.locator(".metric").filter({ hasText: "AI site visits observed" }).locator("strong")).toHaveText("2");
  await expect(page.locator(".metric").filter({ hasText: "Sandbox guarded attempts" }).locator("strong")).toHaveText("1");
  await expect(page.getByText(/Best-effort text protection enabled for: CHATGPT/)).toBeVisible();
  await expect(page.getByText(/Unsupported domains observed: COPILOT/)).toBeVisible();
  await expect(page.getByText("Active · stale")).toHaveCount(1);
  await expect(page.getByText("Active · recently seen")).toHaveCount(1);
  await page.getByLabel("Window").selectOption("14");
  await expect(page.getByLabel("Window")).toHaveValue("14");
  await page.getByLabel("Timezone").selectOption("Asia/Kolkata");
  await expect(page.getByText("Asia/Kolkata local dates.")).toBeVisible();

  await page.getByRole("button", { name: "Tools" }).click();
  const chatgptRow = page.getByRole("row").filter({ hasText: "CHATGPT" });
  await expect(chatgptRow).toContainText("BEST EFFORT");
  await expect(chatgptRow.locator("td").nth(4)).toHaveText("1");
  await chatgptRow.getByRole("combobox").selectOption("APPROVED");
  await chatgptRow.getByRole("button", { name: "Save" }).click();
  await expect(chatgptRow.getByRole("combobox")).toHaveValue("APPROVED");
  await page.reload();
  await expect(page.getByText("LIVE DATA")).toBeVisible();
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
  await expect(page.locator(".mode")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Overview" })).toHaveCount(0);
  await expect(page.getByText("18", { exact: true })).toHaveCount(0);
});

test("owner policy and privacy controls persist, export metadata, and delete event history", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Owner password").fill("Synthetic-only E2E owner 2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("LIVE DATA")).toBeVisible();

  await page.getByRole("button", { name: "Policy" }).click();
  await expect(page.getByText("Current revision: 1")).toBeVisible();
  await page.getByLabel("Business protected terms").fill("Synthetic E2E Project Atlas");
  await page.getByRole("button", { name: "Save and sign policy" }).click();
  await expect(page.getByText(/Policy revision 2 saved/)).toBeVisible();
  await expect(page.locator(".credential-value")).toHaveText(/^[a-f0-9]{64}$/);

  await page.getByRole("button", { name: "Privacy" }).click();
  await expect(page.getByText("Current setting: 30 days")).toBeVisible();
  await page.getByLabel("Keep event metadata for (days)").fill("14");
  await page.getByRole("button", { name: "Save retention" }).click();
  await expect(page.getByText(/Retention is now 14 days/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download metadata export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("shadowlens-metadata-export.json");
  await expect(page.getByText(/Prompt contents and bearer credentials are not included/)).toBeVisible();

  page.on("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete event history" }).click();
  await expect(page.getByText(/Deleted \d+ event\(s\)\./)).toBeVisible();
  await page.getByRole("button", { name: "Events" }).click();
  await expect(page.getByText("No events available.")).toBeVisible();
});
