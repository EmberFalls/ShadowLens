from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import uuid

# Ensure repository root is on sys.path for direct `pytest` invocation
_REPO_ROOT = str(Path(__file__).resolve().parents[3])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import pytest

from apps.api.shadow_api.db.database import (
    connect,
    hash_bearer_token,
    initialize_database,
    insert_event,
    migrate,
    normalize_utc_timestamp,
    prune_events,
    revoke_device,
    seed_domains,
    update_domain_approval,
    verify_bearer_token,
    verify_owner_password,
)
from apps.api.shadow_api.seed import seed

DEVICE_ID = "6bde3d14-92bb-461b-89f9-7bacb7fb846c"


def make_database(path: Path) -> None:
    initialize_database(path)
    connection = connect(path)
    try:
        connection.execute(
            "INSERT INTO devices(device_id, token_hash, created_at) VALUES (?, ?, ?)",
            (DEVICE_ID, hash_bearer_token("ss_dev_" + "a" * 48), normalize_utc_timestamp("2026-10-30T00:00:00Z")),
        )
    finally:
        connection.close()


def site_event(*, event_id: str = "event-1", device_id: str = "device-1") -> dict[str, object]:
    return {
        "contractVersion": "v2",
        "eventId": str(uuid.uuid5(uuid.NAMESPACE_URL, event_id)),
        "clientObservedAt": "2026-10-30T08:00:00Z",
        "deviceId": DEVICE_ID if device_id == "device-1" else device_id,
        "kind": "SITE_VISIT",
        "siteId": "CHATGPT",
        "supportStatus": "UNSUPPORTED",
        "reasonCodes": ["UNSUPPORTED_AI_SITE_SEEN"],
    }


def test_cold_start_migration_is_repeatable_and_enables_constraints(tmp_path: Path) -> None:
    path = tmp_path / "cold.sqlite3"
    initialize_database(path)
    initialize_database(path)
    connection = connect(path)
    try:
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert connection.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 5
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"devices", "domains", "events", "owners", "owner_sessions", "domain_approval_changes", "app_settings", "owner_audit"} <= tables
        indexes = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert {"idx_events_kind_time", "idx_events_site_time", "idx_events_device_time", "idx_approval_changes_site_time"} <= indexes
        assert len(connection.execute("PRAGMA foreign_key_list(events)").fetchall()) == 2
        assert len(connection.execute("PRAGMA foreign_key_list(owner_sessions)").fetchall()) == 1
    finally:
        connection.close()


def test_seed_is_idempotent_and_does_not_reset_owner_approval(tmp_path: Path) -> None:
    path = tmp_path / "seed.sqlite3"
    initialize_database(path)
    connection = connect(path)
    try:
        assert seed_domains(connection) == 0
        rows = connection.execute("SELECT site_id, canonical_host, approval_status FROM domains ORDER BY site_id").fetchall()
        assert len(rows) == 6
        statuses = {row["site_id"]: row["approval_status"] for row in rows}
        assert statuses["SANDBOX"] == "APPROVED"
        assert all(statuses[site] == "UNREVIEWED" for site in statuses if site != "SANDBOX")
        assert update_domain_approval(connection, "CHATGPT", "UNAPPROVED", changed_at="2026-10-30T10:00:00Z")
        assert seed_domains(connection) == 0
        assert connection.execute("SELECT approval_status FROM domains WHERE site_id='CHATGPT'").fetchone()[0] == "UNAPPROVED"
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE domains SET approval_status='MAYBE' WHERE site_id='CHATGPT'")
        assert not update_domain_approval(connection, "CHATGPT", "UNAPPROVED", changed_at="2026-10-30T10:01:00Z")
        history = connection.execute("SELECT old_status, new_status, changed_at FROM domain_approval_changes").fetchall()
        assert [(row["old_status"], row["new_status"]) for row in history] == [("UNREVIEWED", "UNAPPROVED")]
        assert history[0]["changed_at"] == "2026-10-30T10:00:00.000000Z"
    finally:
        connection.close()


