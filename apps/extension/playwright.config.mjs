import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const providerFixturesOnly = process.env.SHADOWLENS_PROVIDER_FIXTURES_ONLY === "1";
export default defineConfig({
  testDir: "./tests/browser", workers: 1, timeout: 30000,
  grep: providerFixturesOnly ? /Gemini textarea wrapper|unknown Gemini editor|Gemini benign send and SPA composer replacement/ : undefined,
  reporter: [["list"], ["json", { outputFile: "test-results/extension-browser.json" }]],
  webServer: providerFixturesOnly ? undefined : { command: "node apps/sandbox/server.mjs", cwd: fileURLToPath(new URL("../../", import.meta.url)), url: "http://localhost:4173", reuseExistingServer: false },
});

