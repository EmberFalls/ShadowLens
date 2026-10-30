"""Read-only analytics projections over sanitized, server-timestamped events."""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from typing import Any, AsyncIterator, Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import Depends

from ..config import Settings
from ..db.database import DEFAULT_RETENTION_DAYS, connect, normalize_utc_timestamp
from ..dependencies import get_settings

ALLOWED_TIMEZONES = {"UTC", "Asia/Kolkata"}


async def get_read_connection(
    settings: Annotated[Settings, Depends(get_settings)],
) -> AsyncIterator[sqlite3.Connection]:
    """Keep SQLite use on the async request thread for safe connection affinity."""
    connection = connect(settings.database_path)
    try:
        yield connection
    finally:
        connection.close()


class InvalidCursor(ValueError):
    """Raised when an event pagination cursor is malformed."""


def _parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(normalize_utc_timestamp(value).replace("Z", "+00:00"))


def _bounds(days: int, now: datetime | str | None) -> tuple[datetime, datetime]:
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= DEFAULT_RETENTION_DAYS:
        raise ValueError("days must be between 1 and 30")
    end = _parse_utc(normalize_utc_timestamp(now))
    start = end - timedelta(days=min(days, DEFAULT_RETENTION_DAYS))
    return start, end


def _event_rows(connection: sqlite3.Connection, start: datetime, end: datetime) -> list[sqlite3.Row]:
    return connection.execute(
        "SELECT event_id, device_id, kind, site_id, payload_json, ingested_at FROM events "
        "WHERE ingested_at >= ? AND ingested_at < ? ORDER BY ingested_at, event_id",
        (normalize_utc_timestamp(start), normalize_utc_timestamp(end)),
    ).fetchall()


def _payload(row: sqlite3.Row) -> dict[str, Any]:
    return json.loads(str(row["payload_json"]))


def _device_observations(connection: sqlite3.Connection, now: datetime, start: datetime, end: datetime) -> tuple[int, int, int]:
    recent_start = normalize_utc_timestamp(now - timedelta(minutes=15))
    start_text, end_text = normalize_utc_timestamp(start), normalize_utc_timestamp(end)
    rows = connection.execute(
        "SELECT d.device_id, d.last_heartbeat_at, "
        "MAX(CASE WHEN e.ingested_at >= ? AND e.ingested_at < ? THEN 1 ELSE 0 END) AS observed "
        "FROM devices d LEFT JOIN events e ON e.device_id = d.device_id "
        "GROUP BY d.device_id, d.last_heartbeat_at",
        (start_text, end_text),
    ).fetchall()
    observed = [row for row in rows if bool(row["observed"])]
    fresh = sum(
        1 for row in observed
        if row["last_heartbeat_at"] is not None and recent_start <= str(row["last_heartbeat_at"]) <= normalize_utc_timestamp(now)
    )
    return len(observed), fresh, len(observed) - fresh


def _coverage_note(connection: sqlite3.Connection, days: int, start: datetime) -> str:
    # The frozen schema has no collection-start marker. Migration time is the
    # earliest possible event time and lets the API flag windows that predate
    # the database without mistaking a quiet interval for missing data.
    row = connection.execute("SELECT MIN(applied_at) FROM schema_migrations").fetchone()
    initialized_at = None if row is None else row[0]
    prefix = "Partial coverage: requested start predates database initialization. "
    if initialized_at is not None and start < _parse_utc(str(initialized_at)):
        return (
            f"{prefix}Database initialized at {initialized_at}. Counts use server-ingested events; "
            f"history is retained for at most {DEFAULT_RETENTION_DAYS} days (requested window: {days} days)."
        )
    return (
        f"Counts use server-ingested events from {normalize_utc_timestamp(start)}; "
        f"event history is retained for at most {DEFAULT_RETENTION_DAYS} days "
        f"(requested window: {days} days)."
    )


