from __future__ import annotations

import pytest
from apcore import Identity

from apcore_mcp.artifacts import ARTIFACT_URI_PREFIX, MCPArtifactStore


def test_artifact_scope_expiry_and_bounds(monkeypatch):
    now = 100.0
    monkeypatch.setattr("apcore_mcp.artifacts.monotonic", lambda: now)
    owner = Identity("agent", "agent", scopes=("media.read",), issuer="auth")
    narrower = Identity("agent", "agent", scopes=(), issuer="auth")
    peer = Identity("peer", "agent", scopes=("media.read",), issuer="auth")
    store = MCPArtifactStore(max_bytes=4, max_entries=1, ttl_seconds=10)

    key = store.put(b"PNG", name="result.png", mime_type="image/png", owner=owner)
    uri = ARTIFACT_URI_PREFIX + key
    assert store.read_uri(uri, owner).content == b"PNG"
    assert store.read_uri(uri, narrower) is None
    assert store.read_uri(uri, peer) is None
    assert store.read_uri(uri, None) is None
    assert store.read_uri(uri + "/other", owner) is None

    with pytest.raises(ValueError, match="size"):
        store.put(b"large", name="result.png", mime_type="image/png", owner=owner)
    with pytest.raises(ValueError, match="full"):
        store.put(b"one", name="result.png", mime_type="image/png", owner=owner)

    now = 110.0
    assert store.read_uri(uri, owner) is None
    assert store.put(b"new", name="new.png", mime_type="image/png", owner=owner) != key
