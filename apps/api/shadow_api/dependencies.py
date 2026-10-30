"""FastAPI dependencies and the SQLite owner/session adapter."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Protocol

from fastapi import Depends, Request

from .config import Settings
from .db.database import connect, normalize_utc_timestamp, transaction


class AuthStore(Protocol):
    def password_hash_for_owner(self, owner_id: str) -> str | None: ...
    def create_session(self, owner_id: str, session_hash: str, expires_at: str) -> None: ...
    def resolve_session(self, session_hash: str, now: str) -> str | None: ...
    def delete_session(self, session_hash: str) -> None: ...


class SQLiteAuthStore:
    """C1 adapter over the frozen SH-011 owner/session tables."""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)

    def password_hash_for_owner(self, owner_id: str) -> str | None:
        connection = connect(self.database_path)
        try:
            row = connection.execute("SELECT password_hash FROM owners WHERE owner_id = ?", (owner_id,)).fetchone()
            return None if row is None else str(row["password_hash"])
        finally:
            connection.close()

    def create_session(self, owner_id: str, session_hash: str, expires_at: str) -> None:
        connection = connect(self.database_path)
        try:
            with transaction(connection):
                connection.execute(
                    "INSERT INTO owner_sessions(id, owner_id, expires_at) VALUES (?, ?, ?)",
                    (session_hash, owner_id, normalize_utc_timestamp(expires_at)),
                )
        finally:
            connection.close()

    def resolve_session(self, session_hash: str, now: str) -> str | None:
        connection = connect(self.database_path)
        try:
            row = connection.execute(
                "SELECT owner_id, expires_at FROM owner_sessions WHERE id = ?", (session_hash,)
            ).fetchone()
            if row is None:
                return None
            if str(row["expires_at"]) <= normalize_utc_timestamp(now):
                self.delete_session(session_hash)
                return None
            return str(row["owner_id"])
        finally:
            connection.close()

    def delete_session(self, session_hash: str) -> None:
        connection = connect(self.database_path)
        try:
            with transaction(connection):
                connection.execute("DELETE FROM owner_sessions WHERE id = ?", (session_hash,))
        finally:
            connection.close()


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_auth_store(request: Request) -> AuthStore:
    return request.app.state.auth_store


def get_database_connection(
    settings: Annotated[Settings, Depends(get_settings)],
):
    connection = connect(settings.database_path)
    try:
        yield connection
    finally:
        connection.close()