def build_summary(
    connection: sqlite3.Connection,
    *,
    days: int = 7,
    now: datetime | str | None = None,
) -> dict[str, Any]:
    start, end = _bounds(days, now)
    rows = _event_rows(connection, start, end)
    site_visits = [row for row in rows if row["kind"] == "SITE_VISIT"]
    submissions = [(_payload(row), row) for row in rows if row["kind"] == "SUBMISSION"]
    counts: dict[str, int] = {}
    for event, _row in submissions:
        for category, count in event.get("categoryCounts", {}).items():
            counts[category] = counts.get(category, 0) + int(count)
    observed, fresh, stale = _device_observations(connection, end, start, end)
    return {
        "contractVersion": "v2",
        "windowDays": days,
        "timezone": "UTC",
        "siteVisitsObserved": len(site_visits),
        "distinctAiSitesObserved": len({str(row["site_id"]) for row in site_visits if row["site_id"] != "SANDBOX"}),
        "guardedAttempts": sum(1 for event, _ in submissions if event.get("coverageMode") == "SANDBOX_GUARDED"),
        "policyBlocks": sum(1 for event, _ in submissions if event.get("decisionAction") == "BLOCK" and event.get("disposition") == "BLOCKED"),
        "failedSafe": sum(1 for event, _ in submissions if event.get("disposition") == "FAILED_SAFE"),
        "redactionsPlanned": sum(1 for event, _ in submissions if event.get("decisionAction") == "REDACT"),
        "redactionsPageAttested": sum(1 for event, _ in submissions if event.get("decisionAction") == "REDACT" and event.get("disposition") == "PAGE_ATTESTED"),
        "warningsIssued": sum(1 for event, _ in submissions if event.get("decisionAction") == "WARN"),
        "pageAttestedReleases": sum(1 for event, _ in submissions if event.get("disposition") == "PAGE_ATTESTED"),
        "observedDevices": observed,
        "freshDevices": fresh,
        "staleDevices": stale,
        "categories": counts,
        "fromUtc": normalize_utc_timestamp(start),
        "toUtc": normalize_utc_timestamp(end),
        "coverageNote": _coverage_note(connection, days, start),
    }


def build_timeseries(
    connection: sqlite3.Connection,
    *,
    days: int = 7,
    tz: str = "UTC",
    now: datetime | str | None = None,
) -> dict[str, Any]:
    if tz not in ALLOWED_TIMEZONES:
        raise ValueError("timezone is not supported")
    try:
        zone = ZoneInfo(tz)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("timezone is not supported") from exc
    start, end = _bounds(days, now)
    buckets: dict[str, dict[str, int | str]] = {}
    first_day = start.astimezone(zone).date()
    last_day = (end - timedelta(microseconds=1)).astimezone(zone).date()
    current = first_day
    while current <= last_day:
        buckets[current.isoformat()] = {
            "bucketDateLocal": current.isoformat(), "siteVisitsObserved": 0,
            "guardedAttempts": 0, "policyBlocks": 0, "failedSafe": 0,
            "redactionsPageAttested": 0,
        }
        current += timedelta(days=1)
    for row in _event_rows(connection, start, end):
        bucket = buckets[datetime.fromisoformat(str(row["ingested_at"]).replace("Z", "+00:00")).astimezone(zone).date().isoformat()]
        if row["kind"] == "SITE_VISIT":
            bucket["siteVisitsObserved"] += 1
        elif row["kind"] == "SUBMISSION":
            event = _payload(row)
            bucket["guardedAttempts"] += int(event.get("coverageMode") == "SANDBOX_GUARDED")
            bucket["policyBlocks"] += int(event.get("decisionAction") == "BLOCK" and event.get("disposition") == "BLOCKED")
            bucket["failedSafe"] += int(event.get("disposition") == "FAILED_SAFE")
            bucket["redactionsPageAttested"] += int(event.get("decisionAction") == "REDACT" and event.get("disposition") == "PAGE_ATTESTED")
    return {"contractVersion": "v2", "timezone": tz, "windowDays": days, "buckets": list(buckets.values())}


def _encode_cursor(ingested_at: str, event_id: str) -> str:
    data = json.dumps([ingested_at, event_id], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        if not isinstance(decoded, list) or len(decoded) != 2 or not all(isinstance(value, str) for value in decoded):
            raise ValueError
        timestamp, event_id = decoded
        if normalize_utc_timestamp(timestamp) != timestamp or not event_id or len(event_id) > 100:
            raise ValueError
        return timestamp, event_id
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidCursor from exc


def build_event_page(
    connection: sqlite3.Connection,
    *,
    limit: int = 50,
    cursor: str | None = None,
    now: datetime | str | None = None,
) -> dict[str, Any]:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    end = _parse_utc(normalize_utc_timestamp(now))
    start = end - timedelta(days=DEFAULT_RETENTION_DAYS)
    params: list[Any] = [normalize_utc_timestamp(start), normalize_utc_timestamp(end)]
    where = "ingested_at >= ? AND ingested_at < ?"
    if cursor:
        timestamp, event_id = _decode_cursor(cursor)
        where += " AND (ingested_at, event_id) < (?, ?)"
        params.extend((timestamp, event_id))
    params.append(limit + 1)
    rows = connection.execute(
        f"SELECT event_id, payload_json, ingested_at FROM events WHERE {where} "
        "ORDER BY ingested_at DESC, event_id DESC LIMIT ?", params,
    ).fetchall()
    has_more = len(rows) > limit
    page = rows[:limit]
    items = [{"event": _payload(row), "ingestedAt": str(row["ingested_at"])} for row in page]
    next_cursor = _encode_cursor(str(page[-1]["ingested_at"]), str(page[-1]["event_id"])) if has_more and page else None
    return {"contractVersion": "v2", "items": items, "nextCursor": next_cursor}

