"""Developer commands for initializing, provisioning, and pruning SQLite data.

Examples (from the repository root):
  python -m apps.api.shadow_api.db.manage init
  python -m apps.api.shadow_api.db.manage provision-device
  python -m apps.api.shadow_api.db.manage provision-owner
  python -m apps.api.shadow_api.db.manage cleanup-events

Set SHADOWSHIELD_DATABASE to select a database file. The generated device
token is printed once after its hash has been committed; it is never stored.
"""

from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import getpass
import os
from pathlib import Path
import sqlite3
import shutil
import tempfile
import sys
import secrets
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

try:
    from .database import (
        connect,
        get_retention_days,
        hash_owner_password,
        initialize_database,
        normalize_utc_timestamp,
        prune_events,
        provision_device,
        transaction,
    )
    from ..services.policy_signing import PolicySigner
except ImportError:
    _root = Path(__file__).resolve().parents[4]
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))
    from apps.api.shadow_api.db.database import (
        connect,
        get_retention_days,
        hash_owner_password,
        initialize_database,
        normalize_utc_timestamp,
        prune_events,
        provision_device,
        transaction,
    )
    from apps.api.shadow_api.services.policy_signing import PolicySigner

DEFAULT_DATABASE = Path.home() / ".shadowshield" / "shadowshield.sqlite3"


def database_path() -> Path:
    return Path(os.environ.get("SHADOWSHIELD_DATABASE", str(DEFAULT_DATABASE))).expanduser().resolve()


def policy_key_path(database: Path) -> Path:
    configured = os.environ.get("SHADOWSHIELD_POLICY_SIGNING_KEY")
    return Path(configured).expanduser().resolve() if configured else database.parent / "policy-signing-key.pem"


