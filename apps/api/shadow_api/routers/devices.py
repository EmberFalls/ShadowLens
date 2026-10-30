"""Owner-only device status endpoint."""

from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from ..security import require_owner
from ..services.analytics import get_read_connection
from ..services.devices import list_devices

router = APIRouter()


@router.get("/devices")
async def devices(
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        return list_devices(connection)
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None

