from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.api.shadow_api.config import Settings
from apps.api.shadow_api.db.database import connect, hash_bearer_token, initialize_database
from apps.api.shadow_api.main import create_app
import apps.api.shadow_api.routers.events as events_router

API_ORIGIN = "http://127.0.0.1:8787"
DEVICE_ID = "6bde3d14-92bb-461b-89f9-7bacb7fb846c"
DEVICE_TOKEN = "ss_dev_test_ingestion_credential_with_enough_entropy_98765"


def make_site_visit(*, event_id: str | None = None, device_id: str = DEVICE_ID) -> dict[str, object]:
    return {
        "contractVersion": "v2",
        "eventId": event_id or str(uuid4()),
        "clientObservedAt": "2026-10-31T08:00:00Z",
        "deviceId": device_id,
        "kind": "SITE_VISIT",
        "siteId": "CHATGPT",
        "supportStatus": "UNSUPPORTED",
        "reasonCodes": ["UNSUPPORTED_AI_SITE_SEEN"],
    }


def make_heartbeat(*, event_id: str | None = None, device_id: str = DEVICE_ID, version: str = "0.1.0") -> dict[str, object]:
    return {
        "contractVersion": "v2",
        "eventId": event_id or str(uuid4()),
        "clientObservedAt": "2026-10-31T08:00:00Z",
        "deviceId": device_id,
        "kind": "DEVICE_HEARTBEAT",
        "extensionVersion": version,
    }


def make_submission(*, event_id: str | None = None, device_id: str = DEVICE_ID) -> dict[str, object]:
    return {
        "contractVersion": "v2",
        "eventId": event_id or str(uuid4()),
        "clientObservedAt": "2026-10-31T08:00:00Z",
        "deviceId": device_id,
        "kind": "SUBMISSION",
        "siteId": "SANDBOX",
        "coverageMode": "SANDBOX_GUARDED",
        "decisionAction": "REDACT",
        "disposition": "PAGE_ATTESTED",
        "aggregateTier": "HIGH",
        "scoreBand": "HIGH",
        "categoryCounts": {"PII_EMAIL": 1},
        "policyRevision": 1,
        "engineVersion": "0.1.0",
        "lengthBand": "1_99",
        "reasonCodes": ["DETECTED_PII", "POLICY_REDACT", "PAGE_ACK_RECEIVED"],
    }


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "ingestion.sqlite3"
    initialize_database(path)
    connection = connect(path)
    try:
        connection.execute(
            "INSERT INTO devices(device_id, token_hash, created_at) VALUES (?, ?, ?)",
            (DEVICE_ID, hash_bearer_token(DEVICE_TOKEN), "2026-10-31T00:00:00.000000Z"),
        )
    finally:
        connection.close()
    return path


@pytest.fixture
def client(db_path: Path, tmp_path: Path):
    settings = Settings(database_path=db_path, dashboard_dist=tmp_path / "missing-dashboard")
    with TestClient(create_app(settings), base_url=API_ORIGIN) as test_client:
        yield test_client


def post_batch(client: TestClient, events: list[dict[str, object]], *, token: str = DEVICE_TOKEN):
    return client.post(
        "/api/v1/events/batch",
        headers={"Authorization": f"Bearer {token}"},
        json={"contractVersion": "v2", "events": events},
    )


def test_endpoint_is_registered_and_accepts_sanitized_site_visit(client: TestClient, db_path: Path) -> None:
    event = make_site_visit()
    response = post_batch(client, [event])
    assert response.status_code == 200
    assert response.json() == {"accepted": 1, "duplicates": 0, "rejected": 0}
    connection = connect(db_path)
    try:
        row = connection.execute("SELECT device_id, kind, site_id, payload_json, ingested_at FROM events").fetchone()
        assert row["device_id"] == DEVICE_ID
        assert row["kind"] == "SITE_VISIT"
        assert row["site_id"] == "CHATGPT"
        assert json.loads(row["payload_json"]) == event
        assert row["ingested_at"].endswith("Z")
        assert "." in row["ingested_at"]
    finally:
        connection.close()


def test_accepts_25_events_and_rejects_26_without_partial_writes(client: TestClient, db_path: Path) -> None:
    twenty_five = [make_site_visit() for _ in range(25)]
    accepted = post_batch(client, twenty_five)
    assert accepted.status_code == 200
    assert accepted.json() == {"accepted": 25, "duplicates": 0, "rejected": 0}

    twenty_six = [make_site_visit() for _ in range(26)]
    rejected = post_batch(client, twenty_six)
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "INVALID_REQUEST"
    connection = connect(db_path)
    try:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 25
    finally:
        connection.close()


