"""Create isolated synthetic credentials and devices for the local E2E run."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import secrets
import uuid

from apps.api.shadow_api.db.database import (
    connect,
    hash_bearer_token,
    hash_owner_password,
    initialize_database,
    normalize_utc_timestamp,
    transaction,
)


database = Path(os.environ["SHADOWSHIELD_DATABASE"]).resolve()
database.parent.mkdir(parents=True, exist_ok=True)
initialize_database(database)

owner_id = "e2e-owner"
owner_password = "Synthetic-only E2E owner 2026"
device_id = str(uuid.uuid4())
device_token = "ss_dev_" + secrets.token_urlsafe(36)
stale_device_id = str(uuid.uuid4())
stale_device_token = "ss_dev_" + secrets.token_urlsafe(36)
now = datetime.now(timezone.utc)

connection = connect(database)
try:
    with transaction(connection):
        connection.execute(
            "INSERT INTO owners(owner_id, password_hash, created_at) VALUES (?, ?, ?)",
            (owner_id, hash_owner_password(owner_password), normalize_utc_timestamp(now)),
        )
        connection.execute(
            "INSERT INTO devices(device_id, token_hash, device_label, created_at) VALUES (?, ?, ?, ?)",
            (device_id, hash_bearer_token(device_token), "E2E synthetic device", normalize_utc_timestamp(now)),
        )
        connection.execute(
            "INSERT INTO devices(device_id, token_hash, device_label, created_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?)",
            (stale_device_id, hash_bearer_token(stale_device_token), "E2E stale device", normalize_utc_timestamp(now - timedelta(days=2)), normalize_utc_timestamp(now - timedelta(hours=2))),
        )
finally:
    connection.close()

print(json.dumps({"ownerId": owner_id, "ownerPassword": owner_password, "deviceId": device_id, "deviceToken": device_token, "staleDeviceId": stale_device_id}))
