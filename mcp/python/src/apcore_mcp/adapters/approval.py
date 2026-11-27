"""ElicitationApprovalHandler: bridges MCP elicitation to apcore's approval system."""

from __future__ import annotations

import json
import logging
import re
import secrets
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Protocol, TypeGuard

from apcore import Identity
from apcore import approval as core_approval
from apcore.approval import ApprovalHandler, ApprovalRequest, ApprovalResult
from apcore.errors import ApprovalPendingError

from apcore_mcp.approval_store import ApprovalPrincipal, ApprovalScope, ScopedApprovalStore
from apcore_mcp.helpers import MCP_ELICIT_KEY

logger = logging.getLogger(__name__)

# JSON Schema (MCP elicitation requestedSchema) for a yes/no approval prompt.
# Primitive-only per the elicitation spec; a boolean gives form-rendering
# clients (Cursor, Codex, ...) a concrete control to display. An empty schema is
# tolerated by minimal SDK clients but ignored/rejected by clients that render a
# form, so the request returns no response and the gate fails closed.
_APPROVAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "title": "Approval required",
    "properties": {
        "approve": {
            "type": "boolean",
            "title": "Approve this action?",
            "description": "Select yes to allow the operation to proceed.",
        }
    },
    "required": ["approve"],
}


class ElicitationApprovalHandler(ApprovalHandler):
    """Bridges MCP elicitation to apcore's approval system.

    Uses the MCP elicit callback (injected into Context.data) to present
    approval requests to the human user via the MCP client.
    """

    async def request_approval(self, request: ApprovalRequest) -> ApprovalResult:
        """Request approval via MCP elicitation.

        Extracts the elicit callback from ``request.context.data``, builds
        an approval message, and maps the elicit response to an
        ``ApprovalResult``.

        Args:
            request: The approval request containing module_id, description,
                arguments, and context.

        Returns:
            ApprovalResult with status "approved" or "rejected".
        """
        # Extract elicit callback from context
        context = request.context
        data = getattr(context, "data", None) if context is not None else None
        if data is None:
            return ApprovalResult(status="rejected", reason="No context available for elicitation")

        elicit_callback = data.get(MCP_ELICIT_KEY)
        if elicit_callback is None:
            return ApprovalResult(status="rejected", reason="No elicitation callback available")

        # Build approval message
        message = (
            f"Approval required for tool: {request.module_id}\n\n"
            f"{request.description}\n\n"
            f"Arguments: {json.dumps(request.arguments)}"
        )

        try:
            # Send a proper (non-empty) schema so form-rendering clients can
            # display an approve/deny control; an empty {} is silently dropped.
            result = await elicit_callback(message, _APPROVAL_SCHEMA)
        except Exception:
            logger.warning("Elicitation approval request failed", exc_info=True)
            return ApprovalResult(status="rejected", reason="Elicitation request failed")

        if result is None:
            return ApprovalResult(status="rejected", reason="Elicitation returned no response")

        action = result.get("action") if isinstance(result, dict) else getattr(result, "action", None)
        content = result.get("content") if isinstance(result, dict) else getattr(result, "content", None)

        if action != "accept":
            return ApprovalResult(status="rejected", reason=f"User action: {action}")

        # action == "accept": honor an explicit approve=False from the form;
        # clients that render no field send none, so accept itself means approval.
        approve = True
        if isinstance(content, dict) and "approve" in content:
            approve = bool(content["approve"])
        if not approve:
            return ApprovalResult(status="rejected", reason="User declined approval")
        return ApprovalResult(status="approved")

    async def check_approval(self, approval_id: str) -> ApprovalResult:
        """Check status of an existing approval.

        Phase B (async polling) is not supported via MCP elicitation since
        elicitation is stateless.

        Args:
            approval_id: The approval ID to check.

        Returns:
            Always returns rejected since Phase B is not supported.
        """
        return ApprovalResult(status="rejected", reason="Phase B not supported via MCP elicitation")


def _store_failure_reason(exc: BaseException) -> str:
    """Classify an ApprovalStore failure into a contract reason string.

    The approval gate fails closed: a store that is momentarily unreachable
    must produce a rejected result, never an exception escaping the handler.
    ``ApprovalStore`` is a bare Protocol with no declared error hierarchy, so a
    capacity rejection can only be recognised by ``MemoryError`` or by the
    exception naming it — anything else is reported as a generic storage error.
    """
    if isinstance(exc, MemoryError):
        return "Store capacity exceeded"
    if "capacity" in f"{type(exc).__name__} {exc}".lower():
        return "Store capacity exceeded"
    return "Storage error"


_CORE_SCOPED_APPROVAL = hasattr(core_approval, "ScopedApprovalHandler")
_TOKEN_SECRET = re.compile(r"[A-Za-z0-9_-]{43}")
_NO_PHASE_B = "Scoped approval is unavailable for this call"


