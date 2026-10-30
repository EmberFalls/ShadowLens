import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
await rm(resolve(dist, "background/worker.js"), { force: true });
await cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
for (const folder of ["popup", "options"]) {
  await cp(resolve(root, "src", folder), resolve(dist, folder), { recursive: true, filter: (source) => !source.endsWith(".ts") });
}
