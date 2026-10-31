"""SQLite schema, migrations, and privacy-preserving event storage.

The database is intentionally a single-process local-demo store. Callers own
the connection lifetime; each connection enables foreign keys and a busy
timeout. Timestamps written here are fixed-width UTC ISO strings so lexical
ordering is chronological ordering.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
from pathlib import Path
from typing import Any, Iterator, Mapping
import uuid

DEFAULT_RETENTION_DAYS = 30
DEFAULT_BUSY_TIMEOUT_MS = 5_000
_ROOT = Path(__file__).resolve().parents[4]
_REGISTRY_PATH = _ROOT / "packages" / "contracts" / "domain-registry.json"

_EVENT_FIELDS: dict[str, frozenset[str]] = {
    "SUBMISSION": frozenset({
        "contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "siteId",
        "coverageMode", "decisionAction", "disposition", "aggregateTier", "scoreBand",
        "categoryCounts", "policyRevision", "engineVersion", "lengthBand", "reasonCodes",
    }),
    "SITE_VISIT": frozenset({
        "contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "siteId",
        "supportStatus", "reasonCodes",
    }),
    "DEVICE_HEARTBEAT": frozenset({
        "contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "extensionVersion",
    }),
}
_FORBIDDEN_KEY = re.compile(r"(?:prompt|raw.?text|matched.?value|snippet|filename|file.?name|prompt.?hash)", re.I)
_SITE_IDS = {"SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"}
_REASON_CODES = {
    "DETECTED_PII", "DETECTED_SECRET", "DETECTED_CONFIDENTIAL", "DETECTED_SOURCE_CODE", "DETECTED_BULK",
    "DETECTED_CUSTOM_TERM", "POLICY_ALLOW", "POLICY_WARN", "POLICY_REDACT", "POLICY_BLOCK",
    "POLICY_FALLBACK_WARN", "USER_CANCELLED", "USER_ACKNOWLEDGED", "USER_APPROVED_REDACTION",
    "REDACTION_RESIDUAL", "RELEASE_WRITE_MISMATCH", "EDITOR_CHANGED", "SCANNER_TIMEOUT",
    "INPUT_TOO_LONG", "INVALID_POLICY", "ENGINE_FAILURE", "BACKEND_OFFLINE", "UNSUPPORTED_AI_SITE_SEEN",
    "UPLOAD_UNINSPECTED", "PAGE_ACK_RECEIVED", "PAGE_ACK_TIMEOUT",
}
_CATEGORY_CODES = {
    "PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN",
    "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER",
    "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST",
}
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")

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
    (
        2,
        """
        CREATE TABLE app_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL,
            updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z')
        );
        INSERT INTO app_settings(setting_key, setting_value, updated_at)
        VALUES ('event_retention_days', '30', strftime('%Y-%m-%dT%H:%M:%f000Z', 'now'));

        CREATE TABLE owner_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL CHECK (action IN ('RETENTION_CHANGED','EVENTS_DELETED')),
            detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
            changed_at TEXT NOT NULL CHECK (changed_at GLOB '????-??-??T??:??:??.??????Z')
        );
        CREATE INDEX idx_owner_audit_time ON owner_audit(changed_at);
        """,
    ),
    (
        3,
        """
        CREATE TABLE owner_audit_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL CHECK (action IN ('RETENTION_CHANGED','EVENTS_DELETED','DEVICE_ENROLLED','DEVICE_REVOKED')),
            detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
            changed_at TEXT NOT NULL CHECK (changed_at GLOB '????-??-??T??:??:??.??????Z')
        );
        INSERT INTO owner_audit_v3(id, action, detail_json, changed_at)
        SELECT id, action, detail_json, changed_at FROM owner_audit;
        DROP TABLE owner_audit;
        ALTER TABLE owner_audit_v3 RENAME TO owner_audit;
        CREATE INDEX idx_owner_audit_time ON owner_audit(changed_at);
        """,
    ),
    (
        4,
        """
        CREATE TABLE owner_audit_v4 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL CHECK (action IN ('RETENTION_CHANGED','EVENTS_DELETED','DEVICE_ENROLLED','DEVICE_REVOKED','POLICY_UPDATED')),
            detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
            changed_at TEXT NOT NULL CHECK (changed_at GLOB '????-??-??T??:??:??.??????Z')
        );
        INSERT INTO owner_audit_v4(id, action, detail_json, changed_at)
        SELECT id, action, detail_json, changed_at FROM owner_audit;
        DROP TABLE owner_audit;
        ALTER TABLE owner_audit_v4 RENAME TO owner_audit;
        CREATE INDEX idx_owner_audit_time ON owner_audit(changed_at);
        """,
    ),
    (
        5,
        """
        CREATE TABLE auth_login_limits (
            subject_hash TEXT PRIMARY KEY CHECK (length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*'),
            failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 1 AND 5),
            window_started_at TEXT NOT NULL CHECK (window_started_at GLOB '????-??-??T??:??:??.??????Z'),
            blocked_until TEXT CHECK (blocked_until IS NULL OR blocked_until GLOB '????-??-??T??:??:??.??????Z'),
            updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z')
        );
        CREATE INDEX idx_auth_login_limits_updated ON auth_login_limits(updated_at);
        """,
    ),
    (
        6,
        """
        ALTER TABLE devices ADD COLUMN last_event_at TEXT CHECK (last_event_at IS NULL OR last_event_at GLOB '????-??-??T??:??:??.??????Z');
        ALTER TABLE devices ADD COLUMN extension_version TEXT CHECK (extension_version IS NULL OR length(extension_version) BETWEEN 1 AND 32);
        ALTER TABLE devices ADD COLUMN extension_version_at TEXT CHECK (extension_version_at IS NULL OR extension_version_at GLOB '????-??-??T??:??:??.??????Z');
        ALTER TABLE devices ADD COLUMN policy_revision INTEGER CHECK (policy_revision IS NULL OR policy_revision >= 1);
        ALTER TABLE devices ADD COLUMN engine_version TEXT CHECK (engine_version IS NULL OR length(engine_version) BETWEEN 1 AND 32);
        ALTER TABLE devices ADD COLUMN last_submission_at TEXT CHECK (last_submission_at IS NULL OR last_submission_at GLOB '????-??-??T??:??:??.??????Z');
        ALTER TABLE devices ADD COLUMN last_scanner_result TEXT CHECK (last_scanner_result IS NULL OR last_scanner_result IN ('SCAN_REPORTED','FAILED_SAFE'));
        UPDATE devices SET
            last_event_at = (SELECT MAX(ingested_at) FROM events WHERE device_id = devices.device_id),
            extension_version = (SELECT json_extract(payload_json, '$.extensionVersion') FROM events WHERE device_id = devices.device_id AND kind = 'DEVICE_HEARTBEAT' ORDER BY ingested_at DESC, event_id DESC LIMIT 1),
            extension_version_at = (SELECT MAX(ingested_at) FROM events WHERE device_id = devices.device_id AND kind = 'DEVICE_HEARTBEAT'),
            policy_revision = (SELECT json_extract(payload_json, '$.policyRevision') FROM events WHERE device_id = devices.device_id AND kind = 'SUBMISSION' ORDER BY ingested_at DESC, event_id DESC LIMIT 1),
            engine_version = (SELECT json_extract(payload_json, '$.engineVersion') FROM events WHERE device_id = devices.device_id AND kind = 'SUBMISSION' ORDER BY ingested_at DESC, event_id DESC LIMIT 1),
            last_submission_at = (SELECT MAX(ingested_at) FROM events WHERE device_id = devices.device_id AND kind = 'SUBMISSION'),
            last_scanner_result = CASE
                WHEN NOT EXISTS (SELECT 1 FROM events WHERE device_id = devices.device_id AND kind = 'SUBMISSION') THEN NULL
                WHEN (SELECT json_extract(payload_json, '$.disposition') FROM events WHERE device_id = devices.device_id AND kind = 'SUBMISSION' ORDER BY ingested_at DESC, event_id DESC LIMIT 1) = 'FAILED_SAFE' THEN 'FAILED_SAFE'
                ELSE 'SCAN_REPORTED'
            END;
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
            "idx_owner_sessions_owner_expiry", "idx_approval_changes_site_time", "app_settings",
            "owner_audit", "idx_owner_audit_time",
            "auth_login_limits", "idx_auth_login_limits_updated",
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


