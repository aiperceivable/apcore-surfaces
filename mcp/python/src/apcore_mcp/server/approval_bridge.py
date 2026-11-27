"""ApprovalBridge: exposes __apcore_approval_check as an MCP meta-tool.

Symmetric with AsyncTaskBridge. Registered in MCPServerFactory.register_handlers()
alongside async_bridge.
"""

from __future__ import annotations

import json
import logging
from contextlib import AbstractContextManager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from apcore import Identity
from mcp import types as mcp_types
from starlette.types import ASGIApp, Receive, Scope, Send

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


class _ApprovalLogMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self._app = app
        logging.getLogger("sse_starlette.sse").addFilter(_approval_response_log_filter)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        response = _ApprovalResponseLog()
        token = _response_log_context.set(response)
        try:
            await self._app({**scope, _RESPONSE_LOG_SCOPE_KEY: response}, receive, send)
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
