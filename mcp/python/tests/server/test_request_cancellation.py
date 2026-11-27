"""MCP wire cancellation reaches the target invocation's apcore token."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import anyio
import httpx
from apcore import Context, Executor, Identity, Registry
from apcore.async_task import AsyncTaskManager, TaskStatus
from mcp import types
from mcp.shared.message import SessionMessage
from pydantic import BaseModel

from apcore_mcp.auth.middleware import AuthMiddleware
from apcore_mcp.server.async_task_bridge import AsyncTaskBridge
from apcore_mcp.server.factory import MCPServerFactory
from apcore_mcp.server.router import ExecutionRouter
from apcore_mcp.server.transport import TransportManager, transport_session_var


class _Inputs(BaseModel):
    name: str


class _Outputs(BaseModel):
    name: str


class _GatedModule:
    input_schema = _Inputs
    output_schema = _Outputs
    description = "Await the test gate and record the invocation token at exit"

    def __init__(self) -> None:
        self.entered = asyncio.Queue[str]()
        self.exited = asyncio.Queue[tuple[str, bool]]()
        self.release = asyncio.Event()
        self.sessions: dict[str, str | None] = {}

    async def execute(self, inputs: dict[str, Any], context: Context) -> dict[str, str]:
        name = inputs["name"]
        assert context.cancel_token is not None
        self.sessions[name] = transport_session_var.get()
        await self.entered.put(name)
        try:
            while not self.release.is_set():
                context.cancel_token.check()
                await asyncio.sleep(0.01)
            return {"name": name}
        finally:
            self.exited.put_nowait((name, context.cancel_token.is_cancelled))


async def test_wire_cancel_marks_only_the_target_module_token() -> None:
    module = _GatedModule()
    registry = Registry()
    registry.register("test.gated", module)
    factory = MCPServerFactory()
    server = factory.create_server()
    factory.register_handlers(server, factory.build_tools(registry), ExecutionRouter(Executor(registry=registry)))
    init = factory.build_init_options(server, "test", "1")
    send_client, read_server = anyio.create_memory_object_stream(10)
    send_server, read_client = anyio.create_memory_object_stream(10)

    async def send(message: dict[str, Any]) -> None:
        await send_client.send(SessionMessage(types.JSONRPCMessage.model_validate({"jsonrpc": "2.0", **message})))

    with anyio.fail_after(5):
        async with anyio.create_task_group() as group:
            group.start_soon(TransportManager()._run_scoped, server, read_server, send_server, init, "test")
            await send(
                {
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {},
                        "clientInfo": {"name": "test", "version": "1"},
                    },
                }
            )
            assert (await read_client.receive()).message.root.id == 1
            await send({"method": "notifications/initialized"})
            for request_id, name in [(2, "target"), (3, "peer")]:
                await send(
                    {
                        "id": request_id,
                        "method": "tools/call",
                        "params": {"name": "test.gated", "arguments": {"name": name}},
                    }
                )
            assert {await module.entered.get(), await module.entered.get()} == {"target", "peer"}

            await send({"method": "notifications/cancelled", "params": {"requestId": 2}})
            try:
                assert await module.exited.get() == ("target", True)
            finally:
                module.release.set()
            assert await module.exited.get() == ("peer", False)

            while True:
                response = (await read_client.receive()).message.root
                if response.id == 3:
                    assert isinstance(response, types.JSONRPCResponse)
                    assert not response.result["isError"]
                    assert json.loads(response.result["content"][0]["text"]) == {"name": "peer"}
                    break
            group.cancel_scope.cancel()


async def test_http_sessions_isolate_same_request_id_and_cancel_tasks_on_close() -> None:
    class RecordingBridge:
        def __init__(self) -> None:
            self.closed = asyncio.Queue[str]()

        async def cancel_session_tasks(self, session_key: str) -> int:
            await self.closed.put(session_key)
            return 0

    module = _GatedModule()
    registry = Registry()
    registry.register("test.gated", module)
    factory = MCPServerFactory()
    server = factory.create_server()
    factory.register_handlers(server, factory.build_tools(registry), ExecutionRouter(Executor(registry=registry)))
    manager = TransportManager()
    bridge = RecordingBridge()
    manager.set_async_task_bridge(bridge)

    headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
    init_message = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1"},
        },
    }
    with anyio.fail_after(5):
        async with (
            manager.build_streamable_http_app(server, factory.build_init_options(server, "test", "1")) as app,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
        ):
            first = await client.post("/mcp/", headers=headers, json=init_message)
            second = await client.post("/mcp/", headers=headers, json=init_message)
            first.raise_for_status()
            second.raise_for_status()
            first_headers = {**headers, "Mcp-Session-Id": first.headers["mcp-session-id"]}
            second_headers = {**headers, "Mcp-Session-Id": second.headers["mcp-session-id"]}
            assert first_headers["Mcp-Session-Id"] != second_headers["Mcp-Session-Id"]
            for session_headers in (first_headers, second_headers):
                response = await client.post(
                    "/mcp/", headers=session_headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"}
                )
                assert response.status_code == 202

            async def call(session_headers: dict[str, str], name: str) -> httpx.Response:
                return await client.post(
                    "/mcp/",
                    headers=session_headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {"name": "test.gated", "arguments": {"name": name}},
                    },
                )

            first_call = asyncio.create_task(call(first_headers, "target"))
            second_call = asyncio.create_task(call(second_headers, "peer"))
            try:
                assert {await module.entered.get(), await module.entered.get()} == {"target", "peer"}
                response = await client.post(
                    "/mcp/",
                    headers=first_headers,
                    json={
                        "jsonrpc": "2.0",
                        "method": "notifications/cancelled",
                        "params": {"requestId": 2},
                    },
                )
                assert response.status_code == 202
                assert await module.exited.get() == ("target", True)
            finally:
                module.release.set()
                await asyncio.gather(first_call, second_call)

            assert first_call.result().status_code == 200
            assert "peer" in second_call.result().text
            assert await module.exited.get() == ("peer", False)
            assert module.sessions["target"] != module.sessions["peer"]
            assert None not in module.sessions.values()
            removed = await client.delete("/mcp/", headers=first_headers)
            assert removed.status_code == 200
            assert await bridge.closed.get() == module.sessions["target"]
            assert bridge.closed.empty()


async def test_http_manager_shutdown_finishes_session_task_cancellation() -> None:
    class SuspendingTaskManager(AsyncTaskManager):
        async def cancel(self, task_id: str) -> bool:
            await asyncio.sleep(0)
            return await super().cancel(task_id)

    module = _GatedModule()
    registry = Registry()
    registry.register("test.gated", module, metadata={"async": True})
    executor = Executor(registry=registry)
    task_manager = SuspendingTaskManager(executor)
    bridge = AsyncTaskBridge(task_manager)
    factory = MCPServerFactory()
    server = factory.create_server()
    factory.register_handlers(
        server,
        factory.build_tools(registry),
        ExecutionRouter(executor),
        async_bridge=bridge,
        descriptor_lookup=registry.get_definition,
    )
    transport = TransportManager()
    transport.set_async_task_bridge(bridge)
    headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}

    try:
        with anyio.fail_after(5):
            async with (
                transport.build_streamable_http_app(server, factory.build_init_options(server, "test", "1")) as app,
                httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
            ):
                initialized = await client.post(
                    "/mcp/", headers=headers, json={
                        "jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": {"name": "test", "version": "1"},
                        },
                    },
                )
                initialized.raise_for_status()
                headers["Mcp-Session-Id"] = initialized.headers["mcp-session-id"]
                notification = await client.post(
                    "/mcp/", headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"}
                )
                assert notification.status_code == 202
                response = await client.post("/mcp/", headers=headers, json={
                    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {"name": "test.gated", "arguments": {"name": "shutdown"}},
                })
                response.raise_for_status()
                result = next(
                    json.loads(line[5:])["result"] for line in response.iter_lines() if line.startswith("data:")
                )
                task_id = json.loads(result["content"][0]["text"])["task_id"]
                assert await module.entered.get() == "shutdown"

        # Exit the HTTP manager with an open session, without sending DELETE.
        status = task_manager.get_status(task_id)
        assert status is not None and status.status == TaskStatus.CANCELLED
    finally:
        await task_manager.shutdown()


async def test_authenticated_http_session_rejects_other_principals_before_dispatch() -> None:
    class HeaderAuthenticator:
        def authenticate(self, headers: dict[str, str]) -> Identity | None:
            name = headers.get("authorization")
            return Identity(id=name) if name in {"alice", "bob"} else None

    module = _GatedModule()
    registry = Registry()
    registry.register("test.gated", module)
    factory = MCPServerFactory()
    server = factory.create_server()
    factory.register_handlers(server, factory.build_tools(registry), ExecutionRouter(Executor(registry=registry)))
    manager = TransportManager()
    headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
    init_message = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1"},
        },
    }
    middleware = [(AuthMiddleware, {"authenticator": HeaderAuthenticator()})]
    with anyio.fail_after(5):
        async with (
            manager.build_streamable_http_app(
                server, factory.build_init_options(server, "test", "1"), middleware=middleware
            ) as app,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
        ):
            alice = {**headers, "Authorization": "alice"}
            initialized = await client.post("/mcp/", headers=alice, json=init_message)
            initialized.raise_for_status()
            alice["Mcp-Session-Id"] = initialized.headers["mcp-session-id"]
            bob = {**alice, "Authorization": "bob"}
            notification = await client.post(
                "/mcp/", headers=alice, json={"jsonrpc": "2.0", "method": "notifications/initialized"}
            )
            assert notification.status_code == 202

            target = asyncio.create_task(
                client.post(
                    "/mcp/",
                    headers=alice,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {"name": "test.gated", "arguments": {"name": "target"}},
                    },
                )
            )
            try:
                assert await module.entered.get() == "target"
                cancel = {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 2}}
                assert (await client.post("/mcp/", headers=bob, json=cancel)).status_code == 404
                assert (await client.delete("/mcp/", headers=bob)).status_code == 404
                assert module.exited.empty()
                assert (await client.post("/mcp/", headers=alice, json=cancel)).status_code == 202
                assert await module.exited.get() == ("target", True)
            finally:
                module.release.set()
                await target

            assert (await client.delete("/mcp/", headers=alice)).status_code == 200
            assert (await client.post("/mcp/", headers=alice, json=cancel)).status_code == 404
