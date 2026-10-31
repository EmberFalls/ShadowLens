"""Owner policy editing and authenticated, signed device distribution."""

from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response

from ..config import Settings
from ..dependencies import get_settings
from ..routers.events import IngestContext, get_ingest_context
from ..security import require_owner
from ..services.analytics import get_read_connection
from ..services.policy_service import PolicyUpdate, read_policy, save_policy
from ..services.policy_signing import get_policy_signer

router = APIRouter()


@router.get("/policy")
async def get_owner_policy(
    response: Response,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        response.headers["Cache-Control"] = "no-store"
        return read_policy(connection)
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.put("/policy")
async def update_owner_policy(
    update: PolicyUpdate,
    response: Response,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        policy = save_policy(connection, update)
        response.headers["Cache-Control"] = "no-store"
        return policy
    except ValueError:
        raise HTTPException(status_code=422, detail="policy violates a required protection rule") from None
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.get("/policy/key")
def owner_policy_key(
    response: Response,
    _owner: Annotated[str, Depends(require_owner)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    try:
        signer = get_policy_signer(str(settings.resolved_policy_signing_key_path))
        response.headers["Cache-Control"] = "no-store"
        return {"algorithm": signer.public_document()["algorithm"], "keyId": signer.key_id}
    except (OSError, ValueError):
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.get("/policy/public-key")
def device_policy_key(
    response: Response,
    _device: Annotated[IngestContext, Depends(get_ingest_context)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    try:
        signer = get_policy_signer(str(settings.resolved_policy_signing_key_path))
        response.headers["Cache-Control"] = "no-store"
        return signer.public_document()
    except (OSError, ValueError):
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.get("/policy/bundle")
async def signed_policy_bundle(
    response: Response,
    device: Annotated[IngestContext, Depends(get_ingest_context)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    try:
        signer = get_policy_signer(str(settings.resolved_policy_signing_key_path))
        response.headers["Cache-Control"] = "no-store"
        return signer.sign(read_policy(device.connection))
    except (OSError, ValueError, sqlite3.Error):
        raise HTTPException(status_code=503, detail="service unavailable") from None
