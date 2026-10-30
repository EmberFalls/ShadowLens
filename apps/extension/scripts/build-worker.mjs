import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["apps/extension/src/background/worker.ts"],
  outfile: "apps/extension/dist/apps/extension/src/background/worker.js",
  bundle: true, platform: "browser", format: "esm", target: "chrome120",
});