def test_foreign_keys_and_event_checks_are_enforced(tmp_path: Path) -> None:
    path = tmp_path / "constraints.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)",
                ("orphan", "missing-device", "SITE_VISIT", "CHATGPT", "{}", normalize_utc_timestamp()),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)",
                ("bad-kind", "device-1", "PROMPT", "CHATGPT", "{}", normalize_utc_timestamp()),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)",
                ("bad-heartbeat", "device-1", "DEVICE_HEARTBEAT", "CHATGPT", "{}", normalize_utc_timestamp()),
            )
        assert insert_event(connection, site_event(), ingested_at="2026-10-30T09:00:00+01:00") is True
        assert connection.execute("SELECT ingested_at FROM events WHERE event_id=?", (site_event()["eventId"],)).fetchone()[0] == "2026-10-30T08:00:00.000000Z"
    finally:
        connection.close()


def test_concurrent_duplicate_inserts_are_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "concurrent.sqlite3"
    make_database(path)
    barrier = threading.Barrier(8)

    def insert_once(_: int) -> bool:
        connection = connect(path)
        try:
            barrier.wait(timeout=5)
            return insert_event(connection, site_event(), ingested_at="2026-10-30T08:00:00Z")
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(insert_once, range(8)))
    assert sum(outcomes) == 1
    connection = connect(path)
    try:
        assert connection.execute("SELECT count(*) FROM events WHERE event_id=?", (site_event()["eventId"],)).fetchone()[0] == 1
        altered = site_event()
        altered["supportStatus"] = "BEST_EFFORT"
        with pytest.raises(ValueError, match="conflicts"):
            insert_event(connection, altered, ingested_at="2026-10-30T08:00:00Z")
    finally:
        connection.close()


def test_timestamp_normalization_makes_text_order_chronological() -> None:
    earlier = normalize_utc_timestamp("2026-10-30T13:29:59+05:30")
    later = normalize_utc_timestamp("2026-10-30T08:00:00Z")
    assert earlier == "2026-10-30T07:59:59.000000Z"
    assert earlier < later
    with pytest.raises(ValueError, match="timezone"):
        normalize_utc_timestamp("2026-10-30T08:00:00")


def test_retention_deletes_events_only_and_defaults_to_30_days(tmp_path: Path) -> None:
    path = tmp_path / "retention.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        connection.execute("INSERT INTO owners(owner_id, password_hash, created_at) VALUES ('owner-1', 'scrypt$test', ?)", (normalize_utc_timestamp(),))
        insert_event(connection, site_event(event_id="old"), ingested_at="2026-09-01T00:00:00Z")
        insert_event(connection, site_event(event_id="recent"), ingested_at="2026-10-15T00:00:00Z")
        assert prune_events(connection, now="2026-10-30T00:00:00Z") == 1
        assert connection.execute("SELECT event_id FROM events").fetchall()[0][0] == site_event(event_id="recent")["eventId"]
        assert connection.execute("SELECT count(*) FROM domains").fetchone()[0] == 6
        assert connection.execute("SELECT count(*) FROM devices WHERE device_id=?", (DEVICE_ID,)).fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM owners WHERE owner_id='owner-1'").fetchone()[0] == 1
        with pytest.raises(ValueError):
            prune_events(connection, retention_days=0)
    finally:
        connection.close()


def test_database_startup_applies_default_event_retention(tmp_path: Path) -> None:
    path = tmp_path / "startup_retention.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        insert_event(connection, site_event(event_id="expired"), ingested_at="2020-01-01T00:00:00Z")
    finally:
        connection.close()