def test_oversized_body_returns_413_and_invalid_auth_precedes_body_validation(client: TestClient) -> None:
    too_large = b"{" + b" " * (32 * 1024) + b"}"
    invalid_auth = client.post(
        "/api/v1/events/batch",
        headers={"Authorization": "Bearer bad"},
        content=too_large,
    )
    assert invalid_auth.status_code == 401
    assert "32" not in invalid_auth.text

    response = client.post(
        "/api/v1/events/batch",
        headers={"Authorization": f"Bearer {DEVICE_TOKEN}"},
        content=too_large,
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_forged_device_id_rejects_whole_batch(client: TestClient, db_path: Path) -> None:
    valid = make_site_visit()
    forged = make_site_visit(device_id="b4b7a4a0-9f04-4b24-a801-493fd07875db")
    response = post_batch(client, [valid, forged])
    assert response.status_code == 422
    connection = connect(db_path)
    try:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 0
    finally:
        connection.close()


def test_same_event_id_never_mutates_stored_payload_and_counts_duplicates(client: TestClient, db_path: Path) -> None:
    original = make_site_visit()
    first = post_batch(client, [original])
    assert first.json() == {"accepted": 1, "duplicates": 0, "rejected": 0}
    altered = {**original, "supportStatus": "BEST_EFFORT", "reasonCodes": []}
    second = post_batch(client, [altered])
    assert second.json() == {"accepted": 0, "duplicates": 1, "rejected": 0}
    connection = connect(db_path)
    try:
        row = connection.execute("SELECT payload_json FROM events WHERE event_id = ?", (original["eventId"],)).fetchone()
        assert json.loads(row["payload_json"]) == original
    finally:
        connection.close()


def test_duplicate_ids_inside_one_batch_are_counted_without_rewrite(client: TestClient, db_path: Path) -> None:
    event = make_site_visit()
    altered = {**event, "supportStatus": "BEST_EFFORT", "reasonCodes": []}
    response = post_batch(client, [event, altered])
    assert response.json() == {"accepted": 1, "duplicates": 1, "rejected": 0}
    connection = connect(db_path)
    try:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 1
    finally:
        connection.close()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda event: event.update(rawText="must never be accepted"),
        lambda event: event.update(url="https://chatgpt.com/?prompt=secret"),
        lambda event: event.update(coverageMode="SANDBOX_GUARDED"),
        lambda event: event.update(clientObservedAt="2026-10-31T08:00:00+05:30"),
    ],
)
def test_malformed_extra_and_non_utc_fields_are_rejected_without_echo(client: TestClient, mutate) -> None:
    event = make_site_visit()
    mutate(event)
    sentinel = str(event.get("rawText", event.get("url", "")))
    response = post_batch(client, [event])
    assert response.status_code == 422
    if sentinel:
        assert sentinel not in response.text
    assert "rawText" not in response.text


def test_submission_score_state_and_reason_combinations_are_enforced(client: TestClient, db_path: Path) -> None:
    invalid_failed_safe = make_submission()
    invalid_failed_safe.update(
        disposition="FAILED_SAFE",
        decisionAction=None,
        aggregateTier="HIGH",
        scoreBand="HIGH",
    )
    invalid_page_attested = make_submission()
    invalid_page_attested["reasonCodes"] = ["DETECTED_PII"]
    response = post_batch(client, [invalid_failed_safe])
    assert response.status_code == 422
    response = post_batch(client, [invalid_page_attested])
    assert response.status_code == 422
    connection = connect(db_path)
    try:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 0
    finally:
        connection.close()


def test_new_heartbeat_sets_server_time_but_duplicate_does_not_update_it(client: TestClient, db_path: Path) -> None:
    event = make_heartbeat()
    assert post_batch(client, [event]).json()["accepted"] == 1
    connection = connect(db_path)
    try:
        first_seen = connection.execute("SELECT last_heartbeat_at FROM devices WHERE device_id = ?", (DEVICE_ID,)).fetchone()[0]
        assert first_seen is not None
        assert first_seen.endswith("Z")
    finally:
        connection.close()
    altered = {**event, "extensionVersion": "0.2.0"}
    assert post_batch(client, [altered]).json() == {"accepted": 0, "duplicates": 1, "rejected": 0}
    connection = connect(db_path)
    try:
        last_seen = connection.execute("SELECT last_heartbeat_at FROM devices WHERE device_id = ?", (DEVICE_ID,)).fetchone()[0]
        assert last_seen == first_seen
    finally:
        connection.close()


def test_bad_batch_rolls_back_valid_items(client: TestClient, db_path: Path) -> None:
    good = make_site_visit()
    bad = make_heartbeat()
    bad["unknownField"] = "private sentinel"
    response = post_batch(client, [good, bad])
    assert response.status_code == 422
    connection = connect(db_path)
    try:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 0
    finally:
        connection.close()


def test_unavailable_database_returns_503(monkeypatch, client: TestClient) -> None:
    def unavailable(*args, **kwargs):
        raise sqlite3.OperationalError("PRIVATE_DATABASE_DIAGNOSTIC")

    monkeypatch.setattr(events_router, "connect", unavailable)
    response = post_batch(client, [make_site_visit()])
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    assert "PRIVATE_DATABASE_DIAGNOSTIC" not in response.text


def test_revoked_device_is_unauthorized(client: TestClient, db_path: Path) -> None:
    connection = connect(db_path)
    try:
        connection.execute("UPDATE devices SET revoked_at = '2026-10-31T08:00:00.000000Z' WHERE device_id = ?", (DEVICE_ID,))
    finally:
        connection.close()
    response = post_batch(client, [make_site_visit()])
    assert response.status_code == 401


def test_synthetic_privacy_sentinel_rejected_without_echo(client: TestClient) -> None:
    sentinel = "SHADOW_FAKE_DO_NOT_USE_9Q7P2"
    bad_event = make_site_visit()
    bad_event["rawPrompt"] = sentinel
    response = post_batch(client, [bad_event])
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert sentinel not in response.text

