"""Create a deterministic browser-store upload ZIP from the built extension."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def package(output: Path) -> tuple[Path, str]:
    manifest_path = DIST / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError("extension build is missing; run npm run build:extension first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3 or not isinstance(manifest.get("version"), str):
        raise ValueError("extension manifest is invalid")
    service_worker = manifest.get("background", {}).get("service_worker")
    required = [manifest_path, DIST / service_worker, DIST / manifest.get("action", {}).get("default_popup", ""), DIST / manifest.get("options_page", "")]
    if any(not path.is_file() for path in required):
        raise ValueError("extension build is missing a manifest entrypoint")

    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".shadowlens-package-", suffix=".zip", dir=output.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(DIST.rglob("*")):
                if not path.is_file() or path == output or path.suffix.lower() in {".zip", ".map"}:
                    continue
                if stat.S_ISLNK(path.lstat().st_mode):
                    raise ValueError("extension package cannot contain symlinks")
                relative = path.relative_to(DIST).as_posix()
                info = ZipInfo(relative, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
        os.replace(temporary, output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return output, digest


def main() -> int:
    parser = argparse.ArgumentParser(description="Package the built ShadowLens extension for a browser-store upload")
    parser.add_argument("--output", type=Path, default=DIST / "shadowlens-store-upload.zip")
    args = parser.parse_args()
    try:
        output, digest = package(args.output)
        print(f"Store-upload ZIP created: {output}")
        print(f"SHA-256: {digest}")
        print("This ZIP is not published or signed as a managed CRX; store publication assigns the production extension ID.")
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Packaging failed ({type(exc).__name__}).")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
