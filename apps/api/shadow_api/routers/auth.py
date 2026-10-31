"""Owner login, logout, and current-session routes."""

from __future__ import annotations

from datetime import datetime
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..dependencies import AuthStore, get_auth_store, get_settings
from ..db.database import clear_login_failures, connect, hash_session_id, login_block_remaining, record_login_failure
from ..services.policy_signing import get_policy_signer
from ..security import (
    OWNER_COOKIE_NAME,
    create_session_secret,
    require_owner,
    require_owner_login_origin,
    session_expiry,
    verify_password,
)
router = APIRouter()


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=1024)


class OkResponse(BaseModel):
    ok: bool = True


class AuthenticatedResponse(BaseModel):
    authenticated: bool = True


@router.post("/login", response_model=OkResponse, dependencies=[Depends(require_owner_login_origin)])
def login(
    credentials: LoginRequest,
    response: Response,
    request: Request,
    auth_store: Annotated[AuthStore, Depends(get_auth_store)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> OkResponse:
    remote_address = request.client.host if request.client is not None else "unknown"
    try:
        signer = get_policy_signer(str(settings.resolved_policy_signing_key_path))
        subject_hash = signer.hash_rate_limit_subject(remote_address or "unknown")
        connection = connect(settings.database_path)
        try:
            remaining = login_block_remaining(connection, subject_hash)
            if remaining:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="too many login attempts",
                    headers={"Retry-After": str(remaining)},
                )
        finally:
            connection.close()
    except HTTPException:
        raise
    except (OSError, sqlite3.Error, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="login service unavailable") from exc

    stored_hash = auth_store.password_hash_for_owner(settings.owner_id)
    if not verify_password(credentials.password, stored_hash):
        try:
            connection = connect(settings.database_path)
            try:
                remaining = record_login_failure(connection, subject_hash)
            finally:
                connection.close()
        except (OSError, sqlite3.Error, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="login service unavailable") from exc
        if remaining:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="too many login attempts",
                headers={"Retry-After": str(remaining)},
            )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    try:
        connection = connect(settings.database_path)
        try:
            clear_login_failures(connection, subject_hash)
        finally:
            connection.close()
    except (OSError, sqlite3.Error, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="login service unavailable") from exc

    secret = create_session_secret()
    expires_at = session_expiry(settings)
    auth_store.create_session(settings.owner_id, hash_session_id(secret), expires_at)
    response.set_cookie(
        key=OWNER_COOKIE_NAME,
        value=secret,
        max_age=settings.session_ttl_seconds,
        expires=datetime.fromisoformat(expires_at.replace("Z", "+00:00")),
        path="/api/v1",
        httponly=True,
        secure=settings.secure_cookies,
        samesite="strict",
    )
    return OkResponse()


@router.post("/logout", response_model=OkResponse)
def logout(
    response: Response,
    request: Request,
    owner_id: Annotated[str, Depends(require_owner)],
    auth_store: Annotated[AuthStore, Depends(get_auth_store)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> OkResponse:
    del owner_id
    secret = request.cookies.get(OWNER_COOKIE_NAME)
    if secret:
        auth_store.delete_session(hash_session_id(secret))
    response.delete_cookie(
        key=OWNER_COOKIE_NAME,
        path="/api/v1",
        httponly=True,
        secure=settings.secure_cookies,
        samesite="strict",
    )
    return OkResponse()


@router.get("/me", response_model=AuthenticatedResponse)
def me(owner_id: Annotated[str, Depends(require_owner)]) -> AuthenticatedResponse:
    del owner_id
    return AuthenticatedResponse()
