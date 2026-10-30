"""SQLite persistence primitives for the local ShadowShield API."""

from .database import (
    DEFAULT_RETENTION_DAYS,
    connect,
    initialize_database,
    insert_event,
    hash_bearer_token,
    hash_owner_password,
    hash_session_id,
    migrate,
    normalize_utc_timestamp,
    prune_events,
    seed_domains,
    update_domain_approval,
    verify_bearer_token,
    verify_owner_password,
)

__all__ = [
    "DEFAULT_RETENTION_DAYS",
    "connect",
    "initialize_database",
    "insert_event",
    "hash_bearer_token",
    "hash_owner_password",
    "hash_session_id",
    "migrate",
    "normalize_utc_timestamp",
    "prune_events",
    "seed_domains",
    "update_domain_approval",
    "verify_bearer_token",
    "verify_owner_password",
]