def login_block_remaining(connection: sqlite3.Connection, subject_hash: str, *, now: datetime | None = None) -> int:
    """Return active login lockout seconds for a keyed, non-identifying subject hash."""
    current = normalize_utc_timestamp(now)
    row = connection.execute(
        "SELECT blocked_until FROM auth_login_limits WHERE subject_hash = ?", (subject_hash,)
    ).fetchone()
    if row is None or row["blocked_until"] is None or str(row["blocked_until"]) <= current:
        return 0
    blocked_until = datetime.fromisoformat(str(row["blocked_until"]).replace("Z", "+00:00"))
    current_dt = datetime.fromisoformat(current.replace("Z", "+00:00"))
    return max(1, int((blocked_until - current_dt).total_seconds() + 0.999))


def record_login_failure(connection: sqlite3.Connection, subject_hash: str, *, now: datetime | None = None) -> int:
    """Record a failed login; return seconds of lockout when threshold is reached."""
    current_dt = now or datetime.now(timezone.utc)
    current = normalize_utc_timestamp(current_dt)
    with transaction(connection):
        connection.execute(
            "DELETE FROM auth_login_limits WHERE updated_at < ?",
            (normalize_utc_timestamp(current_dt - timedelta(days=1)),),
        )
        row = connection.execute(
            "SELECT failure_count, window_started_at, blocked_until FROM auth_login_limits WHERE subject_hash = ?",
            (subject_hash,),
        ).fetchone()
        if row is not None and row["blocked_until"] and str(row["blocked_until"]) > current:
            blocked = datetime.fromisoformat(str(row["blocked_until"]).replace("Z", "+00:00"))
            return max(1, int((blocked - current_dt.astimezone(timezone.utc)).total_seconds() + 0.999))
        window_start = current
        failures = 1
        if row is not None:
            previous_window = datetime.fromisoformat(str(row["window_started_at"]).replace("Z", "+00:00"))
            if current_dt.astimezone(timezone.utc) - previous_window < timedelta(minutes=15):
                window_start = str(row["window_started_at"])
                failures = int(row["failure_count"]) + 1
        blocked_until = normalize_utc_timestamp(current_dt + timedelta(minutes=15)) if failures >= 5 else None
        connection.execute(
            "INSERT INTO auth_login_limits(subject_hash, failure_count, window_started_at, blocked_until, updated_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject_hash) DO UPDATE SET "
            "failure_count=excluded.failure_count, window_started_at=excluded.window_started_at, "
            "blocked_until=excluded.blocked_until, updated_at=excluded.updated_at",
            (subject_hash, min(failures, 5), window_start, blocked_until, current),
        )
    return 900 if blocked_until is not None else 0


