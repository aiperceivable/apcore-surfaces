"""Phase B through the real MCP request handler and the Core approval gate."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx
import pytest
from apcore import AlwaysDenyHandler, Executor, Identity, ModuleAnnotations, Registry
from mcp.server.lowlevel import Server
from mcp.shared import session as mcp_session
from starlette.responses import JSONResponse

from apcore_mcp import APCoreMCP
from apcore_mcp.adapters.approval import _CORE_SCOPED_APPROVAL
from apcore_mcp.approval_store import InMemoryApprovalStore
from apcore_mcp.server.approval_bridge import _ApprovalLogMiddleware, _protect_sdk_approval_logs
from tests.server.test_versioned_tool_wire import connected_client

_TOOL = "fixture.approved_report"
_requires_scoped_core = pytest.mark.skipif(not _CORE_SCOPED_APPROVAL, reason="requires scoped Core approval")


class Report:
    description = "Return an approved synthetic report"
    input_schema = {
        "type": "object",
        "properties": {"count": {"type": "integer"}},
        "required": ["count"],
        "additionalProperties": False,
    }
    output_schema = {"type": "object"}
    annotations = ModuleAnnotations(requires_approval=True)

    def __init__(self) -> None:
        self.inputs = []

    async def execute(self, inputs, context):
        self.inputs.append(inputs.copy())
        return inputs


class StreamingReport(Report):
    annotations = ModuleAnnotations(requires_approval=True, streaming=True)

    async def stream(self, inputs, context):
        self.inputs.append(inputs.copy())
        yield inputs


def test_phase_b_preserves_a_supplied_executors_existing_handler() -> None:
    executor = Executor(Registry(), approval_handler=AlwaysDenyHandler())

    with pytest.raises(ValueError, match="already has an approval handler"):
        APCoreMCP(executor, approval_store=InMemoryApprovalStore())


@_requires_scoped_core
@pytest.mark.parametrize("tool_type", [Report, StreamingReport])
async def test_pending_credentials_and_status_round_trip_through_core(tool_type, caplog) -> None:
    registry = Registry()
    report = tool_type()
    registry.register(_TOOL, report)
    store = InMemoryApprovalStore()
    notifications = []
    audit_events = []

    class EventRecorder:
        def emit(self, event):
            if event.event_type == "apcore.approval.decision":
                audit_events.append(event.data)

    executor = Executor(registry, event_emitter=EventRecorder())

    async def notify(approval_id, module_id, arguments):
        notifications.append((approval_id, module_id, arguments))

    with caplog.at_level("DEBUG"):
        async with connected_client(
            executor, approval_store=store, approval_notify=notify, validate_inputs=True, trace=True,
        ) as session:
            pending = await session.call_tool(_TOOL, {"count": 1})
            assert pending.isError
            approval = pending.meta["apcore"]["approval"]
            public_id, credential = approval["approvalId"], approval["resumeToken"]
            assert public_id != credential
            assert report.inputs == []
            assert notifications == [(public_id, _TOOL, {"count": 1})]
            assert credential not in repr(pending.content)
            poll = await session.call_tool("__apcore_approval_check", {"approval_id": public_id})
            assert json.loads(poll.content[0].text)["status"] == "pending"
            assert credential not in poll.model_dump_json()
            still_pending = await session.call_tool(_TOOL, {"count": 1}, meta={"approvalId": credential})
            assert still_pending.isError
            assert still_pending.meta["apcore"]["approval"] == approval
            assert await store.resolve(public_id, approved=True)
            approved = await session.call_tool("__apcore_approval_check", {"approval_id": public_id})
            assert json.loads(approved.content[0].text)["status"] == "approved"
            other_scope = await session.call_tool(_TOOL, {"count": 2}, meta={"approvalId": credential})
            assert other_scope.isError
            assert "apcore" not in (other_scope.meta or {})
            assert report.inputs == []

            requests = [session.call_tool(_TOOL, {"count": 1}, meta={"approvalId": credential}) for _ in range(2)]
            first, second = await asyncio.gather(*requests)
            assert sorted(result.isError for result in (first, second)) == [False, True]
            result = next(result for result in (first, second) if not result.isError)
            assert result.structuredContent == {"count": 1}
    assert report.inputs == [{"count": 1}]
    if credential in caplog.text:
        pytest.fail("Approval credential entered debug logs")
    assert credential not in repr(audit_events)
    assert any(event["approval_id"] == public_id for event in audit_events)


class _HttpSession:
    def __init__(self, client: httpx.AsyncClient, principal: str) -> None:
        self.client = client
        self.headers = {
            "accept": "application/json, text/event-stream",
            "authorization": principal,
            "mcp-protocol-version": "2025-06-18",
        }
        self.request_id = 0

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.request_id += 1
        response = await self.client.post("/mcp/", headers=self.headers, json={
            "jsonrpc": "2.0", "method": method, "params": params, "id": self.request_id,
        })
        assert response.status_code == 200
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            self.headers["mcp-session-id"] = session_id
        if response.headers.get("content-type", "").startswith("application/json"):
            return response.json()["result"]
        return json.loads(next(line[6:] for line in response.text.splitlines() if line.startswith("data: ")))["result"]

    async def initialize(self) -> None:
        await self.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"},
        })
        response = await self.client.post("/mcp/", headers=self.headers, json={
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })
        assert response.status_code == 202


@_requires_scoped_core
async def test_streamable_http_poll_and_resume_are_bound_to_the_authenticated_identity(caplog) -> None:
    class Authenticator:
        def authenticate(self, headers):
            return {
                "Bearer fixture-owner": Identity(id="owner"),
                "Bearer fixture-reader": Identity(id="reader"),
            }.get(headers.get("authorization"))

    registry = Registry()
    report = Report()
    registry.register(_TOOL, report)
    store = InMemoryApprovalStore()
    mcp = APCoreMCP(registry, approval_store=store, authenticator=Authenticator())
    with caplog.at_level("DEBUG"):
        async with mcp.async_serve() as app, httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost",
        ) as client, asyncio.timeout(5):
            owner = _HttpSession(client, "Bearer fixture-owner")
            reader = _HttpSession(client, "Bearer fixture-reader")
            await owner.initialize()
            await reader.initialize()
            request = {"name": _TOOL, "arguments": {"count": 1}}
            pending = await owner.request("tools/call", request)
            approval = pending["_meta"]["apcore"]["approval"]
            public_id, credential = approval["approvalId"], approval["resumeToken"]
            poll = {"name": "__apcore_approval_check", "arguments": {"approval_id": public_id}}

            assert json.loads((await reader.request("tools/call", poll))["content"][0]["text"])["status"] == "rejected"
            assert json.loads((await owner.request("tools/call", poll))["content"][0]["text"])["status"] == "pending"
            assert await store.resolve(public_id, approved=True)
            retry = {**request, "_meta": {"approvalId": credential}}
            assert (await reader.request("tools/call", retry))["isError"]
            assert not (await owner.request("tools/call", retry))["isError"]
    if credential in caplog.text:
        pytest.fail("Approval credential entered debug logs")
    assert report.inputs == [{"count": 1}]
    assert "chunk:" in caplog.text  # Unrelated HTTP debug logging remains available.


@pytest.mark.skipif(_CORE_SCOPED_APPROVAL, reason="exercises the minimum Core compatibility path")
async def test_legacy_core_reports_scoped_approval_unavailable() -> None:
    registry = Registry()
    report = Report()
    registry.register(_TOOL, report)
    async with connected_client(registry, approval_store=InMemoryApprovalStore()) as session:
        tools = await session.list_tools()
        assert "__apcore_approval_check" not in {tool.name for tool in tools.tools}
        result = await session.call_tool(_TOOL, {"count": 1})
    assert result.isError
    assert "Scoped approval is unavailable" in result.content[0].text
    assert "apcore" not in (result.meta or {})
    assert report.inputs == []


@_requires_scoped_core
async def test_background_tool_has_no_channel_to_issue_approval_credentials() -> None:
    registry = Registry()
    report = Report()
    registry.register(_TOOL, report, metadata={"async": True})
    notifications = []

    async def notify(*args):
        notifications.append(args)

    async with connected_client(
        registry, approval_store=InMemoryApprovalStore(), approval_notify=notify, async_tasks=True,
    ) as session:
        submitted = await session.call_tool(_TOOL, {"count": 1})
        task_id = json.loads(submitted.content[0].text)["task_id"]
        async with asyncio.timeout(2):
            while True:
                result = await session.call_tool("__apcore_task_status", {"task_id": task_id})
                status = json.loads(result.content[0].text)
                if status["status"] == "failed":
                    break
                await asyncio.sleep(0)
    assert notifications == []
    assert report.inputs == []
    assert "resumeToken" not in result.model_dump_json()


@_requires_scoped_core
def test_scoped_approval_is_explicitly_unavailable_on_legacy_sse() -> None:
    mcp = APCoreMCP(Registry(), approval_store=InMemoryApprovalStore())
    with pytest.raises(ValueError, match="legacy SSE transport"):
        mcp.serve(transport="sse")


async def test_sdk_diagnostic_filter_protects_only_the_scoped_server(caplog) -> None:
    server = Server("fixture")
    _protect_sdk_approval_logs(server)
    root = logging.getLogger()
    with caplog.at_level("DEBUG"):
        async with server.lifespan(server):
            for level, diagnostic in (
                (logging.WARNING, "Failed to validate request: synthetic-value"),
                (logging.DEBUG, "Message that failed validation: synthetic-value"),
                (logging.DEBUG, "Read stream closed by client"),
            ):
                root.handle(logging.LogRecord("root", level, mcp_session.__file__, 1, diagnostic, (), None))
        root.handle(logging.LogRecord(
            "root", logging.WARNING, mcp_session.__file__, 1, "Failed to validate request: host diagnostic", (), None,
        ))

    assert "synthetic-value" not in caplog.text
    assert "MCP request validation failed" in caplog.text
    assert "Read stream closed by client" in caplog.text
    assert "host diagnostic" in caplog.text


async def test_http_diagnostic_filter_keeps_validation_envelope_and_replaces_payload() -> None:
    async def example_app(scope, receive, send):
        response = JSONResponse({
            "jsonrpc": "2.0", "id": "server-error", "error": {"code": -32602, "message": "Validation error: value"},
        }, status_code=400, headers={"Mcp-Session-Id": "fixture-session"})
        await response(scope, receive, send)

    transport = httpx.ASGITransport(app=_ApprovalLogMiddleware(example_app))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        response = await client.post("/mcp")

    assert response.status_code == 400
    assert response.headers["Mcp-Session-Id"] == "fixture-session"
    assert int(response.headers["content-length"]) == len(response.content)
    assert response.json() == {
        "jsonrpc": "2.0", "id": "server-error", "error": {"code": -32602, "message": "Invalid request parameters"},
    }


async def test_reserved_approval_input_is_checked_before_tool_schema_validation() -> None:
    registry = Registry()
    report = Report()
    registry.register(_TOOL, report, metadata={"async": True})
    async with connected_client(registry, approval_store=InMemoryApprovalStore(), async_tasks=True) as session:
        invalid = await session.call_tool(_TOOL, {"count": "invalid"})
        direct = await session.call_tool(_TOOL, {"count": 1, "_approval_token": "synthetic-value"})
        submitted = await session.call_tool("__apcore_task_submit", {
            "module_id": _TOOL, "arguments": {"count": 1, "_approval_token": "synthetic-value"},
        })

    assert invalid.isError and "Input validation error" in invalid.content[0].text
    for result in (direct, submitted):
        assert result.isError
        assert result.content[0].text == "Send the approval credential in MCP request metadata."
    assert report.inputs == []
