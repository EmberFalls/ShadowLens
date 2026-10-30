"""Idempotently seed the frozen v2 site registry into the local database."""

from __future__ import annotations

import os
from pathlib import Path
import sys

try:
    from .db.database import connect, migrate, seed_domains
except ImportError:
    _root = Path(__file__).resolve().parents[3]
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))
    from apps.api.shadow_api.db.database import connect, migrate, seed_domains

DEFAULT_DATABASE = Path.home() / ".shadowshield" / "shadowshield.sqlite3"


def seed(database: str | Path | None = None) -> int:
    target = Path(database or os.environ.get("SHADOWSHIELD_DATABASE", str(DEFAULT_DATABASE))).expanduser().resolve()
    connection = connect(target)
    try:
        migrate(connection)
        return seed_domains(connection)
    finally:
        connection.close()


if __name__ == "__main__":
    print(f"Seeded {seed()} domain(s).")
