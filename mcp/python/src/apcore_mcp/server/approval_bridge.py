"""ApprovalBridge: exposes __apcore_approval_check as an MCP meta-tool.

Symmetric with AsyncTaskBridge. Registered in MCPServerFactory.register_handlers()
alongside async_bridge.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import AbstractContextManager, asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from apcore import Identity
from mcp import types as mcp_types
from mcp.server.lowlevel import Server
from mcp.server.lowlevel import server as mcp_lowlevel
from mcp.shared import session as mcp_session
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from apcore_mcp.adapters.approval import (
    _approval_principal,
    _ApprovalDelivery,
    _capture_approval_delivery,
    _is_public_approval_id,
    _ScopedMCPApprovalHandler,
)
from apcore_mcp.adapters.errors import ErrorMapper

logger = logging.getLogger(__name__)

__all__ = ["ApprovalBridge", "APPROVAL_META_TOOL_NAMES"]

APPROVAL_META_TOOL_NAMES = ("__apcore_approval_check",)


@dataclass
class _ApprovalResponseLog:
    carries_credential: bool = False


_RESPONSE_LOG_SCOPE_KEY = "apcore_mcp.approval_response_log"
_response_log_context: ContextVar[_ApprovalResponseLog | None] = ContextVar("approval_response_log", default=None)


class _ApprovalResponseLogFilter(logging.Filter):
    """Protect the raw SSE chunk diagnostic for a credential-bearing response."""

    def filter(self, record: logging.LogRecord) -> bool:
        response = _response_log_context.get()
        return not (
            response is not None
            and response.carries_credential
            and record.levelno == logging.DEBUG
            and isinstance(record.msg, str)
            and record.msg.startswith("chunk:")
        )


_approval_response_log_filter = _ApprovalResponseLogFilter()
_sdk_approval_logs = ContextVar("sdk_approval_logs", default=False)


class _ApprovalRequestLogFilter(logging.Filter):
    """Narrow MCP SDK diagnostics that can contain the original request."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not _sdk_approval_logs.get() or not isinstance(record.msg, str):
            return True
        if record.pathname == mcp_session.__file__:
            if record.msg.startswith("Message that failed validation:"):
                return False
            if not record.msg.startswith(("Failed to validate request:", "Failed to validate notification:")):
                return True
        elif record.pathname == mcp_lowlevel.__file__:
            if record.msg == "Received message: %s" and isinstance(record.args, tuple):
                return not (len(record.args) == 1 and isinstance(record.args[0], Exception))
            if not record.msg.startswith("Received exception from stream:"):
                return True
        else:
            return True

        record.msg = "MCP request validation failed"
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        return True


_approval_request_log_filter = _ApprovalRequestLogFilter()


def _protect_sdk_approval_logs(server: Server) -> None:
    # MCP emits its session validation warnings through the root logger.
    for name in (None, mcp_session.__name__, mcp_lowlevel.__name__):
        logging.getLogger(name).addFilter(_approval_request_log_filter)
    lifespan = server.lifespan

    @asynccontextmanager
    async def protected_lifespan(active_server: Server) -> AsyncIterator[Any]:
        token = _sdk_approval_logs.set(True)
        try:
            async with lifespan(active_server) as value:
                yield value
        finally:
            _sdk_approval_logs.reset(token)

    server.lifespan = protected_lifespan


def _safe_http_validation_error(body: bytes) -> bytes:
    """Preserve the SDK's outer JSON-RPC error without its raw validation text."""
    try:
        response = json.loads(body)
    except ValueError:
        return body
    if not isinstance(response, dict) or response.get("id") != "server-error":
        return body
    error = response.get("error")
    if not isinstance(error, dict) or error.get("code") != mcp_types.INVALID_PARAMS:
        return body
    message = error.get("message")
    if not isinstance(message, str) or not message.startswith("Validation error:"):
        return body
    error["message"] = "Invalid request parameters"
    return json.dumps(response, separators=(",", ":")).encode()


