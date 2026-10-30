from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.api.shadow_api.config import Settings
from apps.api.shadow_api.db.database import connect, hash_owner_password, initialize_database, normalize_utc_timestamp
from apps.api.shadow_api.main import create_app
from apps.api.shadow_api.routers.analytics import router as analytics_router
from apps.api.shadow_api.routers.devices import router as devices_router
from apps.api.shadow_api.routers.policy import router as policy_router
from apps.api.shadow_api.services.analytics import InvalidCursor, build_event_page, build_summary, build_timeseries
from apps.api.shadow_api.services.devices import list_devices

API_ORIGIN = "http://127.0.0.1:8787"
OWNER_PASSWORD = "analytics-test-password-long"
DEVICE_ID = "6bde3d14-92bb-461b-89f9-7bacb7fb846c"
NOW = "2026-10-31T08:00:00Z"


def _event(kind: str, ingested_at: str, *, site_id: str = "SANDBOX", action: str | None = "REDACT", disposition: str = "PAGE_ATTESTED", coverage: str = "SANDBOX_GUARDED", category_count: int = 1) -> dict[str, object]:
    event_id = str(uuid4())
    if kind == "SITE_VISIT":
        payload: dict[str, object] = {
            "contractVersion": "v2", "eventId": event_id, "clientObservedAt": "2000-01-01T00:00:00Z",
            "deviceId": DEVICE_ID, "kind": kind, "siteId": site_id,
            "supportStatus": "UNSUPPORTED", "reasonCodes": ["UNSUPPORTED_AI_SITE_SEEN"],
        }
    elif kind == "DEVICE_HEARTBEAT":
        payload = {
            "contractVersion": "v2", "eventId": event_id, "clientObservedAt": "2099-01-01T00:00:00Z",
            "deviceId": DEVICE_ID, "kind": kind, "extensionVersion": "1.0.0",
        }
    else:
        payload = {
            "contractVersion": "v2", "eventId": event_id, "clientObservedAt": "2000-01-01T00:00:00Z",
            "deviceId": DEVICE_ID, "kind": kind, "siteId": site_id, "coverageMode": coverage,
            "decisionAction": action, "disposition": disposition,
            "aggregateTier": "NOT_EVALUATED" if disposition == "FAILED_SAFE" else "HIGH",
            "scoreBand": "NOT_EVALUATED" if disposition == "FAILED_SAFE" else "HIGH",
            "categoryCounts": {"PII_EMAIL": category_count}, "policyRevision": 1,
            "engineVersion": "1.0.0", "lengthBand": "1_99",
            "reasonCodes": ["PAGE_ACK_RECEIVED"] if disposition == "PAGE_ATTESTED" else [],
        }
    return {"event_id": event_id, "kind": kind, "site_id": None if kind == "DEVICE_HEARTBEAT" else site_id,
            "payload_json": json.dumps(payload), "ingested_at": normalize_utc_timestamp(ingested_at), "device_id": DEVICE_ID}


@pytest.fixture
def database(tmp_path: Path) -> Path:
    path = tmp_path / "analytics.sqlite3"
    initialize_database(path)
    connection = connect(path)
    try:
        connection.execute(
            "INSERT INTO owners(owner_id,password_hash,created_at) VALUES (?,?,?)",
            ("local-owner", hash_owner_password(OWNER_PASSWORD), normalize_utc_timestamp(NOW)),
        )
        connection.execute(
            "INSERT INTO devices(device_id,token_hash,created_at) VALUES (?,?,?)",
            (DEVICE_ID, "a" * 64, normalize_utc_timestamp("2026-10-01T00:00:00Z")),
        )
    finally:
        connection.close()
    return path


@pytest.fixture
def client(database: Path, tmp_path: Path):
    settings = Settings(database_path=database, dashboard_dist=tmp_path / "missing")
    app = create_app(settings, routers=[analytics_router, devices_router, policy_router])
    with TestClient(app, base_url=API_ORIGIN) as test_client:
        yield test_client


def _insert(connection, *rows: dict[str, object]) -> None:
    for row in rows:
        connection.execute(
            "INSERT INTO events(event_id,device_id,kind,site_id,payload_json,ingested_at) VALUES (?,?,?,?,?,?)",
            (row["event_id"], row["device_id"], row["kind"], row["site_id"], row["payload_json"], row["ingested_at"]),
        )


def test_summary_reconciles_known_event_matrix_and_ignores_client_clock(database: Path) -> None:
    connection = connect(database)
    try:
        _insert(
            connection,
            _event("SITE_VISIT", "2026-10-31T07:00:00Z", site_id="CHATGPT"),
            _event("SITE_VISIT", "2026-10-31T07:01:00Z", site_id="CHATGPT"),
            _event("SUBMISSION", "2026-10-31T07:02:00Z", action="REDACT", disposition="CANCELLED", category_count=2),
            _event("SUBMISSION", "2026-10-31T07:03:00Z", action="REDACT", disposition="PAGE_ATTESTED", category_count=3),
            _event("SUBMISSION", "2026-10-31T07:04:00Z", action="BLOCK", disposition="BLOCKED", category_count=4),
            _event("SUBMISSION", "2026-10-31T07:05:00Z", action=None, disposition="FAILED_SAFE", category_count=5),
            _event("SUBMISSION", "2026-10-31T07:06:00Z", action="WARN", disposition="CANCELLED", category_count=6),
            _event("DEVICE_HEARTBEAT", "2026-10-31T07:07:00Z"),
        )
        connection.execute("UPDATE devices SET last_heartbeat_at=? WHERE device_id=?", (normalize_utc_timestamp(NOW), DEVICE_ID))
        result = build_summary(connection, days=7, now=NOW)
        assert result["siteVisitsObserved"] == 2
        assert result["distinctAiSitesObserved"] == 1
        assert result["guardedAttempts"] == 5
        assert result["policyBlocks"] == 1
        assert result["failedSafe"] == 1
        assert result["redactionsPlanned"] == 2
        assert result["redactionsPageAttested"] == 1
        assert result["warningsIssued"] == 1
        assert result["pageAttestedReleases"] == 1
        assert result["categories"] == {"PII_EMAIL": 20}
        assert result["freshDevices"] == 1
        assert "retained" in result["coverageNote"]
    finally:
        connection.close()


