from __future__ import annotations

import sqlite3
from pathlib import Path

from apps.api.shadow_api.db.database import connect, initialize_database, normalize_utc_timestamp
from apps.api.shadow_api.db.manage import main
from apps.api.shadow_api.services.policy_signing import PolicySigner


def _owner_password_hash(database: Path) -> str:
    connection = connect(database)
    try:
        row = connection.execute("SELECT password_hash FROM owners WHERE owner_id='local-owner'").fetchone()
        assert row is not None
        return str(row["password_hash"])
    finally:
        connection.close()


def test_backup_restore_preserves_matching_policy_key_and_active_state(tmp_path: Path, monkeypatch, capsys) -> None:
    database = tmp_path / "active.sqlite3"
    key_path = tmp_path / "keys" / "policy-signing-key.pem"
    backup = tmp_path / "backup.sqlite3"
    pre_restore = tmp_path / "pre-restore.sqlite3"
    monkeypatch.setenv("SHADOWSHIELD_DATABASE", str(database))
    monkeypatch.setenv("SHADOWSHIELD_POLICY_SIGNING_KEY", str(key_path))

    assert main(["init"]) == 0
    connection = connect(database)
    try:
        connection.execute(
            "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
            ("local-owner", "before-restore", normalize_utc_timestamp()),
        )
    finally:
        connection.close()

    assert main(["backup", "--output", str(backup)]) == 0
    capsys.readouterr()
    backup_key = Path(f"{backup}.policy-key.pem")
    backup_key_id = PolicySigner(backup_key).key_id

    connection = connect(database)
    try:
        connection.execute("UPDATE owners SET password_hash='after-backup' WHERE owner_id='local-owner'")
    finally:
        connection.close()
    assert main(["rotate-policy-key", "--backup-key", str(tmp_path / "post-backup-key.pem")]) == 0
    capsys.readouterr()
    assert PolicySigner(key_path).key_id != backup_key_id

    assert main(["restore", "--input", str(backup), "--pre-restore-backup", str(pre_restore)]) == 0
    capsys.readouterr()
    assert _owner_password_hash(database) == "before-restore"
    assert PolicySigner(key_path).key_id == backup_key_id
    assert Path(f"{database}.pre-restore.policy-key.pem").is_file()
    with sqlite3.connect(pre_restore) as connection:
        assert connection.execute("SELECT password_hash FROM owners WHERE owner_id='local-owner'").fetchone()[0] == "after-backup"


def test_restore_refuses_missing_signing_key_without_changing_active_database(tmp_path: Path, monkeypatch, capsys) -> None:
    database = tmp_path / "active.sqlite3"
    key_path = tmp_path / "keys" / "policy-signing-key.pem"
    backup = tmp_path / "backup.sqlite3"
    monkeypatch.setenv("SHADOWSHIELD_DATABASE", str(database))
    monkeypatch.setenv("SHADOWSHIELD_POLICY_SIGNING_KEY", str(key_path))
    initialize_database(database)
    old_key_id = PolicySigner(key_path).key_id
    connection = connect(database)
    try:
        connection.execute(
            "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
            ("local-owner", "keep-current", normalize_utc_timestamp()),
        )
    finally:
        connection.close()

    assert main(["restore", "--input", str(backup), "--pre-restore-backup", str(tmp_path / "pre.sqlite3")]) == 1
    assert "Database command failed" in capsys.readouterr().err
    assert _owner_password_hash(database) == "keep-current"
    assert PolicySigner(key_path).key_id == old_key_id


def test_policy_key_rotation_keeps_previous_key_and_installs_new_fingerprint(tmp_path: Path, monkeypatch, capsys) -> None:
    database = tmp_path / "active.sqlite3"
    key_path = tmp_path / "policy-signing-key.pem"
    previous_key = tmp_path / "protected" / "previous-key.pem"
    monkeypatch.setenv("SHADOWSHIELD_DATABASE", str(database))
    monkeypatch.setenv("SHADOWSHIELD_POLICY_SIGNING_KEY", str(key_path))
    old_key_id = PolicySigner(key_path).key_id

    assert main(["rotate-policy-key", "--backup-key", str(previous_key)]) == 0
    output = capsys.readouterr().out
    new_key_id = PolicySigner(key_path).key_id
    assert previous_key.is_file()
    assert PolicySigner(previous_key).key_id == old_key_id
    assert new_key_id != old_key_id
    assert new_key_id in output