def _approval_principal(identity: Identity | None) -> ApprovalPrincipal:
    return (identity.type, identity.id) if isinstance(identity, Identity) else None


def _is_public_approval_id(value: object) -> TypeGuard[str]:
    if not isinstance(value, str) or len(value) != 36:
        return False
    try:
        identifier = uuid.UUID(value)
        return identifier.version == 4 and str(identifier) == value
    except ValueError:
        return False


def _argument_snapshot(arguments: dict[str, Any]) -> str:
    return json.dumps(arguments, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _scope_for(request: ApprovalRequest, snapshot: str) -> ApprovalScope:
    return ApprovalScope(
        _approval_principal(request.context.identity),
        request.caller_id,
        request.module_id,
        sha256(snapshot.encode("utf-8")).hexdigest(),
    )


class _ScopedMCPApprovalHandler(Protocol):
    @property
    def scoped_approval_available(self) -> bool: ...

    async def request_approval(self, request: ApprovalRequest) -> ApprovalResult: ...

    async def check_approval(self, approval_id: str) -> ApprovalResult: ...

    async def check_approval_for_call(self, credential: str, request: ApprovalRequest) -> ApprovalResult: ...

    async def poll_approval(self, approval_id: str, principal: ApprovalPrincipal) -> ApprovalResult: ...


def _implements_mcp_scoped_approval(handler: object) -> TypeGuard[_ScopedMCPApprovalHandler]:
    return (
        getattr(handler, "scoped_approval_available", None) is True
        and all(callable(getattr(handler, method, None)) for method in (
            "request_approval", "check_approval", "check_approval_for_call", "poll_approval",
        ))
    )


class StorageBackedApprovalHandler(ApprovalHandler):
    """Store a scoped approval with a public record ID and a separate private credential.

    Out-of-band notification receives the public ID, module ID and original
    business arguments. Only the pending approval result carries the credential.
    """

    def __init__(self, store: Any, *, notify_callback: Any | None = None) -> None:
        self._store = store
        self._notify = notify_callback

    @property
    def scoped_approval_available(self) -> bool:
        return _CORE_SCOPED_APPROVAL and isinstance(self._store, ScopedApprovalStore)

    async def request_approval(self, request: ApprovalRequest) -> ApprovalResult:
        if not self.scoped_approval_available:
            return ApprovalResult(status="rejected", reason=_NO_PHASE_B)
        try:
            snapshot = _argument_snapshot(request.arguments)
            scope = _scope_for(request, snapshot)
        except (TypeError, ValueError, RecursionError):
            return ApprovalResult(status="rejected", reason="Approval requires JSON business arguments")
        approval_id = str(uuid.uuid4())
        credential = f"{approval_id}.{secrets.token_urlsafe(32)}"
        verifier = sha256(credential.encode("ascii")).hexdigest()
        try:
            await self._store.save_scoped_pending(approval_id, json.loads(snapshot), scope, verifier)
        except Exception as exc:
            return self._storage_failure("save", exc)

        if self._notify is not None:
            try:
                await self._notify(approval_id, request.module_id, json.loads(snapshot))
            except Exception:
                logger.warning("Approval notification failed for record %s", approval_id)
        return ApprovalResult(status="pending", approval_id=credential, audit_id=approval_id)

    async def check_approval(self, approval_id: str) -> ApprovalResult:
        # Older Core invokes this status-only method for authorization and
        # cannot pass a current invocation scope.
        return ApprovalResult(status="rejected", reason=_NO_PHASE_B)

    async def poll_approval(self, approval_id: str, principal: ApprovalPrincipal) -> ApprovalResult:
        if not self.scoped_approval_available or not _is_public_approval_id(approval_id):
            return ApprovalResult(status="rejected", reason=_NO_PHASE_B)
        try:
            record = await self._store.get_scoped_result(approval_id, principal)
        except Exception as exc:
            return self._storage_failure("poll", exc)
        return self._public_decision(record)

    async def check_approval_for_call(self, credential: str, request: ApprovalRequest) -> ApprovalResult:
        approval_id, _, secret = credential.partition(".")
        if (
            not self.scoped_approval_available
            or not _is_public_approval_id(approval_id)
            or not _TOKEN_SECRET.fullmatch(secret)
        ):
            return ApprovalResult(status="rejected", reason="Approval is unavailable for this invocation")
        try:
            scope = _scope_for(request, _argument_snapshot(request.arguments))
        except (TypeError, ValueError, RecursionError):
            return ApprovalResult(status="rejected", reason="Approval requires JSON business arguments")
        verifier = sha256(credential.encode("ascii")).hexdigest()
        try:
            record = await self._store.consume_scoped(approval_id, scope, verifier)
        except Exception as exc:
            return self._storage_failure("resume", exc)
        decision = self._public_decision(record)
        if decision.status == "pending":
            return ApprovalResult(status="pending", approval_id=credential, audit_id=approval_id)
        return ApprovalResult(status=decision.status, reason=decision.reason, audit_id=approval_id if record else None)

    @staticmethod
    def _public_decision(record: dict[str, Any] | None) -> ApprovalResult:
        status = record.get("status") if record is not None else None
        if status == "approved":
            return ApprovalResult(status="approved")
        if status == "pending":
            return ApprovalResult(status="pending")
        return ApprovalResult(status="rejected", reason="Approval is unavailable for this invocation")

    @staticmethod
    def _storage_failure(operation: str, exc: Exception) -> ApprovalResult:
        reason = _store_failure_reason(exc)
        # Store exceptions may contain sensitive arguments or credentials.
        logger.warning("Approval store %s failed: %s", operation, reason)
        return ApprovalResult(status="rejected", reason=reason)


@dataclass
class _ApprovalDelivery:
    handler: _ScopedMCPApprovalHandler
    module_id: str
    active: bool = True
    pending: ApprovalResult | None = None
    metadata: dict[str, str] | None = None


_approval_delivery: ContextVar[_ApprovalDelivery | None] = ContextVar("mcp_approval_delivery", default=None)


@contextmanager
def _capture_approval_delivery(handler: _ScopedMCPApprovalHandler, module_id: str) -> Iterator[_ApprovalDelivery]:
    delivery = _ApprovalDelivery(handler, module_id)
    token = _approval_delivery.set(delivery)
    try:
        yield delivery
    finally:
        delivery.active = False
        _approval_delivery.reset(token)


def _pending_metadata(result: ApprovalResult) -> dict[str, str] | None:
    approval_id, credential = result.audit_id, result.approval_id
    if (
        _is_public_approval_id(approval_id)
        and isinstance(credential, str)
        and 0 < len(credential) <= 256
        and approval_id != credential
    ):
        return {"approvalId": approval_id, "resumeToken": credential}
    return None


def _capture_pending_error(error: ApprovalPendingError) -> None:
    delivery = _approval_delivery.get()
    if delivery is not None and delivery.pending is not None and error.result is delivery.pending:
        delivery.metadata = _pending_metadata(delivery.pending)


class _MCPScopedApprovalGate:
    """Allow credential issuance and consumption on MCP's scoped result path."""

    def __init__(self, handler: _ScopedMCPApprovalHandler) -> None:
        self._handler = handler

    def _delivery_for(self, request: ApprovalRequest) -> _ApprovalDelivery | None:
        delivery = _approval_delivery.get()
        if (
            _CORE_SCOPED_APPROVAL
            and delivery is not None
            and delivery.active
            and delivery.handler is self._handler
            and request.caller_id is None
            and request.module_id == delivery.module_id
        ):
            return delivery
        return None

    @staticmethod
    def _record_decision(
        result: ApprovalResult, delivery: _ApprovalDelivery, credential: str | None = None,
    ) -> ApprovalResult:
        if result.status == "pending":
            metadata = _pending_metadata(result)
            if metadata is None:
                return ApprovalResult(status="rejected", reason="The provider returned an invalid pending approval")
            # Core audits reasons and approvers. A pending result only needs
            # the private credential and its separate public correlation ID.
            pending = ApprovalResult(
                status="pending", approval_id=metadata["resumeToken"], audit_id=metadata["approvalId"],
            )
            delivery.pending = pending
            return pending

        credentials = {value for value in (credential, result.approval_id) if isinstance(value, str) and value}

        def redact(value: str | None) -> str | None:
            if not isinstance(value, str):
                return None
            for secret in credentials:
                value = value.replace(secret, "[redacted]")
            return value

        return ApprovalResult(
            status=result.status,
            reason=redact(result.reason),
            approved_by=redact(result.approved_by),
            audit_id=(
                result.audit_id
                if _is_public_approval_id(result.audit_id) and result.audit_id not in credentials
                else None
            ),
        )

    async def request_approval(self, request: ApprovalRequest) -> ApprovalResult:
        delivery = self._delivery_for(request)
        if delivery is None:
            return ApprovalResult(status="rejected", reason=_NO_PHASE_B)
        try:
            result = await self._handler.request_approval(request)
            return self._record_decision(result, delivery)
        except Exception:
            logger.warning("Scoped approval request failed")
            return ApprovalResult(status="rejected", reason=_NO_PHASE_B)

    async def check_approval(self, approval_id: str) -> ApprovalResult:
        return ApprovalResult(status="rejected", reason=_NO_PHASE_B)

    async def check_approval_for_call(self, credential: str, request: ApprovalRequest) -> ApprovalResult:
        delivery = self._delivery_for(request)
        if delivery is None:
            return ApprovalResult(status="rejected", reason=_NO_PHASE_B)
        try:
            result = await self._handler.check_approval_for_call(credential, request)
            return self._record_decision(result, delivery, credential)
        except Exception:
            logger.warning("Scoped approval resumption failed")
            return ApprovalResult(status="rejected", reason=_NO_PHASE_B)
