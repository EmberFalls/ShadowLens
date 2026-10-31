"""Owner-only device status endpoint."""

from __future__ import annotations

import re
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..db.database import normalize_utc_timestamp, provision_device, revoke_device
from ..dependencies import get_settings
from ..security import require_owner
from ..services.analytics import get_read_connection
from ..services.devices import list_devices
from ..services.policy_signing import get_policy_signer

router = APIRouter()
_DEVICE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


class DeviceEnrollment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(strict=True, min_length=1, max_length=100)


@router.post("/devices/enroll", status_code=status.HTTP_201_CREATED)
async def enroll_device(
    request: DeviceEnrollment,
    response: Response,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    try:
        key_id = get_policy_signer(str(settings.resolved_policy_signing_key_path)).key_id
    except (OSError, ValueError):
        raise HTTPException(status_code=503, detail="service unavailable") from None
    try:
        device_id, token = provision_device(connection, request.label)
        # The raw bearer credential is returned once and is never persisted.
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        return {"deviceId": device_id, "token": token, "policyKeyId": key_id}
    except ValueError:
        raise HTTPException(status_code=409, detail="device enrollment limit reached or label is invalid") from None
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.get("/devices")
async def devices(
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        return list_devices(connection)
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.post("/devices/{device_id}/revoke")
async def revoke_enrollment(
    device_id: str,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    if not _DEVICE_ID.fullmatch(device_id):
        raise HTTPException(status_code=404, detail="device not found")
    try:
        if revoke_device(connection, device_id, revoked_at=normalize_utc_timestamp()) is None:
            raise HTTPException(status_code=404, detail="device not found")
        return {"ok": True}
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None

