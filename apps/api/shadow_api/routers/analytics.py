"""Owner-only analytics endpoints."""

from __future__ import annotations

import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..security import require_owner
from ..services.analytics import InvalidCursor, build_event_page, build_summary, build_timeseries, get_read_connection

router = APIRouter()


@router.get("/analytics/summary")
async def summary(
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
    days: Annotated[int, Query(ge=1, le=30)] = 7,
):
    try:
        return build_summary(connection, days=days)
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.get("/analytics/timeseries")
async def timeseries(
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
    days: Annotated[int, Query(ge=1, le=30)] = 7,
    tz: Literal["UTC", "Asia/Kolkata"] = "UTC",
):
    try:
        return build_timeseries(connection, days=days, tz=tz)
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.get("/analytics/events")
async def events(
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: Annotated[str | None, Query(max_length=512)] = None,
):
    try:
        return build_event_page(connection, limit=limit, cursor=cursor)
    except InvalidCursor:
        raise HTTPException(status_code=422, detail="cursor is invalid") from None
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None

