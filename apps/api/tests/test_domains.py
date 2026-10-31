from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from apps.api.shadow_api.config import Settings
from apps.api.shadow_api.db.database import connect, hash_owner_password, initialize_database, normalize_utc_timestamp
from apps.api.shadow_api.main import create_app
from apps.api.shadow_api.routers.domains import router as domains_router

API_ORIGIN = "http://127.0.0.1:8787"
PASSWORD = "domain-test-password-long-enough"


def test_domains_list_and_approval_update_are_authenticated_informational_views(tmp_path: Path) -> None:
    path = tmp_path / "domains.sqlite3"
    initialize_database(path)
    connection = connect(path)
    try:
        connection.execute("INSERT INTO owners(owner_id,password_hash,created_at) VALUES (?,?,?)",
                           ("local-owner", hash_owner_password(PASSWORD), normalize_utc_timestamp()))
    finally:
        connection.close()
    settings = Settings(database_path=path, dashboard_dist=tmp_path / "missing")
    app = create_app(settings, routers=[domains_router])
    with TestClient(app, base_url=API_ORIGIN) as client:
        assert client.get("/api/v1/domains").status_code == 401
        client.post("/api/v1/auth/login", headers={"Origin": API_ORIGIN}, json={"password": PASSWORD})
        result = client.get("/api/v1/domains")
        assert result.status_code == 200
        assert len(result.json()) == 6
        chatgpt = next(domain for domain in result.json() if domain["siteId"] == "CHATGPT")
        assert chatgpt["approvalStatus"] == "UNREVIEWED"
        assert chatgpt["supportStatus"] == "BEST_EFFORT"
        assert chatgpt["siteVisitsObserved"] == 0
        assert chatgpt["bestEffortAttempts"] == 0

        changed = client.put(
            "/api/v1/domains/CHATGPT/approval",
            headers={"Origin": API_ORIGIN},
            json={"approvalStatus": "APPROVED"},
        )
        assert changed.status_code == 200
        assert changed.json()["approvalStatus"] == "APPROVED"
        assert changed.json()["supportStatus"] == "BEST_EFFORT"
        assert client.put(
            "/api/v1/domains/CHATGPT/approval",
            headers={"Origin": "http://localhost:4173"},
            json={"approvalStatus": "UNAPPROVED"},
        ).status_code == 403
        history = connect(path)
        try:
            row = history.execute("SELECT old_status,new_status FROM domain_approval_changes WHERE site_id='CHATGPT'").fetchone()
            assert tuple(row) == ("UNREVIEWED", "APPROVED")
        finally:
            history.close()
