import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("MV3 injects only at the exact local sandbox origin from document_start in the isolated world", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts.map((script) => script.matches), [["http://localhost:4173/*"]]);
  assert.ok(manifest.content_scripts.every((script) => script.run_at === "document_start" && script.world === "ISOLATED"));
  assert.ok(manifest.content_scripts.flatMap((script) => script.js).every((file) => !file.includes("background")));
  assert.ok(manifest.content_scripts.flatMap((script) => script.js).every((file) => !file.includes("127.0.0.1") && !file.includes("8787")));
});

test("host permissions stay limited to the local API and avoid unconditional web injection", () => {
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:8787/*"]);
  assert.ok(!JSON.stringify(manifest).includes("<all_urls>"));
  assert.ok(manifest.permissions.every((permission) => ["storage", "webNavigation", "alarms"].includes(permission)));
});

test("popup and Options credential flow are extension pages, not page-injected scripts", () => {
  assert.equal(manifest.action.default_popup, "popup/index.html");
  assert.equal(manifest.options_page, "options/index.html");
});
