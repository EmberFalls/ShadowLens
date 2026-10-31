from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from fastapi.testclient import TestClient
import pytest

from apps.api.shadow_api.config import Settings
from apps.api.shadow_api.db.database import connect, hash_owner_password, initialize_database
from apps.api.shadow_api.main import create_app

API_ORIGIN = "http://127.0.0.1:8787"
OWNER_PASSWORD = "test-owner-password-long-enough"


@pytest.fixture
def client(tmp_path: Path):
    database = tmp_path / "owner-controls.sqlite3"
    initialize_database(database)
    connection = connect(database)
    try:
        connection.execute(
            "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
            ("local-owner", hash_owner_password(OWNER_PASSWORD), "2026-10-31T00:00:00.000000Z"),
        )
    finally:
        connection.close()
    settings = Settings(database_path=database, dashboard_dist=tmp_path / "missing-dashboard")
    with TestClient(create_app(settings), base_url=API_ORIGIN) as test_client:
        yield test_client, database


def login(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/login",
        headers={"Origin": API_ORIGIN},
        json={"password": OWNER_PASSWORD},
    )
    assert response.status_code == 200


def test_owner_policy_is_persisted_versioned_and_signed_for_enrolled_devices(client) -> None:
    api, _database = client
    login(api)
    initial = api.get("/api/v1/policy")
    assert initial.status_code == 200
    policy = initial.json()
    assert policy["revision"] == 1
    mutable = {key: value for key, value in policy.items() if key not in {"contractVersion", "revision", "updatedAt"}}
    mutable["protectedTerms"] = ["Project Atlas"]

    updated = api.put("/api/v1/policy", headers={"Origin": API_ORIGIN}, json=mutable)
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 2
    assert api.get("/api/v1/policy").json()["protectedTerms"] == ["Project Atlas"]

    enrolled = api.post("/api/v1/devices/enroll", headers={"Origin": API_ORIGIN}, json={"label": "Laptop"})
    assert enrolled.status_code == 201, enrolled.text
    device = enrolled.json()
    headers = {"Authorization": f"Bearer {device['token']}"}
    public_key = api.get("/api/v1/policy/public-key", headers=headers)
    bundle = api.get("/api/v1/policy/bundle", headers=headers)
    assert public_key.status_code == bundle.status_code == 200
    public = public_key.json()
    signed = bundle.json()
    raw_public = base64.b64decode(public["publicKey"], validate=True)
    assert hashlib.sha256(raw_public).hexdigest() == public["keyId"] == device["policyKeyId"]
    assert signed["keyId"] == public["keyId"]
    raw_signature = base64.b64decode(signed["signature"], validate=True)
    der_signature = utils.encode_dss_signature(
        int.from_bytes(raw_signature[:32], "big"), int.from_bytes(raw_signature[32:], "big")
    )
    signed_bytes = json.dumps(
        {key: value for key, value in signed.items() if key != "signature"},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    verifier = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw_public)
    verifier.verify(der_signature, signed_bytes, ec.ECDSA(hashes.SHA256()))
    assert signed["payload"]["protectedTerms"] == ["Project Atlas"]


def test_policy_rejects_weakening_private_key_block_and_invalid_terms(client) -> None:
    api, _database = client
    login(api)
    policy = api.get("/api/v1/policy").json()
    mutable = {key: value for key, value in policy.items() if key not in {"contractVersion", "revision", "updatedAt"}}
    private_key_rule = next(rule for rule in mutable["rules"] if rule["category"] == "SECRET_PRIVATE_KEY")
    private_key_rule["action"] = "WARN"
    response = api.put("/api/v1/policy", headers={"Origin": API_ORIGIN}, json=mutable)
    assert response.status_code == 422

    private_key_rule["action"] = "BLOCK"
    mutable["protectedTerms"] = ["Project Atlas", " project atlas "]
    duplicate = api.put("/api/v1/policy", headers={"Origin": API_ORIGIN}, json=mutable)
    assert duplicate.status_code == 422


def test_privacy_retention_export_and_delete_preserve_enrollment(client) -> None:
    api, database = client
    login(api)
    enrolled = api.post("/api/v1/devices/enroll", headers={"Origin": API_ORIGIN}, json={"label": "Laptop"})
    assert enrolled.status_code == 201
    device = enrolled.json()
    event = {
        "contractVersion": "v2",
        "eventId": "6bde3d14-92bb-461b-89f9-7bacb7fb846c",
        "clientObservedAt": "2026-10-31T08:00:00Z",
        "deviceId": device["deviceId"],
        "kind": "SITE_VISIT",
        "siteId": "CHATGPT",
        "supportStatus": "BEST_EFFORT",
        "reasonCodes": ["UNSUPPORTED_AI_SITE_SEEN"],
    }
    ingested = api.post(
        "/api/v1/events/batch",
        headers={"Authorization": f"Bearer {device['token']}"},
        json={"contractVersion": "v2", "events": [event]},
    )
    assert ingested.status_code == 200

    updated_retention = api.put(
        "/api/v1/privacy/retention",
        headers={"Origin": API_ORIGIN},
        json={"retentionDays": 7},
    )
    assert updated_retention.status_code == 200
    assert updated_retention.json()["retentionDays"] == 7
    assert api.get("/api/v1/privacy/retention").json()["retentionDays"] == 7

    exported = api.get("/api/v1/privacy/export")
    assert exported.status_code == 200
    assert "attachment;" in exported.headers["content-disposition"]
    export = exported.json()
    assert export["retentionDays"] == 7
    assert [item["eventId"] for item in export["events"]] == [event["eventId"]]
    assert export["devices"][0]["deviceLabel"] == "Laptop"
    assert export["devices"][0]["lastMetadataSyncAt"] is not None
    assert export["devices"][0]["lastScannerResult"] == "NOT_REPORTED"
    serialized_export = json.dumps(export)
    assert device["token"] not in serialized_export
    assert OWNER_PASSWORD not in serialized_export

    deleted = api.delete("/api/v1/privacy/events", headers={"Origin": API_ORIGIN})
    assert deleted.status_code == 200
    assert deleted.json() == {"deletedEvents": 1}
    assert api.get("/api/v1/privacy/export").json()["events"] == []
    assert api.get("/api/v1/devices").json()["items"][0]["enrollmentStatus"] == "ACTIVE"
    cleared_device = api.get("/api/v1/devices").json()["items"][0]
    assert cleared_device["lastMetadataSyncAt"] is None
    assert cleared_device["observation"] == "NEVER_SEEN"
    assert api.get("/api/v1/domains").status_code == 200
    connection = connect(database)
    try:
        actions = [row[0] for row in connection.execute("SELECT action FROM owner_audit ORDER BY id")]
    finally:
        connection.close()
    assert "RETENTION_CHANGED" in actions
    assert "EVENTS_DELETED" in actions
