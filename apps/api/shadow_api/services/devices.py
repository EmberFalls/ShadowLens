"""Device status projection using server-ingested event timestamps."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sqlite3
from typing import Any

from ..db.database import normalize_utc_timestamp

FRESHNESS_MINUTES = 15


def list_devices(connection: sqlite3.Connection, *, now: datetime | str | None = None) -> dict[str, Any]:
    current_text = normalize_utc_timestamp(now)
    current = datetime.fromisoformat(current_text.replace("Z", "+00:00"))
    fresh_after = normalize_utc_timestamp(current - timedelta(minutes=FRESHNESS_MINUTES))
    rows = connection.execute(
        "SELECT device_id, last_heartbeat_at, last_event_at, extension_version, policy_revision, "
        "engine_version, last_scanner_result, revoked_at FROM devices ORDER BY created_at, device_id"
    ).fetchall()
    items = []
    for row in rows:
        heartbeat = row["last_heartbeat_at"]
        last_event = row["last_event_at"]
        last_seen = max((str(value) for value in (heartbeat, last_event) if value is not None), default=None)
        if last_seen is None:
            observation = "NEVER_SEEN"
        elif fresh_after <= last_seen <= current_text:
            observation = "RECENTLY_SEEN"
        else:
            observation = "STALE"
        items.append({
            "deviceId": str(row["device_id"]),
            "lastHeartbeatAt": None if heartbeat is None else str(heartbeat),
            "lastEventAt": None if last_event is None else str(last_event),
            "lastMetadataSyncAt": None if last_event is None else str(last_event),
            "extensionVersion": row["extension_version"],
            "policyRevision": row["policy_revision"],
            "engineVersion": row["engine_version"],
            "lastScannerResult": row["last_scanner_result"] or "NOT_REPORTED",
            "observation": observation,
            "enrollmentStatus": "REVOKED" if row["revoked_at"] is not None else "ACTIVE",
        })
    return {"contractVersion": "v2", "items": items}

