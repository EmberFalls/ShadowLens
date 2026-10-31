from __future__ import annotations

import logging
from pathlib import Path

from fastapi.testclient import TestClient
import httpx
import pytest

from apps.api.shadow_api.config import Settings
from apps.api.shadow_api.db.database import connect, hash_owner_password, initialize_database
from apps.api.shadow_api.main import create_app
from apps.api.shadow_api.security import OWNER_COOKIE_NAME

API_ORIGIN = "http://127.0.0.1:8787"
OWNER_PASSWORD = "test-owner-password-long-enough"


@pytest.fixture
def api_settings(tmp_path: Path) -> Settings:
    database = tmp_path / "auth.sqlite3"
    initialize_database(database)
    connection = connect(database)
    try:
        connection.execute(
            "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
            ("local-owner", hash_owner_password(OWNER_PASSWORD), "2026-10-31T00:00:00.000000Z"),
        )
    finally:
        connection.close()
    return Settings(database_path=database, dashboard_dist=tmp_path / "missing-dashboard")


@pytest.fixture
def client(api_settings: Settings):
    with TestClient(create_app(api_settings), base_url=API_ORIGIN) as test_client:
        yield test_client


def login(client: TestClient, password: str = OWNER_PASSWORD):
    return client.post(
        "/api/v1/auth/login",
        headers={"Origin": API_ORIGIN},
        json={"password": password},
    )


def test_health_returns_v2_and_database_ready(client: TestClient) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "db": "ready", "contractVersion": "v2"}
    assert response.headers.get("x-request-id")


def test_login_sets_host_only_strict_http_only_cookie(client: TestClient) -> None:
    response = login(client)
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    cookie = response.headers["set-cookie"].lower()
    assert f"{OWNER_COOKIE_NAME}=" in cookie
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "path=/api/v1" in cookie
    assert "domain=" not in cookie
    assert "secure" not in cookie
    assert client.get("/api/v1/auth/me").json() == {"authenticated": True}


def test_owner_cookie_is_not_sent_to_sandbox_host(client: TestClient) -> None:
    response = login(client)
    assert response.status_code == 200
    jar = httpx.Cookies()
    jar.extract_cookies(response)
    sandbox_request = httpx.Request("GET", "http://localhost:4173/api/v1/auth/me")
    jar.set_cookie_header(sandbox_request)
    assert "cookie" not in sandbox_request.headers


def test_bad_password_and_missing_cookie_are_fixed_unauthorized_responses(client: TestClient) -> None:
    response = login(client, "incorrect password")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"
    assert "incorrect password" not in response.text
    assert "set-cookie" not in response.headers
    missing = client.get("/api/v1/auth/me")
    assert missing.status_code == 401
    assert missing.json()["error"]["message"] == "Authentication required."


def test_login_rejects_missing_and_untrusted_origins(client: TestClient) -> None:
    missing = client.post("/api/v1/auth/login", json={"password": OWNER_PASSWORD})
    assert missing.status_code == 403
    hostile = login(client)
    assert hostile.status_code == 200
    rejected = client.post(
        "/api/v1/auth/logout",
        headers={"Origin": "http://localhost:4173"},
    )
    assert rejected.status_code == 403
    assert client.get("/api/v1/auth/me").status_code == 200


def test_logout_invalidates_session_and_expires_cookie(client: TestClient) -> None:
    assert login(client).status_code == 200
    response = client.post("/api/v1/auth/logout", headers={"Origin": API_ORIGIN})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    cookie = response.headers["set-cookie"].lower()
    assert f"{OWNER_COOKIE_NAME}=" in cookie
    assert "max-age=0" in cookie
    assert client.get("/api/v1/auth/me").status_code == 401


def test_host_header_abuse_is_rejected(client: TestClient) -> None:
    response = client.get("/api/v1/health", headers={"Host": "attacker.example"})
    assert response.status_code in {400, 403}
    assert "attacker.example" not in response.text
    wrong_port = client.get("/api/v1/health", headers={"Host": "127.0.0.1:9999"})
    assert wrong_port.status_code == 400


