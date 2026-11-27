"""Caller-aware discovery through the actual MCP HTTP and in-memory transports."""

from __future__ import annotations

import json

import httpx
from apcore import ACL, ACLRule, Executor, Identity, Registry

from apcore_mcp import APCoreMCP
from tests.server.test_scoped_approval_wire import _HttpSession
from tests.server.test_versioned_tool_wire import connected_client


class Report:
    description = "Return a synthetic report"
    documentation = "Report documentation."
    input_schema = {
        "type": "object",
        "$defs": {"Count": {"type": "integer"}},
        "properties": {"count": {"$ref": "#/$defs/Count"}},
        "required": ["count"],
    }
    output_schema = {"type": "object"}

    def __init__(self) -> None:
        self.calls = 0

    async def execute(self, inputs, _context):
        self.calls += 1
        return inputs


async def test_discovery_is_bound_to_http_identity_and_does_not_weaken_execution() -> None:
    module_id = "fixture.report"
    registry = Registry()
    report = Report()
    registry.register(module_id, report, metadata={"documentation": Report.documentation})
    audits = []
    acl = ACL(
        [ACLRule(callers=["@external"], targets=[module_id], effect="allow", conditions={"roles": ["reporter"]})],
        audit_logger=audits.append,
    )

    class Authenticator:
        def authenticate(self, headers):
            return {
                "Bearer reporter": Identity(id="reporter", roles=("reporter",)),
                "Bearer guest": Identity(id="guest", roles=("guest",)),
            }.get(headers.get("authorization"))

    mcp = APCoreMCP(Executor(registry, acl=acl), authenticator=Authenticator(), async_tasks=False)
    async with mcp.async_serve() as app, httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost",
    ) as client:
        reporter = _HttpSession(client, "Bearer reporter")
        guest = _HttpSession(client, "Bearer guest")
        await reporter.initialize()
        await guest.initialize()
        tools = (await reporter.request("tools/list", {}))["tools"]
        assert [tool["name"] for tool in tools] == [module_id]
        assert tools[0]["inputSchema"] == Report.input_schema
        assert (await guest.request("tools/list", {}))["tools"] == []
        uri = f"docs://{module_id}"
        assert [resource["uri"] for resource in (await reporter.request("resources/list", {}))["resources"]] == [uri]
        assert (await guest.request("resources/list", {}))["resources"] == []
        docs = await reporter.request("resources/read", {"uri": uri})
        assert docs["contents"][0]["text"] == Report.documentation
        denied = await client.post("/mcp/", headers=guest.headers, json={
            "jsonrpc": "2.0", "method": "resources/read", "params": {"uri": uri}, "id": 999,
        })
        body = denied.json() if denied.headers["content-type"].startswith("application/json") else json.loads(
            next(line[6:] for line in denied.text.splitlines() if line.startswith("data: "))
        )
        assert "error" in body
        assert Report.documentation not in denied.text
        assert audits == [] and report.calls == 0

        call = {"name": module_id, "arguments": {"count": 3}}
        await reporter.request("tools/list", {})
        denied_call = await guest.request("tools/call", {**call, "arguments": {"count": "invalid"}})
        assert denied_call["isError"]
        assert "Input validation error" not in denied_call["content"][0]["text"]
        assert not (await reporter.request("tools/call", call))["isError"]
        assert len(audits) == 2 and report.calls == 1


async def test_anonymous_mcp_listing_proves_public_access() -> None:
    registry = Registry()
    registry.register("fixture.report", Report(), metadata={"documentation": Report.documentation})
    acl = ACL([ACLRule(callers=["@external"], targets=["fixture.report"], effect="allow", conditions={
        "roles": ["reporter"],
    })])
    async with connected_client(Executor(registry, acl=acl), async_tasks=False) as session:
        assert (await session.list_tools()).tools == []
        assert (await session.list_resources()).resources == []



async def test_discovery_reads_the_current_same_version_registration() -> None:
    registry = Registry()
    module_id = "fixture.report"
    registry.register(module_id, Report(), version="1.0.0", metadata={"documentation": "Original content."})
    async with connected_client(registry, async_tasks=False) as session:
        existing = (await session.list_tools()).tools[0]
        assert existing.inputSchema["required"] == ["count"]

        registry.unregister(module_id)
        replacement = Report()
        replacement_schema = {
            "type": "object",
            "properties": {"label": {"type": "string"}},
            "required": ["label"],
        }
        replacement.input_schema = replacement_schema
        registry.register(module_id, replacement, version="1.0.0", metadata={"documentation": "Updated content."})

        current = (await session.list_tools()).tools[0]
        assert current.inputSchema == replacement_schema
        resource = await session.read_resource(f"docs://{module_id}")
        assert resource.contents[0].text == "Updated content."
