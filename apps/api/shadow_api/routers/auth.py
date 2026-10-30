"""Owner login, logout, and current-session routes."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..dependencies import AuthStore, get_auth_store, get_settings
from ..security import (
    OWNER_COOKIE_NAME,
    create_session_secret,
    require_owner,
    require_owner_login_origin,
    session_expiry,
    verify_password,
)
from ..db.database import hash_session_id

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
    auth_store: Annotated[AuthStore, Depends(get_auth_store)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> OkResponse:
    stored_hash = auth_store.password_hash_for_owner(settings.owner_id)
    if not verify_password(credentials.password, stored_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

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
        secure=False,
        samesite="strict",
    )
    return OkResponse()


@router.post("/logout", response_model=OkResponse)
def logout(
    response: Response,
    request: Request,
    owner_id: Annotated[str, Depends(require_owner)],
    auth_store: Annotated[AuthStore, Depends(get_auth_store)],
) -> OkResponse:
    del owner_id
    secret = request.cookies.get(OWNER_COOKIE_NAME)
    if secret:
        auth_store.delete_session(hash_session_id(secret))
    response.delete_cookie(
        key=OWNER_COOKIE_NAME,
        path="/api/v1",
        httponly=True,
        secure=False,
        samesite="strict",
    )
    return OkResponse()


@router.get("/me", response_model=AuthenticatedResponse)
def me(owner_id: Annotated[str, Depends(require_owner)]) -> AuthenticatedResponse:
    del owner_id
    return AuthenticatedResponse()