def test_validation_and_internal_errors_do_not_echo_or_log_request_body(client: TestClient, caplog) -> None:
    caplog.set_level(logging.ERROR, logger="shadowshield.api")
    sentinel = "SHADOW_FAKE_DO_NOT_USE_9Q7P2"
    response = client.post(
        "/api/v1/auth/login",
        headers={"Origin": API_ORIGIN},
        json={"password": OWNER_PASSWORD, "unknown": sentinel},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert sentinel not in response.text
    assert sentinel not in caplog.text


def test_auth_session_survives_app_restart_and_is_only_hash_persisted(api_settings: Settings) -> None:
    with TestClient(create_app(api_settings), base_url=API_ORIGIN) as first:
        response = login(first)
        assert response.status_code == 200
        secret = response.cookies.get(OWNER_COOKIE_NAME)
        assert secret
        assert first.get("/api/v1/auth/me").status_code == 200

    connection = connect(api_settings.database_path)
    try:
        row = connection.execute("SELECT id FROM owner_sessions").fetchone()
        assert row is not None
        assert row["id"] != secret
        assert len(row["id"]) == 64
    finally:
        connection.close()

    with TestClient(create_app(api_settings), base_url=API_ORIGIN, cookies={OWNER_COOKIE_NAME: secret}) as second:
        assert second.get("/api/v1/auth/me").status_code == 200
    for path in api_settings.database_path.parent.glob(api_settings.database_path.name + "*"):
        data = path.read_bytes()
        assert secret.encode() not in data
        assert OWNER_PASSWORD.encode() not in data


def test_default_app_registers_owner_routes_and_protects_them(api_settings: Settings) -> None:
    app = create_app(api_settings)
    with TestClient(app, base_url=API_ORIGIN) as test_client:
        denied = test_client.get("/api/v1/analytics/summary")
        assert denied.status_code == 401
        assert denied.json()["error"]["code"] == "UNAUTHORIZED"
        owner_routes = (
            ("GET", "/api/v1/domains"), ("GET", "/api/v1/devices"),
            ("GET", "/api/v1/policy"), ("GET", "/api/v1/policy/key"),
            ("GET", "/api/v1/privacy/retention"), ("GET", "/api/v1/privacy/export"),
        )
        for method, path in owner_routes:
            response = test_client.request(method, path)
            assert response.status_code == 401, path
        assert test_client.delete("/api/v1/privacy/events").status_code == 401
        assert login(test_client).status_code == 200
        assert test_client.get("/api/v1/analytics/summary").status_code == 200


def test_debug_is_disabled_and_internal_error_is_sanitized(api_settings: Settings, caplog) -> None:
    class BrokenStore:
        def password_hash_for_owner(self, owner_id: str) -> str | None:
            raise RuntimeError("INTERNAL_BODY_SECRET")

        def create_session(self, owner_id: str, session_hash: str, expires_at: str) -> None:
            raise AssertionError("not reached")

        def resolve_session(self, session_hash: str, now: str) -> str | None:
            return None

        def delete_session(self, session_hash: str) -> None:
            return None

    app = create_app(api_settings, auth_store=BrokenStore())
    assert app.debug is False
    caplog.set_level(logging.ERROR, logger="shadowshield.api")
    with TestClient(app, base_url=API_ORIGIN) as test_client:
        response = login(test_client)
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"
    assert "INTERNAL_BODY_SECRET" not in response.text
    assert "INTERNAL_BODY_SECRET" not in caplog.text


def test_static_dashboard_assets_are_served_after_api_routes(tmp_path: Path) -> None:
    database = tmp_path / "static.sqlite3"
    initialize_database(database)
    connection = connect(database)
    try:
        connection.execute(
            "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
            ("local-owner", hash_owner_password(OWNER_PASSWORD), "2026-10-31T00:00:00.000000Z"),
        )
    finally:
        connection.close()
    dashboard = tmp_path / "dashboard"
    dashboard.mkdir()
    (dashboard / "index.html").write_text("<h1>ShadowShield dashboard</h1>", encoding="utf-8")
    settings = Settings(database_path=database, dashboard_dist=dashboard)
    with TestClient(create_app(settings), base_url=API_ORIGIN) as test_client:
        assert test_client.get("/").status_code == 200
        assert "ShadowShield dashboard" in test_client.get("/").text
        assert test_client.get("/api/v1/health").json()["contractVersion"] == "v2"


def test_cors_is_exact_and_sandbox_origin_is_not_allowed(tmp_path: Path) -> None:
    database = tmp_path / "cors.sqlite3"
    settings = Settings(database_path=database, dashboard_dist=tmp_path / "missing", cors_origins=("http://127.0.0.1:5173",))
    with TestClient(create_app(settings), base_url=API_ORIGIN) as test_client:
        accepted = test_client.options(
            "/api/v1/auth/login",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert accepted.headers.get("access-control-allow-origin") == "http://127.0.0.1:5173"
        rejected = test_client.options(
            "/api/v1/auth/login",
            headers={
                "Origin": "http://localhost:4173",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert "access-control-allow-origin" not in rejected.headers
