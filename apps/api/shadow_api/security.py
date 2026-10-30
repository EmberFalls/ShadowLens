"""Owner-session cookie and request-origin security helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
import secrets
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from .config import Settings
from .db.database import hash_session_id, normalize_utc_timestamp, verify_owner_password
from .dependencies import AuthStore, get_auth_store, get_settings

OWNER_COOKIE_NAME = "shadowshield_owner"


def require_exact_owner_origin(request: Request, settings: Settings) -> None:
    origin = request.headers.get("origin")
    if origin not in settings.owner_origins:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="origin rejected")


def create_session_secret() -> str:
    return secrets.token_urlsafe(32)


def session_expiry(settings: Settings, *, now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("session clock must be timezone-aware")
    return normalize_utc_timestamp(current + timedelta(seconds=settings.session_ttl_seconds))


async def require_owner(
    request: Request,
    auth_store: Annotated[AuthStore, Depends(get_auth_store)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> str:
    secret = request.cookies.get(OWNER_COOKIE_NAME)
    if not secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required")
    try:
        session_hash = hash_session_id(secret)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required") from None
    owner_id = auth_store.resolve_session(session_hash, normalize_utc_timestamp())
    if owner_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        require_exact_owner_origin(request, settings)
    return owner_id


def verify_password(password: str, stored_hash: str | None) -> bool:
    """Use a dummy scrypt verification when no owner exists to reduce timing leaks."""
    if stored_hash is None:
        return _dummy_verify(password)
    if not re.fullmatch(r"scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}", stored_hash):
        _dummy_verify(password)
        return False
    try:
        return verify_owner_password(password, stored_hash)
    except (ValueError, TypeError):
        return False


_DUMMY_HASH = "scrypt$16384$8$1$" + "00" * 16 + "$" + "00" * 32


def _dummy_verify(password: str) -> bool:
    # verify_owner_password performs the same bounded scrypt cost. Always
    # return false so a missing owner never authenticates.
    verify_owner_password(password, _DUMMY_HASH)
    return False


def require_owner_login_origin(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    require_exact_owner_origin(request, settings)
