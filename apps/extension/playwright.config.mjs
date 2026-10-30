import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "./tests/browser", workers: 1, timeout: 30000,
  reporter: [["list"], ["json", { outputFile: "test-results/extension-browser.json" }]],
  webServer: { command: "node apps/sandbox/server.mjs", cwd: fileURLToPath(new URL("../../", import.meta.url)), url: "http://localhost:4173", reuseExistingServer: false },
});
