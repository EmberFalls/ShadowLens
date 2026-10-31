"""Owner controls for event retention, export and deletion."""

from __future__ import annotations

import json
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..db.database import (
    delete_all_events,
    get_retention_days,
    normalize_utc_timestamp,
    set_retention_days,
)
from ..dependencies import get_settings
from ..security import require_owner
from ..services.analytics import get_read_connection
from ..services.policy_service import read_policy
from ..services.policy_signing import get_policy_signer

router = APIRouter(prefix="/privacy")


class RetentionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    retentionDays: int = Field(strict=True, ge=1, le=3650)


@router.get("/retention")
async def read_retention(
    response: Response,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        response.headers["Cache-Control"] = "no-store"
        row = connection.execute(
            "SELECT updated_at FROM app_settings WHERE setting_key='event_retention_days'"
        ).fetchone()
        return {
            "retentionDays": get_retention_days(connection),
            "updatedAt": row["updated_at"] if row else None,
        }
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.put("/retention")
async def update_retention(
    update: RetentionUpdate,
    response: Response,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        response.headers["Cache-Control"] = "no-store"
        previous, deleted = set_retention_days(connection, update.retentionDays)
        return {
            "retentionDays": update.retentionDays,
            "previousRetentionDays": previous,
            "expiredEventsDeleted": deleted,
        }
    except (sqlite3.Error, ValueError):
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.get("/export")
async def export_metadata(
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    """Download owner-visible metadata only; raw prompts are never persisted."""
    try:
        events = [json.loads(row["payload_json"]) for row in connection.execute(
            "SELECT payload_json FROM events ORDER BY ingested_at, event_id"
        )]
        administrative_audit = [
            {"action": row["action"], "detail": json.loads(row["detail_json"]), "changedAt": row["changed_at"]}
            for row in connection.execute(
                "SELECT action, detail_json, changed_at FROM owner_audit ORDER BY changed_at, id"
            )
        ]
        devices = [
            {
                "deviceId": row["device_id"],
                "deviceLabel": row["device_label"],
                "createdAt": row["created_at"],
                "revokedAt": row["revoked_at"],
                "lastHeartbeatAt": row["last_heartbeat_at"],
                "lastMetadataSyncAt": row["last_event_at"],
                "extensionVersion": row["extension_version"],
                "policyRevision": row["policy_revision"],
                "engineVersion": row["engine_version"],
                "lastScannerResult": row["last_scanner_result"] or "NOT_REPORTED",
            }
            for row in connection.execute(
                "SELECT device_id, device_label, created_at, revoked_at, last_heartbeat_at, last_event_at, "
                "extension_version, policy_revision, engine_version, last_scanner_result "
                "FROM devices ORDER BY created_at, device_id"
            )
        ]
        domains = [
            {
                "siteId": row["site_id"],
                "canonicalHost": row["canonical_host"],
                "approvalStatus": row["approval_status"],
                "updatedAt": row["updated_at"],
            }
            for row in connection.execute("SELECT site_id, canonical_host, approval_status, updated_at FROM domains ORDER BY site_id")
        ]
        approval_history = [
            {
                "siteId": row["site_id"],
                "oldStatus": row["old_status"],
                "newStatus": row["new_status"],
                "changedAt": row["changed_at"],
            }
            for row in connection.execute(
                "SELECT site_id, old_status, new_status, changed_at FROM domain_approval_changes ORDER BY changed_at, id"
            )
        ]
        signer = get_policy_signer(str(settings.resolved_policy_signing_key_path))
        body = {
            "contractVersion": "v2",
            "exportedAt": normalize_utc_timestamp(),
            "retentionDays": get_retention_days(connection),
            "events": events,
            "devices": devices,
            "domains": domains,
            "domainApprovalHistory": approval_history,
            "policy": read_policy(connection),
            "policyKeyId": signer.key_id,
            "administrativeAudit": administrative_audit,
        }
        payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        return Response(
            content=payload,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="shadowlens-metadata-export.json"', "Cache-Control": "no-store"},
        )
    except (sqlite3.Error, ValueError, TypeError, OSError):
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.delete("/events")
async def delete_event_history(
    response: Response,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        response.headers["Cache-Control"] = "no-store"
        return {"deletedEvents": delete_all_events(connection)}
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None