def _copy_private_file(source: Path, destination: Path) -> None:
    source = source.expanduser().resolve()
    destination = destination.expanduser().resolve()
    if not source.is_file() or source == destination or destination.exists():
        raise ValueError("private key source is missing or destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".shadowlens-key-", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copyfile(source, temporary)
        if os.name != "nt":
            temporary.chmod(0o600)
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _validate_policy_key(path: Path) -> None:
    if path.stat().st_size > 16_384:
        raise ValueError("backup policy key has an invalid size")
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except Exception as exc:
        raise ValueError("backup policy key is invalid") from exc
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise ValueError("backup policy key is not a P-256 private key")


def _rotate_policy_key(active_key: Path, backup_key: Path) -> tuple[str, str]:
    active_key = active_key.expanduser().resolve()
    backup_key = backup_key.expanduser().resolve()
    if not active_key.is_file() or active_key == backup_key:
        raise ValueError("active policy key is missing or backup path is invalid")
    previous_signer = PolicySigner(active_key)
    _copy_private_file(active_key, backup_key)
    staged_key = active_key.parent / f".{active_key.name}.rotation-{secrets.token_hex(8)}"
    try:
        next_signer = PolicySigner(staged_key)
        os.replace(staged_key, active_key)
    except Exception:
        staged_key.unlink(missing_ok=True)
        raise
    return previous_signer.key_id, next_signer.key_id


def _provision_device(database: Path, label: str) -> tuple[str, str]:
    initialize_database(database)
    connection = connect(database)
    try:
        device_id, token = provision_device(connection, label)
    finally:
        connection.close()
    return device_id, token


def _provision_owner(database: Path, owner_id: str) -> None:
    if not owner_id.strip() or len(owner_id) > 100:
        raise ValueError("owner ID must contain 1 to 100 characters")
    configured_owner = os.environ.get("SHADOWSHIELD_OWNER_ID", "local-owner")
    if owner_id.strip() != configured_owner:
        raise ValueError("owner ID must match SHADOWSHIELD_OWNER_ID for this installation")
    password = getpass.getpass("Owner password (minimum 12 characters): ")
    confirmation = getpass.getpass("Confirm owner password: ")
    if password != confirmation:
        raise ValueError("passwords do not match")
    password_hash = hash_owner_password(password)
    initialize_database(database)
    connection = connect(database)
    try:
        with transaction(connection):
            existing = connection.execute("SELECT owner_id FROM owners LIMIT 1").fetchone()
            if existing is not None and str(existing["owner_id"]) != configured_owner:
                raise ValueError("database is already assigned to another owner installation")
            connection.execute(
                "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
                (owner_id.strip(), password_hash, normalize_utc_timestamp()),
            )
    finally:
        connection.close()
    # Drop the local references promptly; neither value was written to output.
    del password, confirmation


def _backup_database(source: Path, destination: Path) -> None:
    source = source.expanduser().resolve()
    destination = destination.expanduser().resolve()
    if source == destination or not source.is_file():
        raise ValueError("backup source is missing or matches destination")
    if destination.exists():
        raise ValueError("backup destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".shadowlens-backup-", suffix=".sqlite3", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with closing(sqlite3.connect(source)) as source_connection, closing(sqlite3.connect(temporary)) as target_connection:
            source_connection.backup(target_connection)
            integrity = target_connection.execute("PRAGMA integrity_check").fetchone()
            if not integrity or integrity[0] != "ok":
                raise sqlite3.DatabaseError("backup integrity check failed")
        if os.name != "nt":
            temporary.chmod(0o600)
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _restore_database(source: Path, destination: Path, pre_restore_backup: Path | None) -> Path | None:
    source = source.expanduser().resolve()
    destination = destination.expanduser().resolve()
    if not source.is_file() or source == destination:
        raise ValueError("restore source is missing or matches the active database")
    if destination.exists():
        if pre_restore_backup is None:
            raise ValueError("restoring over an existing database requires --pre-restore-backup")
        backup_path = pre_restore_backup.expanduser().resolve()
        if backup_path in {source, destination}:
            raise ValueError("pre-restore backup path must be separate from source and active database")
        _backup_database(destination, backup_path)
    else:
        backup_path = None

    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".shadowlens-restore-", suffix=".sqlite3", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with closing(sqlite3.connect(source)) as source_connection, closing(sqlite3.connect(temporary)) as target_connection:
            source_connection.backup(target_connection)
            integrity = target_connection.execute("PRAGMA integrity_check").fetchone()
            if not integrity or integrity[0] != "ok":
                raise sqlite3.DatabaseError("restore source integrity check failed")
        # Reject unknown/corrupt schemas and bring supported old backups forward
        # before the live database path is replaced.
        initialize_database(temporary)
        if os.name != "nt":
            temporary.chmod(0o600)
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return backup_path


def _restore_backup_pair(
    source: Path,
    key_input: Path,
    database: Path,
    active_key: Path,
    pre_restore_backup: Path | None,
    pre_restore_key_backup: Path | None,
) -> tuple[Path | None, Path | None]:
    source = source.expanduser().resolve()
    key_input = key_input.expanduser().resolve()
    database = database.expanduser().resolve()
    active_key = active_key.expanduser().resolve()
    _validate_policy_key(key_input)
    key_backup = pre_restore_key_backup or Path(f"{database}.pre-restore.policy-key.pem")
    key_backup = key_backup.expanduser().resolve()
    had_active_key = active_key.exists()
    if had_active_key:
        _copy_private_file(active_key, key_backup)
    staged_key = database.parent / f".shadowlens-restored-key-{os.getpid()}-{secrets.token_hex(6)}.pem"
    try:
        _copy_private_file(key_input, staged_key)
        database_backup = _restore_database(source, database, pre_restore_backup)
        active_key.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged_key, active_key)
    except Exception:
        staged_key.unlink(missing_ok=True)
        raise
    return database_backup, key_backup if had_active_key else None


def _restore_drill(source: Path, key_input: Path) -> dict[str, int | str]:
    """Exercise paired restore and rollback copies without touching configured live paths."""
    source = source.expanduser().resolve()
    key_input = key_input.expanduser().resolve()
    _validate_policy_key(key_input)
    with tempfile.TemporaryDirectory(prefix="shadowlens-restore-drill-") as scratch_name:
        scratch = Path(scratch_name)
        database = scratch / "active.sqlite3"
        active_key = scratch / "policy-signing-key.pem"
        pre_restore_database = scratch / "pre-restore.sqlite3"
        pre_restore_key = scratch / "pre-restore-policy-key.pem"
        expected_key = scratch / "expected-policy-signing-key.pem"
        _copy_private_file(key_input, expected_key)
        expected_signer = PolicySigner(expected_key)

        # Seed disposable active state so the rehearsal proves rollback copies too.
        initialize_database(database)
        prior_signer = PolicySigner(active_key)
        connection = connect(database)
        try:
            with transaction(connection):
                connection.execute(
                    "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
                    ("restore-drill-sentinel", "synthetic-only", normalize_utc_timestamp()),
                )
        finally:
            connection.close()

        restored_database_backup, restored_key_backup = _restore_backup_pair(
            source,
            key_input,
            database,
            active_key,
            pre_restore_database,
            pre_restore_key,
        )
        if restored_database_backup != pre_restore_database or restored_key_backup != pre_restore_key:
            raise ValueError("restore rehearsal did not retain both pre-restore copies")
        restored_signer = PolicySigner(active_key)
        prior_key_backup = PolicySigner(pre_restore_key)
        if restored_signer.key_id != expected_signer.key_id or prior_key_backup.key_id != prior_signer.key_id:
            raise ValueError("restore rehearsal signing-key pairing check failed")

        connection = connect(database)
        try:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            if not integrity or integrity[0] != "ok":
                raise sqlite3.DatabaseError("restored database integrity check failed")
            if connection.execute("SELECT 1 FROM owners WHERE owner_id='restore-drill-sentinel'").fetchone():
                raise ValueError("restore rehearsal did not replace the disposable active state")
            device_count = int(connection.execute("SELECT COUNT(*) FROM devices").fetchone()[0])
            event_count = int(connection.execute("SELECT COUNT(*) FROM events").fetchone()[0])
            owner_count = int(connection.execute("SELECT COUNT(*) FROM owners").fetchone()[0])
            schema_version = int(connection.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()[0])
        finally:
            connection.close()

        rollback_connection = connect(pre_restore_database)
        try:
            if not rollback_connection.execute(
                "SELECT 1 FROM owners WHERE owner_id='restore-drill-sentinel'",
            ).fetchone():
                raise ValueError("pre-restore database copy failed verification")
        finally:
            rollback_connection.close()
        return {
            "devices": device_count,
            "events": event_count,
            "owners": owner_count,
            "schema_version": schema_version,
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage the local ShadowShield SQLite database")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="apply migrations and seed the frozen domain registry")
    device = commands.add_parser("provision-device", help="create one device credential and show it once")
    device.add_argument("--label", default="Demo browser")
    owner = commands.add_parser("provision-owner", help="create an owner using an interactive password prompt")
    owner.add_argument("--owner-id", default=os.environ.get("SHADOWSHIELD_OWNER_ID", "local-owner"))
    cleanup = commands.add_parser("cleanup-events", help="delete events older than the retention window")
    cleanup.add_argument("--days", type=int, default=None, help="override the configured retention window for this cleanup")
    backup = commands.add_parser("backup", help="create an atomic SQLite metadata backup")
    backup.add_argument("--output", type=Path, required=True)
    backup.add_argument("--policy-key-output", type=Path, default=None, help="signing-key sidecar path; defaults to <output>.policy-key.pem")
    restore = commands.add_parser("restore", help="restore a verified backup; stop the API before use")
    restore.add_argument("--input", type=Path, required=True)
    restore.add_argument("--pre-restore-backup", type=Path, default=None, help="required when the active database exists")
    restore.add_argument("--policy-key-input", type=Path, default=None, help="signing-key sidecar; defaults to <input>.policy-key.pem")
    restore.add_argument("--pre-restore-policy-key-backup", type=Path, default=None, help="defaults to <active database>.pre-restore.policy-key.pem")
    drill = commands.add_parser("restore-drill", help="rehearse a paired database/key restore in an isolated temporary directory")
    drill.add_argument("--input", type=Path, required=True, help="database backup to rehearse")
    drill.add_argument("--policy-key-input", type=Path, default=None, help="signing-key sidecar; defaults to <input>.policy-key.pem")
    rotate = commands.add_parser("rotate-policy-key", help="replace the policy signing key while preserving the old key")
    rotate.add_argument("--backup-key", type=Path, required=True, help="required protected path for the previous signing key")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    database = database_path()
    try:
        if args.command == "init":
            initialize_database(database)
            print(f"SQLite database initialized: {database}")
        elif args.command == "provision-device":
            device_id, token = _provision_device(database, args.label)
            print("Device provisioned. Copy this credential now; it cannot be retrieved later.")
            print(f"Device ID: {device_id}")
            print(f"Bearer token: {token}")
        elif args.command == "provision-owner":
            _provision_owner(database, args.owner_id)
            print("Owner provisioned.")
        elif args.command == "cleanup-events":
            initialize_database(database, prune_expired=False)
            connection = connect(database)
            try:
                retention_days = args.days if args.days is not None else get_retention_days(connection)
                deleted = prune_events(connection, now=datetime.now(timezone.utc), retention_days=retention_days)
            finally:
                connection.close()
            print(f"Deleted {deleted} event(s) older than {retention_days} day(s).")
        elif args.command == "backup":
            from ..services.policy_signing import get_policy_signer
            key_source = policy_key_path(database)
            get_policy_signer(str(key_source))
            key_output = args.policy_key_output or Path(f"{args.output}.policy-key.pem")
            _backup_database(database, args.output)
            try:
                _copy_private_file(key_source, key_output)
            except Exception:
                args.output.expanduser().resolve().unlink(missing_ok=True)
                raise
            print("Database backup created and integrity-checked; policy signing key copied to its protected sidecar.")
        elif args.command == "restore":
            key_input = args.policy_key_input or Path(f"{args.input}.policy-key.pem")
            active_key = policy_key_path(database)
            key_backup = args.pre_restore_policy_key_backup or Path(f"{database}.pre-restore.policy-key.pem")
            backup_path, policy_key_backup = _restore_backup_pair(
                args.input,
                key_input,
                database,
                active_key,
                args.pre_restore_backup,
                key_backup,
            )
            print("Database and matching policy signing key restored and schema-checked. Stop and restart the API around restore operations.")
            if backup_path is not None:
                print(f"Pre-restore backup: {backup_path}")
            if policy_key_backup is not None:
                print(f"Pre-restore policy key backup: {policy_key_backup}")
        elif args.command == "restore-drill":
            key_input = args.policy_key_input or Path(f"{args.input}.policy-key.pem")
            report = _restore_drill(args.input, key_input)
            print("Restore rehearsal passed in an isolated temporary directory; the configured live database and signing key were not changed.")
            print(f"Restored schema version: {report['schema_version']}")
            print(f"Restored metadata counts: {report['devices']} device(s), {report['events']} event(s), {report['owners']} owner(s).")
        elif args.command == "rotate-policy-key":
            previous_key_id, next_key_id = _rotate_policy_key(policy_key_path(database), args.backup_key)
            print("Policy signing key rotated. Restart the owner API before enrolled browsers sync policy.")
            print(f"Previous key fingerprint: {previous_key_id}")
            print(f"Previous key backup: {args.backup_key.expanduser().resolve()}")
            print(f"New key fingerprint: {next_key_id}")
            print("Verify the new fingerprint in the owner dashboard, then use each browser's Options page to trust and sync it.")
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        # Deliberately omit exception details; database and input errors should
        # not accidentally disclose credentials or persisted payload material.
        print(f"Database command failed ({type(exc).__name__}).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
