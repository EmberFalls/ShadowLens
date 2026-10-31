"""Per-installation P-256 signing for versioned owner policy bundles."""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
from functools import lru_cache

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from ..db.database import normalize_utc_timestamp

ALGORITHM = "ECDSA_P256_SHA256"


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


class PolicySigner:
    def __init__(self, key_path: Path) -> None:
        self.key_path = key_path.expanduser().resolve()
        self.key_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name != "nt":
            self.key_path.parent.chmod(0o700)
        if self.key_path.exists():
            if os.name != "nt" and self.key_path.stat().st_mode & 0o077:
                raise PermissionError("policy signing key permissions must be owner-only")
            key_data = self.key_path.read_bytes()
        else:
            generated = ec.generate_private_key(ec.SECP256R1())
            key_data = generated.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            try:
                descriptor = os.open(self.key_path, flags, 0o600)
            except FileExistsError:
                key_data = self.key_path.read_bytes()
            else:
                with os.fdopen(descriptor, "wb") as key_file:
                    key_file.write(key_data)
                    key_file.flush()
                    os.fsync(key_file.fileno())
        loaded = serialization.load_pem_private_key(key_data, password=None)
        if not isinstance(loaded, ec.EllipticCurvePrivateKey) or not isinstance(loaded.curve, ec.SECP256R1):
            raise ValueError("policy signing key must use P-256")
        self._private_key = loaded
        self.public_key = loaded.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        self.key_id = hashlib.sha256(self.public_key).hexdigest()

    def public_document(self) -> dict[str, str]:
        return {
            "algorithm": ALGORITHM,
            "keyId": self.key_id,
            "publicKey": base64.b64encode(self.public_key).decode("ascii"),
        }

    def hash_rate_limit_subject(self, subject: str) -> str:
        """Keyed address fingerprint for login throttling; raw addresses are never stored."""
        private_bytes = self._private_key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        pepper = hashlib.sha256(b"shadowlens-login-limit-v1\0" + private_bytes).digest()
        return hmac.new(pepper, subject.encode("utf-8", errors="strict"), hashlib.sha256).hexdigest()

    def sign(self, policy: dict[str, object], *, now: datetime | None = None) -> dict[str, object]:
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            raise ValueError("signing time must include a timezone")
        issued_at = normalize_utc_timestamp(current)
        expires_at = normalize_utc_timestamp(current + timedelta(days=30))
        unsigned: dict[str, object] = {
            "algorithm": ALGORITHM,
            "keyId": self.key_id,
            "issuedAt": issued_at,
            "expiresAt": expires_at,
            "payload": policy,
        }
        der_signature = self._private_key.sign(canonical_json(unsigned), ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der_signature)
        raw_signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return {**unsigned, "signature": base64.b64encode(raw_signature).decode("ascii")}


@lru_cache(maxsize=4)
def get_policy_signer(key_path: str) -> PolicySigner:
    return PolicySigner(Path(key_path))
