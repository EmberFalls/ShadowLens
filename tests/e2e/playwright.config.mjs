import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "integration.spec.mjs",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5173", browserName: "chromium", headless: true },
});
