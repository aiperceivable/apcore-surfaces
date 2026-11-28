"""In-process MCP media references owned by a trusted application."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from threading import Lock
from time import monotonic
from uuid import uuid4

from apcore import Identity

ARTIFACT_URI_PREFIX = "apcore-artifact://"
_ARTIFACT_ID = re.compile("[a-f0-9]{32}")
_MEDIA_TYPE = re.compile(r"[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+")


def _authority(identity: Identity) -> tuple[str | None, str, str, tuple[str, ...], str | None]:
    return identity.issuer, identity.type, identity.id, tuple(sorted(identity.roles)), identity.authority_key()


@dataclass(frozen=True, slots=True)
class _Artifact:
    content: bytes
    name: str
    mime_type: str
    owner: tuple[str | None, str, str, tuple[str, ...], str | None]
    expires_at: float


class MCPArtifactStore:
    """Bounded byte store for an opted-in MCP host."""

    def __init__(self, *, max_bytes: int = 8_388_608, max_entries: int = 16, ttl_seconds: float = 300) -> None:
        if type(max_bytes) is not int or max_bytes < 1:
            raise ValueError("Artifact size limit must be a positive integer")
        if type(max_entries) is not int or max_entries < 1:
            raise ValueError("Artifact entry limit must be a positive integer")
        if type(ttl_seconds) not in (int, float) or not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("Artifact expiry must be positive and finite")
        self._max_bytes = max_bytes
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._items: dict[str, _Artifact] = {}
        self._lock = Lock()

    def put(self, content: bytes, *, name: str, mime_type: str, owner: Identity) -> str:
        """Register in-memory bytes for the current trusted authority."""
        if type(content) is not bytes or len(content) > self._max_bytes:
            raise ValueError("Artifact content must be bytes within the size limit")
        if not name or len(name) > 200 or any(char in name for char in ("/", chr(92))) or not name.isprintable():
            raise ValueError("Artifact name must be a printable filename")
        if len(mime_type) > 127 or not _MEDIA_TYPE.fullmatch(mime_type):
            raise ValueError("Artifact MIME type is invalid")
        if not isinstance(owner, Identity) or not owner.id:
            raise ValueError("An authenticated artifact owner is required")
        authority = _authority(owner)
        with self._lock:
            now = monotonic()
            expired = [key for key, artifact in self._items.items() if artifact.expires_at <= now]
            for key in expired:
                del self._items[key]
            if len(self._items) >= self._max_entries:
                raise ValueError("Artifact store is full")
            key = uuid4().hex
            self._items[key] = _Artifact(content, name, mime_type, authority, now + self._ttl_seconds)
        return key

    def read_uri(self, uri: str, identity: Identity | None) -> _Artifact | None:
        """Return a live artifact only for the authority that registered it."""
        if identity is None or not uri.startswith(ARTIFACT_URI_PREFIX):
            return None
        key = uri.removeprefix(ARTIFACT_URI_PREFIX)
        if not _ARTIFACT_ID.fullmatch(key):
            return None
        authority = _authority(identity)
        with self._lock:
            artifact = self._items.get(key)
            if artifact is None:
                return None
            if artifact.expires_at <= monotonic():
                del self._items[key]
                return None
            if artifact.owner != authority:
                return None
            return artifact
