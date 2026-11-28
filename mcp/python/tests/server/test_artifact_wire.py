"""Exercise the opted-in artifact pilot through the MCP HTTP entry point."""

from __future__ import annotations

import base64
import json

import httpx
from apcore import ACL, ACLRule, Executor, Identity, Registry

from apcore_mcp import APCoreMCP, MCPArtifactStore
from tests.server.test_scoped_approval_wire import _HttpSession


async def test_tool_link_and_binary_read_require_the_registered_authority():
    owner = Identity("owner", "agent", issuer="test", scopes=("render",))
    guest = Identity("guest", "agent", issuer="test", scopes=("render",))
    store = MCPArtifactStore(max_bytes=1024)
    artifact_id = store.put(b"image bytes", name="preview.png", mime_type="image/png", owner=owner)

    class Authenticator:
        def authenticate(self, headers):
            return {"Bearer owner": owner, "Bearer guest": guest}.get(headers.get("authorization"))

    class Preview:
        description = "Return a generated preview"
        input_schema = {"type": "object", "properties": {}}
        output_schema = {
            "type": "object",
            "properties": {"artifact": {"type": "string", "x-mcp-artifact": True}},
            "required": ["artifact"],
        }

        async def execute(self, _inputs, _context):
            return {"artifact": artifact_id}

    registry = Registry()
    registry.register("media.preview", Preview())
    acl = ACL(
        [ACLRule(callers=["@external"], targets=["media.preview"], effect="allow", conditions={"scopes": ["render"]})],
        default_effect="deny",
    )
    mcp = APCoreMCP(
        Executor(registry, acl=acl), authenticator=Authenticator(), artifact_store=store, async_tasks=False,
    )
    async with mcp.async_serve() as app, httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost",
    ) as client:
        owner_session = _HttpSession(client, "Bearer owner")
        guest_session = _HttpSession(client, "Bearer guest")
        await owner_session.initialize()
        await guest_session.initialize()
        call = {"name": "media.preview", "arguments": {}}
        result = await owner_session.request("tools/call", call)
        assert not result["isError"]
        assert result["structuredContent"] == {"artifact": artifact_id}
        assert json.loads(result["content"][0]["text"]) == {"artifact": artifact_id}
        link = result["content"][1]
        assert link["type"] == "resource_link"
        assert link["name"] == "preview.png"
        assert link["mimeType"] == "image/png"
        assert "blob" not in link

        read = {"uri": link["uri"]}
        binary = (await owner_session.request("resources/read", read))["contents"][0]
        assert binary["mimeType"] == "image/png"
        assert base64.b64decode(binary["blob"]) == b"image bytes"

        guest_result = await guest_session.request("tools/call", call)
        assert [item["type"] for item in guest_result["content"]] == ["text"]
        denied = await client.post("/mcp/", headers=guest_session.headers, json={
            "jsonrpc": "2.0", "method": "resources/read", "params": read, "id": 99,
        })
        body = denied.json() if denied.headers["content-type"].startswith("application/json") else json.loads(
            next(line[6:] for line in denied.text.splitlines() if line.startswith("data: "))
        )
        assert "error" in body
        assert "blob" not in denied.text
