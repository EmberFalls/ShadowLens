import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "shadowlens-e2e-"));
const database = join(temporary, "synthetic.sqlite3");
const python = process.env.PYTHON ?? "python";
const children = [];
let cleaning = false;

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return result.stdout;
}

function start(command, args, options) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true, ...options });
  children.push(child);
  child.once("error", error => { console.error(error); void cleanup(1); });
  child.once("exit", code => {
    if (!cleaning && code !== 0 && code !== null) {
      console.error(`${command} exited unexpectedly with ${code}`);
      void cleanup(code);
    }
  });
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`service stopped before ${url} became ready`);
    try { if ((await fetch(url)).ok) return; } catch { /* waiting for bind */ }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function cleanup(exitCode = 0) {
  if (cleaning) return;
  cleaning = true;
  for (const child of [...children].reverse()) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(children.map(child => child.exitCode === null ? once(child, "exit").catch(() => {}) : Promise.resolve()));
  await rm(temporary, { recursive: true, force: true });
  if (exitCode !== 0) process.exitCode = exitCode;
}

try {
  const credentials = JSON.parse(runSync(python, ["tests/e2e/bootstrap.py"], { env: { ...process.env, SHADOWSHIELD_DATABASE: database, PYTHONPATH: root } }));
  const api = start(python, ["-m", "uvicorn", "shadow_api.main:app", "--host", "127.0.0.1", "--port", "8787", "--no-access-log"], {
    cwd: join(root, "apps/api"),
    env: { ...process.env, PYTHONPATH: join(root, "apps/api"), SHADOWSHIELD_DATABASE: database, SHADOWSHIELD_OWNER_ID: "e2e-owner", SHADOWSHIELD_PORT: "8787", SHADOWSHIELD_CORS_ORIGINS: "http://127.0.0.1:5173" },
  });
  const dashboard = start(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], { cwd: join(root, "apps/dashboard") });
  await Promise.all([waitFor("http://127.0.0.1:8787/api/v1/health", api), waitFor("http://127.0.0.1:5173/", dashboard)]);
  const analyticsProbe = await fetch("http://127.0.0.1:8787/api/v1/analytics/summary?days=7");
  if (analyticsProbe.status !== 401) throw new Error(`live API routes are not mounted (expected signed-out 401, received ${analyticsProbe.status}); G4 is blocked`);

  const observedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const events = [
    { contractVersion: "v2", eventId: crypto.randomUUID(), clientObservedAt: observedAt, deviceId: credentials.deviceId, kind: "SITE_VISIT", siteId: "CHATGPT", supportStatus: "UNSUPPORTED", reasonCodes: ["UNSUPPORTED_AI_SITE_SEEN"] },
    { contractVersion: "v2", eventId: crypto.randomUUID(), clientObservedAt: observedAt, deviceId: credentials.deviceId, kind: "SUBMISSION", siteId: "SANDBOX", coverageMode: "SANDBOX_GUARDED", decisionAction: "BLOCK", disposition: "BLOCKED", aggregateTier: "HIGH", scoreBand: "HIGH", categoryCounts: { PII_EMAIL: 1 }, policyRevision: 1, engineVersion: "0.1.0", lengthBand: "1_99", reasonCodes: ["DETECTED_PII", "POLICY_BLOCK"] },
  ];
  const ingest = await fetch("http://127.0.0.1:8787/api/v1/events/batch", { method: "POST", headers: { Authorization: `Bearer ${credentials.deviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ contractVersion: "v2", events }) });
  if (!ingest.ok) throw new Error(`synthetic event seed failed with HTTP ${ingest.status}`);

  const sentinel = "E2E_PRIVATE_SENTINEL";
  const rejected = await fetch("http://127.0.0.1:8787/api/v1/events/batch", { method: "POST", headers: { Authorization: `Bearer ${credentials.deviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ contractVersion: "v2", events: [{ ...events[0], eventId: crypto.randomUUID(), promptText: sentinel }] }) });
  const rejectionBody = await rejected.text();
  if (rejected.status !== 422 || rejectionBody.includes(sentinel)) throw new Error("API did not safely reject a prompt-bearing event");
  const storedMatches = runSync(python, ["-c", "import os, sqlite3, sys; db=sqlite3.connect(os.environ['SHADOWSHIELD_DATABASE']); print(db.execute('SELECT COUNT(*) FROM events WHERE payload_json LIKE ?', ('%' + sys.argv[1] + '%',)).fetchone()[0]); db.close()", sentinel], { env: { ...process.env, SHADOWSHIELD_DATABASE: database } }).trim();
  if (storedMatches !== "0") throw new Error("raw-prompt sentinel was found in the persisted event queue");

  runSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", "tests/e2e/playwright.config.mjs"], { cwd: root, stdio: "inherit" });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cleanup(process.exitCode ?? 0);
}
