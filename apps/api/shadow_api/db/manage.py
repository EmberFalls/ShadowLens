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
from datetime import datetime, timezone
import getpass
import os
from pathlib import Path
import secrets
import sqlite3
import uuid
import sys

try:
    from .database import (
        DEFAULT_RETENTION_DAYS,
        connect,
        hash_bearer_token,
        hash_owner_password,
        initialize_database,
        normalize_utc_timestamp,
        prune_events,
        transaction,
    )
except ImportError:
    _root = Path(__file__).resolve().parents[4]
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))
    from apps.api.shadow_api.db.database import (
        DEFAULT_RETENTION_DAYS,
        connect,
        hash_bearer_token,
        hash_owner_password,
        initialize_database,
        normalize_utc_timestamp,
        prune_events,
        transaction,
    )

DEFAULT_DATABASE = Path.home() / ".shadowshield" / "shadowshield.sqlite3"


def database_path() -> Path:
    return Path(os.environ.get("SHADOWSHIELD_DATABASE", str(DEFAULT_DATABASE))).expanduser().resolve()


def _provision_device(database: Path, label: str) -> tuple[str, str]:
    if not label.strip() or len(label) > 100:
        raise ValueError("device label must contain 1 to 100 characters")
    initialize_database(database)
    device_id = str(uuid.uuid4())
    token = "ss_dev_" + secrets.token_urlsafe(36)
    token_hash = hash_bearer_token(token)
    connection = connect(database)
    try:
        with transaction(connection):
            connection.execute(
                "INSERT INTO devices(device_id, token_hash, device_label, created_at) VALUES (?, ?, ?, ?)",
                (device_id, token_hash, label.strip(), normalize_utc_timestamp()),
            )
    finally:
        connection.close()
    return device_id, token


def _provision_owner(database: Path, owner_id: str) -> None:
    if not owner_id.strip() or len(owner_id) > 100:
        raise ValueError("owner ID must contain 1 to 100 characters")
    password = getpass.getpass("Owner password (minimum 12 characters): ")
    confirmation = getpass.getpass("Confirm owner password: ")
    if password != confirmation:
        raise ValueError("passwords do not match")
    password_hash = hash_owner_password(password)
    initialize_database(database)
    connection = connect(database)
    try:
        with transaction(connection):
            connection.execute(
                "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
                (owner_id.strip(), password_hash, normalize_utc_timestamp()),
            )
    finally:
        connection.close()
    # Drop the local references promptly; neither value was written to output.
    del password, confirmation


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage the local ShadowShield SQLite database")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="apply migrations and seed the frozen domain registry")
    device = commands.add_parser("provision-device", help="create one device credential and show it once")
    device.add_argument("--label", default="Demo browser")
    owner = commands.add_parser("provision-owner", help="create an owner using an interactive password prompt")
    owner.add_argument("--owner-id", default="local-owner")
    cleanup = commands.add_parser("cleanup-events", help="delete events older than the retention window")
    cleanup.add_argument("--days", type=int, default=DEFAULT_RETENTION_DAYS)
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
            initialize_database(database)
            connection = connect(database)
            try:
                deleted = prune_events(connection, now=datetime.now(timezone.utc), retention_days=args.days)
            finally:
                connection.close()
            print(f"Deleted {deleted} event(s) older than {args.days} day(s).")
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        # Deliberately omit exception details; database and input errors should
        # not accidentally disclose credentials or persisted payload material.
        print(f"Database command failed ({type(exc).__name__}).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
