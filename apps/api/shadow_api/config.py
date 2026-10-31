"""Environment-backed configuration for local and reverse-proxy deployments."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import os
from pathlib import Path
from urllib.parse import urlsplit

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
    public_origin: str | None = None
    policy_signing_key_path: Path | None = None
    trusted_proxy_ips: tuple[str, ...] = ("127.0.0.1",)

    def __post_init__(self) -> None:
        if self.host not in {"127.0.0.1", "0.0.0.0"}:
            raise ValueError("bind host must be loopback or 0.0.0.0 behind a trusted TLS proxy")
        if not 1 <= self.port <= 65535:
            raise ValueError("port is outside its allowed range")
        if not 1 <= self.session_ttl_seconds <= 86_400:
            raise ValueError("session lifetime is outside its allowed range")
        if any(origin not in _ALLOWED_DEV_ORIGINS for origin in self.cors_origins):
            raise ValueError("CORS origin is outside the fixed allowlist")
        if not self.trusted_proxy_ips:
            raise ValueError("at least one trusted proxy IP or network must be configured")
        for proxy in self.trusted_proxy_ips:
            try:
                network = ipaddress.ip_network(proxy, strict=False)
            except ValueError as exc:
                raise ValueError("trusted proxy entries must be IP addresses or CIDR networks") from exc
            if network.prefixlen == 0:
                raise ValueError("trusted proxy networks cannot include every IP address")
        if self.public_origin is not None:
            if self.cors_origins:
                raise ValueError("development CORS origins must be disabled for a public service")
            parsed = urlsplit(self.public_origin)
            if parsed.scheme != "https" or not parsed.netloc or parsed.netloc != parsed.netloc.lower() or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("public origin must be an HTTPS origin without a path")
            try:
                public_port = parsed.port
            except ValueError as exc:
                raise ValueError("public origin contains an invalid port") from exc
            hostname = parsed.hostname or ""
            canonical_netloc = f"[{hostname}]" if ":" in hostname else hostname
            if public_port is not None:
                canonical_netloc += f":{public_port}"
            if parsed.netloc != canonical_netloc:
                raise ValueError("public origin must use a canonical host and port")
            if public_port == 443:
                raise ValueError("public origin must omit the default HTTPS port")
            if public_port == 0:
                raise ValueError("public origin port is outside its allowed range")
        if self.host == "0.0.0.0" and self.public_origin is None:
            raise ValueError("public HTTPS origin is required when binding beyond loopback")

    @property
    def api_origin(self) -> str:
        return self.public_origin or f"http://127.0.0.1:{self.port}"

    @property
    def owner_origins(self) -> frozenset[str]:
        return frozenset((self.api_origin, *self.cors_origins))

    @property
    def trusted_hosts(self) -> tuple[str, ...]:
        hosts = {"127.0.0.1", f"127.0.0.1:{self.port}"}
        if self.public_origin:
            parsed = urlsplit(self.public_origin)
            hosts.add(parsed.hostname or "")
            hosts.add(parsed.netloc)
        return tuple(sorted(host for host in hosts if host))

    @property
    def secure_cookies(self) -> bool:
        return self.public_origin is not None

    @property
    def forwarded_allow_ips(self) -> str:
        return ",".join(self.trusted_proxy_ips)

    @property
    def resolved_policy_signing_key_path(self) -> Path:
        if self.policy_signing_key_path is not None:
            return self.policy_signing_key_path
        return self.database_path.parent / "policy-signing-key.pem"

    @classmethod
    def from_env(cls) -> "Settings":
        bind_host = os.environ.get("SHADOWSHIELD_BIND_HOST", "127.0.0.1")
        public_origin = os.environ.get("SHADOWSHIELD_PUBLIC_ORIGIN") or None
        port = _positive_int("SHADOWSHIELD_PORT", 8787, maximum=65535)
        ttl = _positive_int("SHADOWSHIELD_SESSION_TTL_SECONDS", 14_400, maximum=86_400)
        raw_origins = os.environ.get("SHADOWSHIELD_CORS_ORIGINS", "")
        origins = tuple(origin.strip() for origin in raw_origins.split(",") if origin.strip())
        if len(set(origins)) != len(origins) or any(origin not in _ALLOWED_DEV_ORIGINS for origin in origins):
            raise ValueError("SHADOWSHIELD_CORS_ORIGINS contains an origin outside the fixed allowlist")
        raw_proxy_ips = os.environ.get("SHADOWSHIELD_TRUSTED_PROXY_IPS", "127.0.0.1")
        trusted_proxy_ips = tuple(item.strip() for item in raw_proxy_ips.split(",") if item.strip())
        if not trusted_proxy_ips:
            raise ValueError("SHADOWSHIELD_TRUSTED_PROXY_IPS must contain at least one IP or CIDR network")

        raw_db = os.environ.get("SHADOWSHIELD_DATABASE", "~/.shadowshield/shadowshield.sqlite3")
        database_path = Path(raw_db).expanduser()
        if not database_path.is_absolute():
            database_path = (_ROOT / database_path).resolve()
        raw_dashboard = os.environ.get("SHADOWSHIELD_DASHBOARD_DIST", "apps/dashboard/dist")
        dashboard_dist = Path(raw_dashboard).expanduser()
        if not dashboard_dist.is_absolute():
            dashboard_dist = (_ROOT / dashboard_dist).resolve()
        raw_signing_key = os.environ.get("SHADOWSHIELD_POLICY_SIGNING_KEY")
        signing_key_path = None
        if raw_signing_key:
            signing_key_path = Path(raw_signing_key).expanduser()
            if not signing_key_path.is_absolute():
                signing_key_path = (_ROOT / signing_key_path).resolve()
        owner_id = os.environ.get("SHADOWSHIELD_OWNER_ID", "local-owner")
        if not owner_id or len(owner_id) > 100:
            raise ValueError("SHADOWSHIELD_OWNER_ID must contain 1 to 100 characters")
        return cls(
            host=bind_host,
            port=port,
            database_path=database_path,
            owner_id=owner_id,
            session_ttl_seconds=ttl,
            dashboard_dist=dashboard_dist,
            cors_origins=origins,
            public_origin=public_origin,
            policy_signing_key_path=signing_key_path,
            trusted_proxy_ips=trusted_proxy_ips,
        )