def clear_login_failures(connection: sqlite3.Connection, subject_hash: str) -> None:
    with transaction(connection):
        connection.execute("DELETE FROM auth_login_limits WHERE subject_hash = ?", (subject_hash,))


def _registry_sites(registry_path: str | Path | None = None) -> list[dict[str, Any]]:
    path = Path(registry_path) if registry_path is not None else _REGISTRY_PATH
    registry = json.loads(path.read_text(encoding="utf-8"))
    if registry.get("contractVersion") != "v2" or not isinstance(registry.get("sites"), list):
        raise ValueError("invalid frozen domain registry")
    seen: set[str] = set()
    sites: list[dict[str, Any]] = []
    for site in registry["sites"]:
        site_id, hosts = site.get("siteId"), site.get("hosts")
        if not isinstance(site_id, str) or site_id in seen or not isinstance(hosts, list) or not hosts:
            raise ValueError("invalid frozen domain registry entry")
        host = hosts[0]
        if not isinstance(host, str) or not host or any(c in host for c in "/:@?#"):
            raise ValueError("invalid canonical host in domain registry")
        seen.add(site_id)
        sites.append({"site_id": site_id, "canonical_host": host.lower()})
    if seen != {"SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"}:
        raise ValueError("domain registry site IDs do not match the v2 contract")
    return sites