class _ApprovalLogMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self._app = app
        logging.getLogger("sse_starlette.sse").addFilter(_approval_response_log_filter)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        response = _ApprovalResponseLog()
        pending_start: Message | None = None

        async def send_safe(message: Message) -> None:
            nonlocal pending_start
            if message["type"] == "http.response.start" and message["status"] == 400:
                content_type = Headers(raw=message["headers"]).get("content-type", "")
                if content_type.partition(";")[0] == "application/json":
                    pending_start = message
                    return
            if pending_start is not None:
                start = pending_start
                pending_start = None
                if message["type"] == "http.response.body" and not message.get("more_body"):
                    body = message.get("body", b"")
                    safe_body = _safe_http_validation_error(body)
                    if safe_body is not body:
                        MutableHeaders(scope=start)["content-length"] = str(len(safe_body))
                        message = {**message, "body": safe_body}
                await send(start)
            await send(message)

        token = _response_log_context.set(response)
        try:
            await self._app({**scope, _RESPONSE_LOG_SCOPE_KEY: response}, receive, send_safe)
        finally:
            _response_log_context.reset(token)


def _approval_response_log(request: Any) -> _ApprovalResponseLog | None:
    scope = getattr(request, "scope", None)
    marker = scope.get(_RESPONSE_LOG_SCOPE_KEY) if isinstance(scope, dict) else None
    return marker if isinstance(marker, _ApprovalResponseLog) else None


class ApprovalBridge:
    """Expose a caller-scoped status tool and capture pending wire responses."""

    def __init__(self, handler: _ScopedMCPApprovalHandler) -> None:
        self._handler = handler
        self._error_mapper = ErrorMapper()

    def delivery(self, name: str) -> AbstractContextManager[_ApprovalDelivery]:
        return _capture_approval_delivery(self._handler, name)

    @staticmethod
    def is_meta_tool(name: str) -> bool:
        return name in APPROVAL_META_TOOL_NAMES

    def build_meta_tools(self) -> list[mcp_types.Tool]:
        return [
            mcp_types.Tool(
                name="__apcore_approval_check",
                description=(
                    "Poll the status of a pending approval request. "
                    "Returns {approval_id, status}. "
                    "status is 'pending', 'approved', or 'rejected'. "
                    "When 'approved', retry the original tool call with "
                    "_meta.approvalId set to the separate resumeToken from the pending result."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "approval_id": {
                            "type": "string",
                            "description": "The public approvalId from the pending result metadata",
                        }
                    },
                    "required": ["approval_id"],
                    "additionalProperties": False,
                },
            )
        ]

    async def handle_meta_tool(
        self, name: str, arguments: dict[str, Any], *, identity: Identity | None = None,
    ) -> tuple[list[dict[str, Any]], bool, str | None]:
        """Dispatch a meta-tool call. Returns (content, is_error, trace_id)."""
        if name == "__apcore_approval_check":
            return await self._handle_check(arguments or {}, identity)
        return self._error_response(ValueError(f"Unknown approval meta-tool: {name}"))

    async def _handle_check(
        self, args: dict[str, Any], identity: Identity | None
    ) -> tuple[list[dict[str, Any]], bool, str | None]:
        approval_id = args.get("approval_id")
        if not _is_public_approval_id(approval_id):
            return self._error_response(ValueError("approval_id must be a public approval record ID"))
        try:
            result = await self._handler.poll_approval(approval_id, _approval_principal(identity))
        except Exception:
            logger.warning("Approval status lookup failed")
            return self._error_response(ValueError("Approval status lookup failed"))
        status = result.status if result.status in ("pending", "approved", "rejected") else "rejected"
        payload = {"approval_id": approval_id, "status": status}
        return ([{"type": "text", "text": json.dumps(payload)}], False, None)

    def _error_response(self, exc: Exception) -> tuple[list[dict[str, Any]], bool, str | None]:
        info = self._error_mapper.to_mcp_error(exc)
        return ([{"type": "text", "text": info["message"]}], True, None)
