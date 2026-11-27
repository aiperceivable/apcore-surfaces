"""Tests for ApprovalBridge meta-tool (Phase B approval polling)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from apcore import Registry

from apcore_mcp.adapters.approval import _CORE_SCOPED_APPROVAL, StorageBackedApprovalHandler
from apcore_mcp.approval_store import InMemoryApprovalStore
from apcore_mcp.server.approval_bridge import APPROVAL_META_TOOL_NAMES, ApprovalBridge

_requires_scoped_core = pytest.mark.skipif(not _CORE_SCOPED_APPROVAL, reason="requires scoped Core approval")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_bridge() -> tuple[ApprovalBridge, StorageBackedApprovalHandler, InMemoryApprovalStore]:
    store = InMemoryApprovalStore()
    handler = StorageBackedApprovalHandler(store)
    bridge = ApprovalBridge(handler)
    return bridge, handler, store


# ---------------------------------------------------------------------------
# is_meta_tool
# ---------------------------------------------------------------------------


def test_is_meta_tool_returns_true_for_check() -> None:
    assert ApprovalBridge.is_meta_tool("__apcore_approval_check") is True


def test_is_meta_tool_returns_false_for_others() -> None:
    assert ApprovalBridge.is_meta_tool("__apcore_task_status") is False
    assert ApprovalBridge.is_meta_tool("my_module") is False
    assert ApprovalBridge.is_meta_tool("") is False


def test_approval_meta_tool_names_constant() -> None:
    assert "__apcore_approval_check" in APPROVAL_META_TOOL_NAMES


# ---------------------------------------------------------------------------
# build_meta_tools schema
# ---------------------------------------------------------------------------


def test_build_meta_tools_returns_one_tool() -> None:
    bridge, _, _ = _make_bridge()
    tools = bridge.build_meta_tools()
    assert len(tools) == 1
    tool = tools[0]
    assert tool.name == "__apcore_approval_check"


def test_build_meta_tools_schema_correct() -> None:
    bridge, _, _ = _make_bridge()
    tool = bridge.build_meta_tools()[0]
    schema = tool.inputSchema
    assert schema["type"] == "object"
    assert "approval_id" in schema["properties"]
    assert schema["required"] == ["approval_id"]
    assert schema.get("additionalProperties") is False


def test_build_meta_tools_has_description() -> None:
    bridge, _, _ = _make_bridge()
    tool = bridge.build_meta_tools()[0]
    assert tool.description
    assert "approval_id" in tool.description.lower() or "approval" in tool.description.lower()


# ---------------------------------------------------------------------------
# handle_meta_tool: check pending
# ---------------------------------------------------------------------------


@_requires_scoped_core
@pytest.mark.asyncio
async def test_check_returns_pending() -> None:
    bridge, handler, _ = _make_bridge()
    pending = await handler.request_approval(_make_approval_request())
    content, is_error, _ = await bridge.handle_meta_tool(
        "__apcore_approval_check", {"approval_id": pending.audit_id},
    )
    assert is_error is False
    body = json.loads(content[0]["text"])
    assert body["status"] == "pending"
    assert body["approval_id"] == pending.audit_id
    assert pending.approval_id not in content[0]["text"]


@_requires_scoped_core
@pytest.mark.asyncio
async def test_check_returns_approved() -> None:
    bridge, handler, store = _make_bridge()
    pending = await handler.request_approval(_make_approval_request())
    await store.resolve(pending.audit_id, approved=True)
    content, is_error, _ = await bridge.handle_meta_tool(
        "__apcore_approval_check", {"approval_id": pending.audit_id},
    )
    assert is_error is False
    body = json.loads(content[0]["text"])
    assert body["status"] == "approved"
    assert body["approval_id"] == pending.audit_id
    assert "reason" not in body


@_requires_scoped_core
@pytest.mark.asyncio
async def test_check_returns_rejected_without_provider_text() -> None:
    bridge, handler, store = _make_bridge()
    pending = await handler.request_approval(_make_approval_request())
    await store.resolve(pending.audit_id, approved=False, reason="not today")
    content, is_error, _ = await bridge.handle_meta_tool(
        "__apcore_approval_check", {"approval_id": pending.audit_id},
    )
    assert is_error is False
    body = json.loads(content[0]["text"])
    assert body["status"] == "rejected"
    assert "reason" not in body


@pytest.mark.asyncio
async def test_check_unknown_id_returns_rejected() -> None:
    bridge, _, _ = _make_bridge()
    content, is_error, _ = await bridge.handle_meta_tool(
        "__apcore_approval_check", {"approval_id": "c5b92219-e067-485a-9752-d09cd362588d"},
    )
    assert is_error is False
    body = json.loads(content[0]["text"])
    assert body["status"] == "rejected"


# ---------------------------------------------------------------------------
# handle_meta_tool: validation errors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_check_missing_approval_id_is_error() -> None:
    bridge, _, _ = _make_bridge()
    content, is_error, _ = await bridge.handle_meta_tool("__apcore_approval_check", {})
    assert is_error is True


@pytest.mark.asyncio
async def test_check_empty_approval_id_is_error() -> None:
    bridge, _, _ = _make_bridge()
    content, is_error, _ = await bridge.handle_meta_tool("__apcore_approval_check", {"approval_id": ""})
    assert is_error is True


@pytest.mark.asyncio
async def test_check_unknown_meta_tool_name_is_error() -> None:
    bridge, _, _ = _make_bridge()
    content, is_error, _ = await bridge.handle_meta_tool("__apcore_approval_check_nonexistent", {"approval_id": "x"})
    assert is_error is True


# ---------------------------------------------------------------------------
# StorageBackedApprovalHandler: request_approval
# ---------------------------------------------------------------------------


@_requires_scoped_core
@pytest.mark.asyncio
async def test_request_approval_returns_pending_with_id() -> None:
    store = InMemoryApprovalStore()
    handler = StorageBackedApprovalHandler(store)

    from apcore import Context
    from apcore.approval import ApprovalRequest
    from apcore.module import ModuleAnnotations

    ctx = Context.create(data={})
    request = ApprovalRequest(
        module_id="test_mod",
        arguments={"k": "v"},
        context=ctx,
        annotations=ModuleAnnotations(),
        description="needs approval",
    )
    result = await handler.request_approval(request)
    assert result.status == "pending"
    assert result.approval_id is not None and result.audit_id is not None
    assert result.approval_id != result.audit_id
    record = await store.get_result(result.audit_id)
    assert record is not None
    assert record["status"] == "pending"


@_requires_scoped_core
@pytest.mark.asyncio
async def test_request_approval_calls_notify_callback() -> None:
    store = InMemoryApprovalStore()
    notify = AsyncMock()
    handler = StorageBackedApprovalHandler(store, notify_callback=notify)

    from apcore import Context
    from apcore.approval import ApprovalRequest
    from apcore.module import ModuleAnnotations

    ctx = Context.create(data={})
    request = ApprovalRequest(
        module_id="notify_mod",
        arguments={},
        context=ctx,
        annotations=ModuleAnnotations(),
        description="needs approval",
    )
    result = await handler.request_approval(request)
    notify.assert_awaited_once()
    args = notify.call_args
    assert args[0][0] == result.audit_id
    assert args[0][0] != result.approval_id


@_requires_scoped_core
@pytest.mark.asyncio
async def test_request_approval_swallows_notify_exception() -> None:
    """notify_callback errors must not propagate."""
    store = InMemoryApprovalStore()

    async def bad_notify(*args: Any) -> None:
        raise RuntimeError("notify failed")

    handler = StorageBackedApprovalHandler(store, notify_callback=bad_notify)

    from apcore import Context
    from apcore.approval import ApprovalRequest
    from apcore.module import ModuleAnnotations

    ctx = Context.create(data={})
    request = ApprovalRequest(
        module_id="mod",
        arguments={},
        context=ctx,
        annotations=ModuleAnnotations(),
        description="x",
    )
    # Should not raise
    result = await handler.request_approval(request)
    assert result.status == "pending"


# ---------------------------------------------------------------------------
# [A-D-AP-3] StorageBackedApprovalHandler: store failures are contained
# ---------------------------------------------------------------------------


class _FailingStore(InMemoryApprovalStore):
    """Scoped approval store stand-in whose operations raise."""

    def __init__(self, exc: BaseException) -> None:
        super().__init__()
        self._exc = exc

    async def save_scoped_pending(self, approval_id, arguments, scope, verifier) -> None:
        raise self._exc

    async def get_scoped_result(self, approval_id, principal) -> dict[str, Any] | None:
        raise self._exc

    async def consume_scoped(self, approval_id, scope, verifier) -> dict[str, Any] | None:
        raise self._exc


def _make_approval_request() -> Any:
    from apcore import Context
    from apcore.approval import ApprovalRequest
    from apcore.module import ModuleAnnotations

    return ApprovalRequest(
        module_id="mod",
        arguments={},
        context=Context.create(data={}),
        annotations=ModuleAnnotations(),
        description="x",
    )


@_requires_scoped_core
@pytest.mark.asyncio
async def test_final_scope_binds_module_version_and_cannot_resume_as_legacy() -> None:
    store = InMemoryApprovalStore()
    handler = StorageBackedApprovalHandler(store)
    request = _make_approval_request()
    fields = vars(request) | {"module_version": "1.2.3", "canonical_args_digest": "a" * 64}
    final_request = SimpleNamespace(**fields)
    pending = await handler.request_approval(final_request)
    assert pending.status == "pending"
    assert await store.resolve(pending.audit_id, approved=True)

    for changed in (
        request,
        SimpleNamespace(**(fields | {"module_version": "1.2.4"})),
        SimpleNamespace(**(fields | {"canonical_args_digest": "b" * 64})),
    ):
        result = await handler.check_approval_for_call(pending.approval_id, changed)
        assert result.status == "rejected"

    assert (await handler.check_approval_for_call(pending.approval_id, final_request)).status == "approved"
    assert (await handler.check_approval_for_call(pending.approval_id, final_request)).status == "rejected"
    assert handler.supports_final_scope is True


@_requires_scoped_core
@pytest.mark.asyncio
async def test_request_approval_returns_rejected_when_save_pending_raises() -> None:
    """A store that cannot persist must fail the gate closed, not raise."""
    handler = StorageBackedApprovalHandler(_FailingStore(RuntimeError("redis down")))

    result = await handler.request_approval(_make_approval_request())

    assert result.status == "rejected"
    assert result.reason == "Storage error"


@_requires_scoped_core
@pytest.mark.asyncio
async def test_check_approval_returns_rejected_when_get_result_raises() -> None:
    """A store that cannot be read must fail the gate closed, not raise."""
    handler = StorageBackedApprovalHandler(_FailingStore(RuntimeError("redis down")))

    result = await handler.poll_approval("c5b92219-e067-485a-9752-d09cd362588d", None)

    assert result.status == "rejected"
    assert result.reason == "Storage error"


@_requires_scoped_core
@pytest.mark.asyncio
async def test_capacity_failures_report_the_capacity_reason() -> None:
    """A capacity rejection is reported distinctly from a generic storage error."""
    handler = StorageBackedApprovalHandler(_FailingStore(MemoryError()))
    named = StorageBackedApprovalHandler(_FailingStore(RuntimeError("store capacity exceeded")))

    assert (await handler.request_approval(_make_approval_request())).reason == "Store capacity exceeded"
    assert (await named.poll_approval("c5b92219-e067-485a-9752-d09cd362588d", None)).reason == "Store capacity exceeded"


# ---------------------------------------------------------------------------
# APCoreMCP integration: approval_store param auto-wires handler
# ---------------------------------------------------------------------------


def test_approval_store_param_creates_handler() -> None:
    """Passing approval_store to APCoreMCP auto-creates StorageBackedApprovalHandler."""
    store = InMemoryApprovalStore()

    from apcore_mcp.apcore_mcp import APCoreMCP

    mcp = APCoreMCP(Registry(), approval_store=store, async_tasks=False)
    assert mcp._approval_store is store
    assert isinstance(mcp._approval_handler, StorageBackedApprovalHandler)


def test_explicit_approval_handler_not_overridden_by_store() -> None:
    """Explicit approval_handler takes precedence over approval_store auto-wiring."""
    store = InMemoryApprovalStore()
    explicit_handler = StorageBackedApprovalHandler(store)

    from apcore_mcp.apcore_mcp import APCoreMCP

    mcp = APCoreMCP(
        Registry(),
        approval_handler=explicit_handler,
        approval_store=store,
        async_tasks=False,
    )
    assert mcp._approval_handler is explicit_handler


@pytest.mark.asyncio
async def test_legacy_status_method_cannot_authorize() -> None:
    _, handler, store = _make_bridge()
    record_id = "c5b92219-e067-485a-9752-d09cd362588d"
    await store.save_pending(record_id, "mod", {})
    await store.resolve(record_id, approved=True)
    assert (await handler.check_approval(record_id)).status == "rejected"
