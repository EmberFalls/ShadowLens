import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { access } from "node:fs/promises";

const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "../manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest must use MV3");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://127.0.0.1:8787/*"])) throw new Error("Host permission must be limited to the loopback API");
if (manifest.content_scripts.some((script) => script.matches.some((entry) => entry !== "http://localhost:4173/*"))) throw new Error("Content injection must be sandbox-only");
if (manifest.content_scripts.some((script) => script.js.some((file) => file.includes("background")))) throw new Error("Background code cannot be content injected");
const dist = resolve(import.meta.dirname, "../dist");
const required = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap((script) => script.js)];
for (const file of required) {
  const resolved = resolve(dist, file);
  if (relative(dist, resolved).startsWith("..")) throw new Error(`Manifest path escapes extension package: ${file}`);
  await access(resolved);
}
console.log("Manifest scope is limited to the localhost sandbox.");
