import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(extensionRoot, "..", "..");
const archive = resolve(extensionRoot, "dist", "shadowlens-store-upload.zip");
const pythonExtractScript = String.raw`
import pathlib, sys, zipfile
archive = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2]).resolve()
target.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as package:
    for entry in package.infolist():
        name = pathlib.PurePosixPath(entry.filename)
        if name.is_absolute() or ".." in name.parts or not name.parts:
            raise SystemExit("Package contains an unsafe path")
        destination = (target.joinpath(*name.parts)).resolve()
        if target not in destination.parents:
            raise SystemExit("Package entry escapes its extraction directory")
        package.extract(entry, target)
manifest = target / "manifest.json"
if not manifest.is_file():
    raise SystemExit("Package is missing manifest.json")
`;

const temporaryBase = resolve(tmpdir());
const temporaryRoot = await mkdtemp(resolve(temporaryBase, "shadowlens-package-rehearsal-"));
const resolvedTemporaryRoot = resolve(temporaryRoot);
if (!resolvedTemporaryRoot.toLowerCase().startsWith(`${temporaryBase.toLowerCase()}${sep}`)) {
  throw new Error("Refusing to clean a rehearsal directory outside the system temporary directory");
}
try {
  const extracted = resolve(temporaryRoot, "extension");
  execFileSync("python", ["-c", pythonExtractScript, archive, extracted], { cwd: repositoryRoot, stdio: "inherit" });
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this script through npm run test:extension:package");
  const result = spawnSync(process.execPath, [npmCli, "run", "test:extension:browser"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SHADOWLENS_EXTENSION_DIR: extracted,
      SHADOWLENS_PROVIDER_FIXTURES_ONLY: "1",
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Packaged extension rehearsal failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

