"""SQLite schema, migrations, and privacy-preserving event storage.

The database is intentionally a single-process local-demo store. Callers own
the connection lifetime; each connection enables foreign keys and a busy
timeout. Timestamps written here are fixed-width UTC ISO strings so lexical
ordering is chronological ordering.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import os
import sqlite3
from pathlib import Path
from typing import Iterator

DEFAULT_BUSY_TIMEOUT_MS = 5_000

# The migrations are immutable once released. A changed checksum is treated
# as database corruption/schema drift and must be repaired explicitly.
MIGRATIONS: tuple[tuple[int, str], ...] = (
    (
        1,
        """
        CREATE TABLE devices (
            device_id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
            device_label TEXT NOT NULL DEFAULT 'Demo browser' CHECK (length(device_label) BETWEEN 1 AND 100),
            created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
            revoked_at TEXT,
            last_heartbeat_at TEXT,
            CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
            CHECK (last_heartbeat_at IS NULL OR last_heartbeat_at GLOB '????-??-??T??:??:??.??????Z')
        );

        CREATE TABLE domains (
            site_id TEXT PRIMARY KEY,
            canonical_host TEXT NOT NULL UNIQUE CHECK (length(canonical_host) > 0 AND canonical_host = lower(canonical_host)),
            approval_status TEXT NOT NULL CHECK (approval_status IN ('APPROVED','UNAPPROVED','UNREVIEWED')),
            updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
            CHECK (site_id IN ('SANDBOX','CHATGPT','GEMINI','CLAUDE','COPILOT','PERPLEXITY'))
        );

        CREATE TABLE events (
            event_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES devices(device_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            kind TEXT NOT NULL CHECK (kind IN ('SUBMISSION','SITE_VISIT','DEVICE_HEARTBEAT')),
            site_id TEXT REFERENCES domains(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
            ingested_at TEXT NOT NULL CHECK (ingested_at GLOB '????-??-??T??:??:??.??????Z'),
            CHECK ((kind = 'DEVICE_HEARTBEAT' AND site_id IS NULL) OR (kind != 'DEVICE_HEARTBEAT' AND site_id IS NOT NULL))
        );

        CREATE INDEX idx_events_kind_time ON events(kind, ingested_at);
        CREATE INDEX idx_events_site_time ON events(site_id, ingested_at);
        CREATE INDEX idx_events_device_time ON events(device_id, ingested_at);

        CREATE TABLE owners (
            owner_id TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z')
        );

        CREATE TABLE owner_sessions (
            id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
            owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON UPDATE RESTRICT ON DELETE CASCADE,
            expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z')
        );
        CREATE INDEX idx_owner_sessions_owner_expiry ON owner_sessions(owner_id, expires_at);

        CREATE TABLE domain_approval_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL REFERENCES domains(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            old_status TEXT NOT NULL CHECK (old_status IN ('APPROVED','UNAPPROVED','UNREVIEWED')),
            new_status TEXT NOT NULL CHECK (new_status IN ('APPROVED','UNAPPROVED','UNREVIEWED')),
            changed_at TEXT NOT NULL CHECK (changed_at GLOB '????-??-??T??:??:??.??????Z'),
            CHECK (old_status != new_status)
        );
        CREATE INDEX idx_approval_changes_site_time ON domain_approval_changes(site_id, changed_at);
        """,
    ),
)


def normalize_utc_timestamp(value: datetime | str | None = None) -> str:
    """Return a fixed-width UTC timestamp, accepting ISO strings with offsets."""
    if value is None:
        parsed = datetime.now(timezone.utc)
    elif isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        except ValueError as exc:
            raise ValueError("timestamp must be a valid ISO-8601 datetime") from exc
    else:
        raise TypeError("timestamp must be a datetime, ISO-8601 string, or None")
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def connect(database: str | Path, *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS) -> sqlite3.Connection:
    """Open a configured connection. Use ``:memory:`` for isolated tests."""
    target = str(database)
    if target != ":memory:":
        Path(target).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    connection = sqlite3.connect(target, timeout=busy_timeout_ms / 1000, isolation_level=None)
    if target != ":memory:" and os.name != "nt":
        Path(target).chmod(0o600)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
    if target != ":memory:":
        mode = connection.execute("PRAGMA journal_mode = WAL").fetchone()[0]
        if str(mode).lower() != "wal":
            connection.close()
            raise sqlite3.OperationalError("could not enable SQLite WAL mode")
        connection.execute("PRAGMA synchronous = NORMAL")
    return connection


def _migration_checksum(sql: str) -> str:
    return hashlib.sha256(sql.encode("utf-8")).hexdigest()


def migrate(connection: sqlite3.Connection) -> None:
    """Apply pending migrations once, refusing checksum drift or partial state."""
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        applied = {
            int(row["version"]): str(row["checksum"])
            for row in connection.execute("SELECT version, checksum FROM schema_migrations")
        }
        known = {version for version, _ in MIGRATIONS}
        if set(applied) - known:
            raise sqlite3.DatabaseError("database contains an unknown migration version")
        for version, sql in MIGRATIONS:
            checksum = _migration_checksum(sql)
            if version in applied:
                if applied[version] != checksum:
                    raise sqlite3.DatabaseError(f"migration {version} checksum mismatch")
                continue
            # Refuse to adopt an untracked/partially-created application schema.
            existing = {
                str(row[0]) for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            if version == 1 and existing - {"schema_migrations"}:
                raise sqlite3.DatabaseError("untracked database schema found; refusing unsafe migration fallback")
            for statement in (part.strip() for part in sql.split(";")):
                if statement:
                    connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)",
                (version, checksum, normalize_utc_timestamp()),
            )
        expected = {
            "devices", "domains", "events", "owners", "owner_sessions", "domain_approval_changes",
            "idx_events_kind_time", "idx_events_site_time", "idx_events_device_time",
            "idx_owner_sessions_owner_expiry", "idx_approval_changes_site_time",
        }
        actual = {
            str(row[0]) for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','index')"
            )
        }
        if expected - actual:
            raise sqlite3.DatabaseError("migrated database schema is incomplete; refusing unsafe fallback")
        connection.commit()
    except Exception:
        connection.rollback()
        raise


@contextmanager
def transaction(connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Provide a short, serialized write transaction (nesting is not supported)."""
    if connection.in_transaction:
        raise sqlite3.ProgrammingError("transaction helper cannot be nested")
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
