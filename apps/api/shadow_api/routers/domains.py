"""Owner-only informational tool inventory and approval routes."""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from ..db.database import normalize_utc_timestamp, update_domain_approval
from ..security import require_owner
from ..services.analytics import get_read_connection

router = APIRouter()
_ROOT = Path(__file__).resolve().parents[4]
_REGISTRY = _ROOT / "packages" / "contracts" / "domain-registry.json"


class ApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    approvalStatus: Literal["APPROVED", "UNAPPROVED", "UNREVIEWED"]


def _support_status() -> dict[str, str]:
    data = json.loads(_REGISTRY.read_text(encoding="utf-8"))
    return {site["siteId"]: site["supportStatus"] for site in data["sites"]}


def _domain_projection(connection: sqlite3.Connection, site_id: str) -> dict[str, object]:
    support = _support_status()
    row = connection.execute(
        "SELECT d.site_id, d.approval_status, "
        "SUM(CASE WHEN e.kind='SITE_VISIT' THEN 1 ELSE 0 END) AS visits, "
        "SUM(CASE WHEN e.kind='SUBMISSION' AND json_extract(e.payload_json, '$.coverageMode')='SANDBOX_GUARDED' THEN 1 ELSE 0 END) AS guarded, "
        "MAX(CASE WHEN e.kind='SITE_VISIT' THEN e.ingested_at END) AS last_visit "
        "FROM domains d LEFT JOIN events e ON e.site_id=d.site_id AND e.ingested_at >= ? AND e.ingested_at < ? "
        "WHERE d.site_id=? GROUP BY d.site_id, d.approval_status",
        (normalize_utc_timestamp(datetime.now(timezone.utc) - timedelta(days=30)), normalize_utc_timestamp(), site_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="domain not found")
    return {
        "siteId": str(row["site_id"]),
        "approvalStatus": str(row["approval_status"]),
        "supportStatus": support[str(row["site_id"])],
        "siteVisitsObserved": int(row["visits"] or 0),
        "guardedAttempts": int(row["guarded"] or 0),
        "lastVisitAt": row["last_visit"],
    }


@router.get("/domains")
async def list_domains(
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        ids = [str(row[0]) for row in connection.execute("SELECT site_id FROM domains ORDER BY site_id")]
        return [_domain_projection(connection, site_id) for site_id in ids]
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None


@router.put("/domains/{site_id}/approval")
async def set_approval(
    site_id: Literal["SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"],
    request: ApprovalRequest,
    _owner: Annotated[str, Depends(require_owner)],
    connection: Annotated[sqlite3.Connection, Depends(get_read_connection)],
):
    try:
        update_domain_approval(connection, site_id, request.approvalStatus)
        return _domain_projection(connection, site_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="domain not found") from None
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="service unavailable") from None

