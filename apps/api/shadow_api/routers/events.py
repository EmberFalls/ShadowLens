"""Authenticated metadata-only event batch ingestion route."""

from __future__ import annotations

from dataclasses import dataclass
import sqlite3
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..config import Settings
from ..db.database import connect, hash_bearer_token, verify_bearer_token
from ..dependencies import get_settings
from ..services.event_ingestion import (
    MAX_BATCH_BYTES,
    DatabaseUnavailable,
    EventBatch,
    IngestResponse,
    InvalidEventBatch,
    PayloadTooLarge,
    ingest_event_batch,
    parse_event_batch,
)

router = APIRouter()


@dataclass
class IngestContext:
    connection: sqlite3.Connection
    device_id: str


async def get_ingest_context(request: Request, settings: Settings = Depends(get_settings)) -> AsyncIterator[IngestContext]:
    """Authenticate before opening the body-validation path; always close DB."""
    authorization = request.headers.get("authorization", "")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or len(parts[1]) > 512:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required")
    try:
        candidate_hash = hash_bearer_token(parts[1])
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required") from None

    try:
        connection = connect(settings.database_path)
    except (OSError, sqlite3.Error):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="service unavailable") from None
    try:
        row = connection.execute(
            "SELECT device_id, token_hash, revoked_at FROM devices WHERE token_hash = ?",
            (candidate_hash,),
        ).fetchone()
        if row is None or row["revoked_at"] is not None or not verify_bearer_token(parts[1], str(row["token_hash"])):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required")
        yield IngestContext(connection=connection, device_id=str(row["device_id"]))
    except sqlite3.Error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="service unavailable") from None
    finally:
        connection.close()


async def read_bounded_body(request: Request) -> bytes:
    """Read no more than 32 KiB, including requests without Content-Length."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError:
            raise InvalidEventBatch from None
        if declared_length < 0:
            raise InvalidEventBatch
        if declared_length > MAX_BATCH_BYTES:
            raise PayloadTooLarge

    pieces: list[bytes] = []
    total = 0
    async for piece in request.stream():
        total += len(piece)
        if total > MAX_BATCH_BYTES:
            raise PayloadTooLarge
        pieces.append(piece)
    return b"".join(pieces)


@router.post("/events/batch", response_model=IngestResponse)
async def ingest_batch(request: Request, context: IngestContext = Depends(get_ingest_context)) -> IngestResponse:
    # The body is deliberately read only after the bearer dependency succeeds.
    try:
        raw_body = await read_bounded_body(request)
        batch: EventBatch = parse_event_batch(raw_body)
        return ingest_event_batch(
            context.connection,
            authenticated_device_id=context.device_id,
            batch=batch,
        )
    except PayloadTooLarge:
        raise HTTPException(status_code=413, detail="request body exceeds limit") from None
    except InvalidEventBatch:
        raise HTTPException(status_code=422, detail="event batch is invalid") from None
    except DatabaseUnavailable:
        raise HTTPException(status_code=503, detail="service unavailable") from None