def seed_domains(connection: sqlite3.Connection, registry_path: str | Path | None = None) -> int:
    """Insert frozen sites without resetting owner-managed approval states."""
    now = normalize_utc_timestamp()
    inserted = 0
    with transaction(connection):
        for site in _registry_sites(registry_path):
            status = "APPROVED" if site["site_id"] == "SANDBOX" else "UNREVIEWED"
            cursor = connection.execute(
                "INSERT INTO domains(site_id, canonical_host, approval_status, updated_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO NOTHING",
                (site["site_id"], site["canonical_host"], status, now),
            )
            inserted += cursor.rowcount
    return inserted


def initialize_database(
    database: str | Path,
    *,
    registry_path: str | Path | None = None,
    prune_expired: bool = True,
) -> None:
    connection = connect(database)
    try:
        migrate(connection)
        seed_domains(connection, registry_path)
        # Enforce retention on service and normal CLI startup. The explicit
        # cleanup command skips this automatic pass so it can report its count.
        if prune_expired:
            prune_events(connection, retention_days=get_retention_days(connection))
            connection.execute(
                "DELETE FROM auth_login_limits WHERE updated_at < ?",
                (normalize_utc_timestamp(datetime.now(timezone.utc) - timedelta(days=1)),),
            )
    finally:
        connection.close()