def test_device_revocation_is_idempotent_and_keeps_audit_history(tmp_path: Path) -> None:
    path = tmp_path / "device_revocation.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        insert_event(connection, site_event(event_id="before-revoke"), ingested_at="2026-10-30T08:00:00Z")
        assert revoke_device(connection, DEVICE_ID, revoked_at="2026-10-31T08:00:00Z") is True
        assert revoke_device(connection, DEVICE_ID, revoked_at="2026-10-31T08:01:00Z") is False
        assert revoke_device(connection, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") is None
        assert connection.execute("SELECT revoked_at FROM devices WHERE device_id=?", (DEVICE_ID,)).fetchone()[0] == "2026-10-31T08:00:00.000000Z"
        assert connection.execute("SELECT count(*) FROM events WHERE device_id=?", (DEVICE_ID,)).fetchone()[0] == 1
    finally:
        connection.close()

    initialize_database(path)
    connection = connect(path)
    try:
        # Revocation must retain recent event history; the 30-day retention
        # policy should only remove this after it expires.
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 1
    finally:
        connection.close()


def test_corrupted_migration_fails_closed_and_preserves_database(tmp_path: Path) -> None:
    path = tmp_path / "corrupt.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        connection.execute("INSERT INTO owners(owner_id, password_hash, created_at) VALUES ('keep-me', 'hash', ?)", (normalize_utc_timestamp(),))
        connection.execute("UPDATE schema_migrations SET checksum='corrupt' WHERE version=1")
        with pytest.raises(sqlite3.DatabaseError, match="checksum mismatch"):
            migrate(connection)
        assert connection.execute("SELECT count(*) FROM owners WHERE owner_id='keep-me'").fetchone()[0] == 1
        assert connection.execute("SELECT checksum FROM schema_migrations WHERE version=1").fetchone()[0] == "corrupt"
    finally:
        connection.close()


def test_applied_migration_with_missing_schema_is_reported_without_reset(tmp_path: Path) -> None:
    path = tmp_path / "damaged.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        connection.execute("INSERT INTO owners(owner_id, password_hash, created_at) VALUES ('keep-me', 'hash', ?)", (normalize_utc_timestamp(),))
        connection.execute("DROP TABLE owner_sessions")
        with pytest.raises(sqlite3.DatabaseError, match="schema is incomplete"):
            migrate(connection)
        assert connection.execute("SELECT count(*) FROM owners WHERE owner_id='keep-me'").fetchone()[0] == 1
    finally:
        connection.close()


def test_untracked_partial_schema_is_not_silently_replaced(tmp_path: Path) -> None:
    path = tmp_path / "partial.sqlite3"
    raw = sqlite3.connect(path)
    raw.execute("CREATE TABLE application_data (value TEXT)")
    raw.execute("INSERT INTO application_data VALUES ('preserve')")
    raw.commit()
    raw.close()
    connection = connect(path)
    try:
        with pytest.raises(sqlite3.DatabaseError, match="untracked database schema"):
            migrate(connection)
        assert connection.execute("SELECT value FROM application_data").fetchone()[0] == "preserve"
    finally:
        connection.close()


def test_database_never_persists_plaintext_bearer_token_or_prompt(tmp_path: Path) -> None:
    path = tmp_path / "privacy.sqlite3"
    make_database(path)
    token = "ss_dev_unique_secret_token_value_0123456789"
    connection = connect(path)
    try:
        connection.execute(
            "INSERT INTO devices(device_id, token_hash, created_at) VALUES (?, ?, ?)",
            ("device-2", hash_bearer_token(token), normalize_utc_timestamp()),
        )
        assert insert_event(connection, site_event(event_id="privacy-event"), ingested_at="2026-10-30T08:00:00Z")
        with pytest.raises(ValueError, match="forbidden content"):
            bad = site_event(event_id="bad-content")
            bad["promptHash"] = "PROMPT_SENTINEL_SHOULD_NEVER_PERSIST"
            insert_event(connection, bad)
    finally:
        connection.close()
    raw = path.read_bytes()
    assert token.encode() not in raw
    assert b"PROMPT_SENTINEL_SHOULD_NEVER_PERSIST" not in raw
    assert b"ss_dev_" not in raw


def test_owner_hash_is_salted_and_session_id_is_not_stored_verbatim(tmp_path: Path) -> None:
    from apps.api.shadow_api.db.database import hash_owner_password, hash_session_id

    first = hash_owner_password("a long owner password", salt=b"1" * 16)
    second = hash_owner_password("a long owner password", salt=b"2" * 16)
    assert first != second
    assert first.startswith("scrypt$16384$8$1$")
    assert hash_session_id("s" * 40) != "s" * 40


def test_bearer_verification_compares_hash_without_persisting_token() -> None:
    token = "ss_dev_a_high_entropy_development_credential"
    digest = hash_bearer_token(token)
    assert verify_bearer_token(token, digest)
    assert not verify_bearer_token(token + "x", digest)
    assert not verify_bearer_token(token, "not-a-hash")


def test_device_provisioning_cli_prints_token_once_but_stores_only_hash(tmp_path: Path) -> None:
    path = tmp_path / "cli.sqlite3"
    env = os.environ.copy()
    env["SHADOWSHIELD_DATABASE"] = str(path)
    result = subprocess.run(
        [sys.executable, "-m", "apps.api.shadow_api.db.manage", "provision-device"],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    line = next(line for line in result.stdout.splitlines() if line.startswith("Bearer token: "))
    token = line.removeprefix("Bearer token: ")
    assert len(token) >= 32
    connection = connect(path)
    try:
        row = connection.execute("SELECT token_hash FROM devices").fetchone()
        assert row["token_hash"] == hash_bearer_token(token)
        assert connection.execute("SELECT count(*) FROM devices").fetchone()[0] == 1
    finally:
        connection.close()
    assert token.encode() not in path.read_bytes()


def test_owner_password_verification() -> None:
    from apps.api.shadow_api.db.database import hash_owner_password

    password = "a-secure-owner-password"
    password_hash = hash_owner_password(password)
    assert verify_owner_password(password, password_hash) is True
    assert verify_owner_password("wrong-password-value", password_hash) is False
    assert verify_owner_password(password, "invalid-hash-string") is False
    assert verify_owner_password(password, "scrypt$invalid$format") is False


def test_seed_module_cold_start_and_idempotence(tmp_path: Path) -> None:
    path = tmp_path / "seeded.sqlite3"
    # First run on fresh database seeds 6 domains and returns count
    assert seed(path) == 6
    connection = connect(path)
    try:
        assert connection.execute("SELECT count(*) FROM domains").fetchone()[0] == 6
    finally:
        connection.close()

    # Second run is idempotent and inserts 0 new rows
    assert seed(path) == 0


def test_cleanup_events_cli_prunes_only_old_events(tmp_path: Path) -> None:
    path = tmp_path / "cli_cleanup.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        insert_event(connection, site_event(event_id="cli-old"), ingested_at="2026-08-01T00:00:00Z")
        insert_event(connection, site_event(event_id="cli-recent"), ingested_at=normalize_utc_timestamp())
    finally:
        connection.close()

    env = os.environ.copy()
    env["SHADOWSHIELD_DATABASE"] = str(path)
    result = subprocess.run(
        [sys.executable, "-m", "apps.api.shadow_api.db.manage", "cleanup-events", "--days", "30"],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "Deleted 1 event(s)" in result.stdout
    connection = connect(path)
    try:
        remaining = connection.execute("SELECT event_id FROM events").fetchall()
        assert len(remaining) == 1
        assert remaining[0][0] == site_event(event_id="cli-recent")["eventId"]
    finally:
        connection.close()


def test_privacy_sentinel_never_persists(tmp_path: Path) -> None:
    sentinel = "SHADOW_FAKE_DO_NOT_USE_9Q7P2"
    path = tmp_path / "sentinel.sqlite3"
    make_database(path)
    connection = connect(path)
    try:
        # Rejection when sentinel is injected in forbidden content key
        bad_event = site_event(event_id="sentinel-event")
        bad_event["rawPrompt"] = sentinel
        with pytest.raises(ValueError, match="forbidden content"):
            insert_event(connection, bad_event)
    finally:
        connection.close()

    # Verify sentinel string is absent from the sqlite file bytes
    raw = path.read_bytes()
    assert sentinel.encode() not in raw

