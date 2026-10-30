"""Environment-backed configuration for the local-only API shell."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_ALLOWED_DEV_ORIGINS = {"http://127.0.0.1:5173"}


def _positive_int(name: str, default: int, *, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < 1 or value > maximum:
        raise ValueError(f"{name} is outside its allowed range")
    return value


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8787
    database_path: Path = Path.home() / ".shadowshield" / "shadowshield.sqlite3"
    owner_id: str = "local-owner"
    session_ttl_seconds: int = 14_400
    dashboard_dist: Path = _ROOT / "apps" / "dashboard" / "dist"
    cors_origins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.host != "127.0.0.1":
            raise ValueError("the service host is fixed to 127.0.0.1")
        if not 1 <= self.port <= 65535:
            raise ValueError("port is outside its allowed range")
        if not 1 <= self.session_ttl_seconds <= 86_400:
            raise ValueError("session lifetime is outside its allowed range")
        if any(origin not in _ALLOWED_DEV_ORIGINS for origin in self.cors_origins):
            raise ValueError("CORS origin is outside the fixed allowlist")

    @property
    def api_origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def owner_origins(self) -> frozenset[str]:
        return frozenset((self.api_origin, *self.cors_origins))

    @classmethod
    def from_env(cls) -> "Settings":
        port = _positive_int("SHADOWSHIELD_PORT", 8787, maximum=65535)
        ttl = _positive_int("SHADOWSHIELD_SESSION_TTL_SECONDS", 14_400, maximum=86_400)
        raw_origins = os.environ.get("SHADOWSHIELD_CORS_ORIGINS", "")
        origins = tuple(origin.strip() for origin in raw_origins.split(",") if origin.strip())
        if len(set(origins)) != len(origins) or any(origin not in _ALLOWED_DEV_ORIGINS for origin in origins):
            raise ValueError("SHADOWSHIELD_CORS_ORIGINS contains an origin outside the fixed allowlist")

        raw_db = os.environ.get("SHADOWSHIELD_DATABASE", "~/.shadowshield/shadowshield.sqlite3")
        database_path = Path(raw_db).expanduser()
        if not database_path.is_absolute():
            database_path = (_ROOT / database_path).resolve()
        raw_dashboard = os.environ.get("SHADOWSHIELD_DASHBOARD_DIST", "apps/dashboard/dist")
        dashboard_dist = Path(raw_dashboard).expanduser()
        if not dashboard_dist.is_absolute():
            dashboard_dist = (_ROOT / dashboard_dist).resolve()
        owner_id = os.environ.get("SHADOWSHIELD_OWNER_ID", "local-owner")
        if not owner_id or len(owner_id) > 100:
            raise ValueError("SHADOWSHIELD_OWNER_ID must contain 1 to 100 characters")
        return cls(
            port=port,
            database_path=database_path,
            owner_id=owner_id,
            session_ttl_seconds=ttl,
            dashboard_dist=dashboard_dist,
            cors_origins=origins,
        )