def test_empty_database_and_30_day_window(database: Path) -> None:
    connection = connect(database)
    try:
        result = build_summary(connection, days=30, now=NOW)
        assert result["windowDays"] == 30
        assert result["siteVisitsObserved"] == 0
        assert result["categories"] == {}
        assert result["fromUtc"] == "2026-10-01T08:00:00.000000Z"
        assert result["observedDevices"] == 0
        assert "Partial coverage" in result["coverageNote"]
    finally:
        connection.close()


def test_timeseries_uses_utc_and_ist_day_boundaries(database: Path) -> None:
    connection = connect(database)
    try:
        _insert(
            connection,
            _event("SITE_VISIT", "2026-10-30T18:29:59Z", site_id="CHATGPT"),
            _event("SITE_VISIT", "2026-10-30T18:30:00Z", site_id="GEMINI"),
            _event("SITE_VISIT", "2026-10-30T23:59:59Z", site_id="CLAUDE"),
            _event("SITE_VISIT", "2026-10-31T00:00:00Z", site_id="COPILOT"),
        )
        utc = build_timeseries(connection, days=2, tz="UTC", now=NOW)
        ist = build_timeseries(connection, days=2, tz="Asia/Kolkata", now=NOW)
        assert [bucket["bucketDateLocal"] for bucket in utc["buckets"]] == ["2026-10-29", "2026-10-30", "2026-10-31"]
        assert [bucket["siteVisitsObserved"] for bucket in utc["buckets"]] == [0, 3, 1]
        assert [bucket["bucketDateLocal"] for bucket in ist["buckets"]] == ["2026-10-29", "2026-10-30", "2026-10-31"]
        assert [bucket["siteVisitsObserved"] for bucket in ist["buckets"]] == [0, 1, 3]
    finally:
        connection.close()


def test_event_page_paginates_by_server_timestamp_and_id(database: Path) -> None:
    connection = connect(database)
    try:
        _insert(connection, *[_event("SITE_VISIT", f"2026-10-31T07:0{i}:00Z", site_id="CHATGPT") for i in range(3)])
        first = build_event_page(connection, limit=2, now=NOW)
        second = build_event_page(connection, limit=2, cursor=first["nextCursor"], now=NOW)
        assert len(first["items"]) == 2
        assert first["items"][0]["ingestedAt"] >= first["items"][1]["ingestedAt"]
        assert first["items"][0]["event"]["clientObservedAt"] != first["items"][0]["ingestedAt"]
        assert len(second["items"]) == 1 and second["nextCursor"] is None
        with pytest.raises(InvalidCursor):
            build_event_page(connection, cursor="bad", now=NOW)
    finally:
        connection.close()


def test_device_status_distinguishes_recent_stale_and_never_seen(database: Path) -> None:
    connection = connect(database)
    try:
        connection.execute("INSERT INTO devices(device_id,token_hash,created_at,last_heartbeat_at) VALUES (?,?,?,?)",
                           ("a1d347bf-0a3a-47cf-b87f-184b1c2cb5b0", "b" * 64, normalize_utc_timestamp(NOW), normalize_utc_timestamp("2026-10-31T07:50:00Z")))
        connection.execute("INSERT INTO devices(device_id,token_hash,created_at,last_heartbeat_at) VALUES (?,?,?,?)",
                           ("b1d347bf-0a3a-47cf-b87f-184b1c2cb5b0", "c" * 64, normalize_utc_timestamp(NOW), normalize_utc_timestamp("2026-10-31T07:40:00Z")))
        result = list_devices(connection, now=NOW)
        statuses = {item["deviceId"]: item["observation"] for item in result["items"]}
        assert statuses[DEVICE_ID] == "NEVER_SEEN"
        assert statuses["a1d347bf-0a3a-47cf-b87f-184b1c2cb5b0"] == "RECENTLY_SEEN"
        assert statuses["b1d347bf-0a3a-47cf-b87f-184b1c2cb5b0"] == "STALE"
    finally:
        connection.close()


def test_owner_authorization_for_analytics_devices_policy_and_policy_is_read_only(client: TestClient) -> None:
    for path in ("/api/v1/analytics/summary", "/api/v1/analytics/timeseries", "/api/v1/analytics/events", "/api/v1/devices", "/api/v1/policy"):
        assert client.get(path).status_code == 401
    login = client.post("/api/v1/auth/login", headers={"Origin": API_ORIGIN}, json={"password": OWNER_PASSWORD})
    assert login.status_code == 200
    assert client.get("/api/v1/analytics/summary").json()["contractVersion"] == "v2"
    assert client.get("/api/v1/devices").json()["contractVersion"] == "v2"
    policy = client.get("/api/v1/policy")
    assert policy.status_code == 200
    assert policy.json()["contractVersion"] == "v2"
    assert client.put("/api/v1/policy", json={}).status_code == 405