def _check_event_privacy(value: Any) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str) or _FORBIDDEN_KEY.search(key):
                raise ValueError("event contains a forbidden content field")
            _check_event_privacy(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _check_event_privacy(child)


def _validate_event_values(event: Mapping[str, Any], kind: str) -> None:
    for field in ("eventId", "deviceId"):
        value = event.get(field)
        if not isinstance(value, str) or not _UUID_RE.fullmatch(value):
            raise ValueError(f"event {field} must be a UUID")
        uuid.UUID(value)
    observed = event.get("clientObservedAt")
    if not isinstance(observed, str) or not _UTC_RE.fullmatch(observed):
        raise ValueError("clientObservedAt must be a UTC ISO timestamp")
    normalize_utc_timestamp(observed)
    if kind == "SITE_VISIT":
        if event.get("siteId") not in _SITE_IDS or event.get("supportStatus") not in {"GUARDED", "BEST_EFFORT", "UNSUPPORTED"}:
            raise ValueError("invalid site visit metadata")
        reasons = event.get("reasonCodes")
        if not isinstance(reasons, list) or any(reason not in {"UNSUPPORTED_AI_SITE_SEEN"} for reason in reasons):
            raise ValueError("invalid site visit reason codes")
    elif kind == "DEVICE_HEARTBEAT":
        version = event.get("extensionVersion")
        if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9.+_-]{1,32}", version):
            raise ValueError("invalid extension version")
    else:
        enums = {
            "siteId": _SITE_IDS,
            "coverageMode": {"SANDBOX_GUARDED", "THIRD_PARTY_BEST_EFFORT", "UNSUPPORTED"},
            "decisionAction": {"ALLOW", "WARN", "REDACT", "BLOCK", None},
            "disposition": {"CANCELLED", "BLOCKED", "FAILED_SAFE", "RELEASED_UNVERIFIED", "PAGE_ATTESTED"},
            "aggregateTier": {"NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "NOT_EVALUATED"},
            "scoreBand": {"ZERO", "LOW", "MEDIUM", "HIGH", "CRITICAL", "NOT_EVALUATED"},
            "lengthBand": {"EMPTY", "1_99", "100_999", "1000_PLUS"},
        }
        if any(event.get(field) not in allowed for field, allowed in enums.items()):
            raise ValueError("invalid submission enum value")
        reasons = event.get("reasonCodes")
        counts = event.get("categoryCounts")
        revision = event.get("policyRevision")
        engine_version = event.get("engineVersion")
        if not isinstance(reasons, list) or len(reasons) > 8 or any(reason not in _REASON_CODES for reason in reasons):
            raise ValueError("invalid submission reason codes")
        if not isinstance(counts, dict) or any(
            category not in _CATEGORY_CODES or not isinstance(count, int) or isinstance(count, bool) or count < 0
            for category, count in counts.items()
        ):
            raise ValueError("invalid category counts")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise ValueError("invalid policy revision")
        if not isinstance(engine_version, str) or not re.fullmatch(r"[A-Za-z0-9.+_-]{1,32}", engine_version):
            raise ValueError("invalid engine version")


def record_device_runtime_metadata(
    connection: sqlite3.Connection,
    event: Mapping[str, Any],
    *,
    ingested_at: datetime | str,
) -> None:
    """Update the minimal per-device runtime projection for a newly inserted event.

    Call only inside the same transaction that inserts the validated event.
    These allowlisted fields survive normal event pruning but are cleared when
    the owner explicitly deletes event history.
    """
    kind = event.get("kind")
    device_id = event.get("deviceId")
    if kind not in _EVENT_FIELDS or not isinstance(device_id, str):
        raise ValueError("cannot project an invalid device event")
    timestamp = normalize_utc_timestamp(ingested_at)
    connection.execute(
        "UPDATE devices SET last_event_at = CASE WHEN last_event_at IS NULL OR last_event_at < ? THEN ? ELSE last_event_at END "
        "WHERE device_id = ?",
        (timestamp, timestamp, device_id),
    )
    if kind == "DEVICE_HEARTBEAT":
        connection.execute(
            "UPDATE devices SET last_heartbeat_at = CASE WHEN last_heartbeat_at IS NULL OR last_heartbeat_at < ? THEN ? ELSE last_heartbeat_at END, "
            "extension_version = CASE WHEN extension_version_at IS NULL OR extension_version_at <= ? THEN ? ELSE extension_version END, "
            "extension_version_at = CASE WHEN extension_version_at IS NULL OR extension_version_at <= ? THEN ? ELSE extension_version_at END "
            "WHERE device_id = ?",
            (timestamp, timestamp, timestamp, event["extensionVersion"], timestamp, timestamp, device_id),
        )
    elif kind == "SUBMISSION":
        scanner_result = "FAILED_SAFE" if event["disposition"] == "FAILED_SAFE" else "SCAN_REPORTED"
        connection.execute(
            "UPDATE devices SET policy_revision = ?, engine_version = ?, last_scanner_result = ?, last_submission_at = ? "
            "WHERE device_id = ? AND (last_submission_at IS NULL OR last_submission_at <= ?)",
            (event["policyRevision"], event["engineVersion"], scanner_result, timestamp, device_id, timestamp),
        )


def insert_event(connection: sqlite3.Connection, event: Mapping[str, Any], *, ingested_at: datetime | str | None = None) -> bool:
    """Atomically insert one allowlisted event; return False for a duplicate ID.

    Caller-side schema validation remains authoritative. This persistence seam
    additionally refuses unknown fields so content cannot accidentally enter
    the database if a caller skips or weakens that validation.
    """
    _check_event_privacy(event)
    kind = event.get("kind")
    if kind not in _EVENT_FIELDS:
        raise ValueError("unsupported event kind")
    if set(event) != _EVENT_FIELDS[kind]:
        raise ValueError("event fields do not match the frozen v2 variant")
    _validate_event_values(event, kind)
    if event.get("contractVersion") != "v2":
        raise ValueError("unsupported event contract version")
    device_id, event_id = event.get("deviceId"), event.get("eventId")
    site_id = event.get("siteId")
    if not isinstance(device_id, str) or not isinstance(event_id, str):
        raise ValueError("event identifiers must be strings")
    if kind != "DEVICE_HEARTBEAT" and not isinstance(site_id, str):
        raise ValueError("site event requires a site ID")
    if kind == "DEVICE_HEARTBEAT" and site_id is not None:
        raise ValueError("heartbeat cannot have a site ID")
    ingested = normalize_utc_timestamp(ingested_at)
    payload = json.dumps(dict(event), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    with transaction(connection):
        cursor = connection.execute(
            "INSERT INTO events(event_id, device_id, kind, site_id, payload_json, ingested_at) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
            (event_id, device_id, kind, site_id, payload, ingested),
        )
        inserted = cursor.rowcount == 1
        if not inserted:
            existing = connection.execute(
                "SELECT device_id, payload_json FROM events WHERE event_id = ?", (event_id,)
            ).fetchone()
            if existing is None or existing["device_id"] != device_id or existing["payload_json"] != payload:
                raise ValueError("event ID conflicts with a different stored event")
        if inserted:
            record_device_runtime_metadata(connection, event, ingested_at=ingested)
    return inserted


def prune_events(
    connection: sqlite3.Connection,
    *,
    now: datetime | str | None = None,
    retention_days: int = DEFAULT_RETENTION_DAYS,
) -> int:
    """Delete expired event rows only; return the number removed."""
    if not isinstance(retention_days, int) or isinstance(retention_days, bool) or retention_days < 1:
        raise ValueError("retention_days must be a positive integer")
    cutoff = datetime.fromisoformat(normalize_utc_timestamp(now).replace("Z", "+00:00")) - timedelta(days=retention_days)
    cutoff_text = normalize_utc_timestamp(cutoff)
    with transaction(connection):
        cursor = connection.execute("DELETE FROM events WHERE ingested_at < ?", (cutoff_text,))
    return cursor.rowcount


def get_retention_days(connection: sqlite3.Connection) -> int:
    """Read the persisted metadata-retention window, failing closed on drift."""
    row = connection.execute(
        "SELECT setting_value FROM app_settings WHERE setting_key='event_retention_days'"
    ).fetchone()
    if row is None:
        raise sqlite3.DatabaseError("event retention setting is missing")
    try:
        days = int(row["setting_value"])
    except (TypeError, ValueError) as exc:
        raise sqlite3.DatabaseError("event retention setting is invalid") from exc
    if not 1 <= days <= 3650:
        raise sqlite3.DatabaseError("event retention setting is outside its allowed range")
    return days


def set_retention_days(connection: sqlite3.Connection, retention_days: int, *, changed_at: datetime | str | None = None) -> tuple[int, int]:
    """Persist retention and prune expired events atomically; return old setting and count."""
    if not isinstance(retention_days, int) or isinstance(retention_days, bool) or not 1 <= retention_days <= 3650:
        raise ValueError("retention_days must be an integer between 1 and 3650")
    timestamp = normalize_utc_timestamp(changed_at)
    with transaction(connection):
        previous = get_retention_days(connection)
        connection.execute(
            "UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='event_retention_days'",
            (str(retention_days), timestamp),
        )
        if previous != retention_days:
            connection.execute(
                "INSERT INTO owner_audit(action, detail_json, changed_at) VALUES ('RETENTION_CHANGED', ?, ?)",
                (json.dumps({"previousDays": previous, "retentionDays": retention_days}, separators=(",", ":")), timestamp),
            )
        cutoff = datetime.fromisoformat(timestamp.replace("Z", "+00:00")) - timedelta(days=retention_days)
        deleted = connection.execute(
            "DELETE FROM events WHERE ingested_at < ?", (normalize_utc_timestamp(cutoff),)
        ).rowcount
    return previous, deleted


def delete_all_events(connection: sqlite3.Connection, *, changed_at: datetime | str | None = None) -> int:
    """Delete sanitized event telemetry while retaining enrollment and tool policy records."""
    timestamp = normalize_utc_timestamp(changed_at)
    with transaction(connection):
        deleted = connection.execute("DELETE FROM events").rowcount
        connection.execute(
            "UPDATE devices SET last_heartbeat_at=NULL, last_event_at=NULL, extension_version=NULL, "
            "extension_version_at=NULL, policy_revision=NULL, engine_version=NULL, last_submission_at=NULL, last_scanner_result=NULL"
        )
        connection.execute(
            "INSERT INTO owner_audit(action, detail_json, changed_at) VALUES ('EVENTS_DELETED', ?, ?)",
            (json.dumps({"deletedEvents": deleted}, separators=(",", ":")), timestamp),
        )
    return deleted


def revoke_device(
    connection: sqlite3.Connection,
    device_id: str,
    *,
    revoked_at: datetime | str | None = None,
) -> bool | None:
    """Revoke one enrolled device without deleting its sanitized audit history.

    Returns True when this call revoked an active device, False when it was
    already revoked, and None when the device ID is unknown.
    """
    timestamp = normalize_utc_timestamp(revoked_at)
    with transaction(connection):
        row = connection.execute("SELECT revoked_at FROM devices WHERE device_id=?", (device_id,)).fetchone()
        if row is None:
            return None
        if row["revoked_at"] is not None:
            return False
        connection.execute("UPDATE devices SET revoked_at=? WHERE device_id=?", (timestamp, device_id))
        connection.execute(
            "INSERT INTO owner_audit(action, detail_json, changed_at) VALUES ('DEVICE_REVOKED', ?, ?)",
            (json.dumps({"deviceId": device_id}, separators=(",", ":")), timestamp),
        )
    return True


def provision_device(connection: sqlite3.Connection, label: str) -> tuple[str, str]:
    """Create one active device and return its high-entropy bearer token once."""
    if not isinstance(label, str) or not label.strip() or len(label.strip()) > 100 or re.search(r"[\x00-\x1f\x7f]", label):
        raise ValueError("device label must contain 1 to 100 printable characters")
    with transaction(connection):
        active_count = int(connection.execute("SELECT count(*) FROM devices WHERE revoked_at IS NULL").fetchone()[0])
        if active_count >= 100:
            raise ValueError("active device limit reached")
        device_id = str(uuid.uuid4())
        token = "ss_dev_" + secrets.token_urlsafe(36)
        connection.execute(
            "INSERT INTO devices(device_id, token_hash, device_label, created_at) VALUES (?, ?, ?, ?)",
            (device_id, hash_bearer_token(token), label.strip(), normalize_utc_timestamp()),
        )
        connection.execute(
            "INSERT INTO owner_audit(action, detail_json, changed_at) VALUES ('DEVICE_ENROLLED', ?, ?)",
            (json.dumps({"deviceId": device_id}, separators=(",", ":")), normalize_utc_timestamp()),
        )
    return device_id, token


def update_domain_approval(
    connection: sqlite3.Connection,
    site_id: str,
    approval_status: str,
    *,
    changed_at: datetime | str | None = None,
) -> bool:
    """Update an informational approval and append its history atomically."""
    allowed = {"APPROVED", "UNAPPROVED", "UNREVIEWED"}
    if approval_status not in allowed:
        raise ValueError("invalid domain approval status")
    timestamp = normalize_utc_timestamp(changed_at)
    with transaction(connection):
        current = connection.execute(
            "SELECT approval_status FROM domains WHERE site_id = ?", (site_id,)
        ).fetchone()
        if current is None:
            raise ValueError("unknown site ID")
        old_status = str(current["approval_status"])
        if old_status == approval_status:
            return False
        connection.execute(
            "UPDATE domains SET approval_status = ?, updated_at = ? WHERE site_id = ?",
            (approval_status, timestamp, site_id),
        )
        connection.execute(
            "INSERT INTO domain_approval_changes(site_id, old_status, new_status, changed_at) VALUES (?, ?, ?, ?)",
            (site_id, old_status, approval_status, timestamp),
        )
    return True


def hash_bearer_token(token: str) -> str:
    """Hash a high-entropy bearer token for indexed lookup/comparison."""
    if not isinstance(token, str) or len(token) < 32:
        raise ValueError("bearer token must contain at least 32 characters")
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_bearer_token(token: str, stored_hash: str) -> bool:
    """Compare a presented token with its stored digest in constant time."""
    if not isinstance(stored_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", stored_hash):
        return False
    try:
        candidate = hash_bearer_token(token)
    except ValueError:
        return False
    return hmac.compare_digest(candidate, stored_hash)


def hash_owner_password(password: str, *, salt: bytes | None = None) -> str:
    """Hash an owner password using Python's built-in scrypt implementation."""
    if not isinstance(password, str) or len(password) < 12:
        raise ValueError("owner password must contain at least 12 characters")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${digest.hex()}"


def verify_owner_password(password: str, stored_hash: str) -> bool:
    """Verify an owner password against its stored scrypt hash in constant time."""
    if not isinstance(stored_hash, str) or not stored_hash.startswith("scrypt$"):
        return False
    parts = stored_hash.split("$")
    if len(parts) != 6:
        return False
    _, n_str, r_str, p_str, salt_hex, digest_hex = parts
    try:
        n, r, p = int(n_str), int(r_str), int(p_str)
        salt = bytes.fromhex(salt_hex)
        expected_digest = bytes.fromhex(digest_hex)
        candidate = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=len(expected_digest))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate, expected_digest)


def hash_session_id(session_id: str) -> str:
    """Store only the digest of a random owner session identifier."""
    if not isinstance(session_id, str) or len(session_id) < 32:
        raise ValueError("session identifier must contain at least 32 characters")
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


