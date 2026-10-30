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
        "SELECT d.device_id, d.last_heartbeat_at, MAX(e.ingested_at) AS last_event_at "
        "FROM devices d LEFT JOIN events e ON e.device_id = d.device_id "
        "GROUP BY d.device_id, d.last_heartbeat_at ORDER BY d.created_at, d.device_id"
    ).fetchall()
    items = []
    for row in rows:
        heartbeat = row["last_heartbeat_at"]
        last_event = row["last_event_at"]
        if heartbeat is None and last_event is None:
            observation = "NEVER_SEEN"
        elif heartbeat is not None and fresh_after <= str(heartbeat) <= current_text:
            observation = "RECENTLY_SEEN"
        else:
            observation = "STALE"
        items.append({
            "deviceId": str(row["device_id"]),
            "lastHeartbeatAt": None if heartbeat is None else str(heartbeat),
            "lastEventAt": None if last_event is None else str(last_event),
            "observation": observation,
        })
    return {"contractVersion": "v2", "items": items}

