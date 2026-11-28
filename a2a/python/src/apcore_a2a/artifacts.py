"""Opt-in hosted download links for finalized A2A results."""

from __future__ import annotations

import re
import time
from collections.abc import Awaitable, Callable, Iterable
from copy import deepcopy
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from a2a.types import Part
from apcore import Executor, Identity
from apcore.builtin_steps import BuiltinExecute, BuiltinOutputValidation

_OPAQUE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")
_MEDIA_TYPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*")
# Pilot support is limited to direct declarations. These schema applicators
# can place a second annotation on the same instance path.
_SCHEMA_APPLICATORS = frozenset(
    {"$ref", "$dynamicRef", "allOf", "anyOf", "oneOf", "if", "then", "else", "dependentSchemas", "patternProperties"}
)


@dataclass(frozen=True, slots=True)
class HostedArtifact:
    """An authorized download issued by the host, with expiry in Unix seconds."""

    url: str
    filename: str
    media_type: str
    size_bytes: int
    expires_at: float


ArtifactResolver = Callable[[str, Identity], Awaitable[HostedArtifact | None]]


class ArtifactLinkPolicy:
    """Ask a trusted host resolver for A2A links without fetching any content."""

    def __init__(self, resolve: ArtifactResolver, allowed_hosts: Iterable[str], *, max_bytes: int = 8_388_608) -> None:
        if not callable(resolve):
            raise ValueError("Expected an artifact resolver")
        if isinstance(allowed_hosts, str):
            raise ValueError("Pass a collection of exact allowed hostnames")
        candidates = tuple(allowed_hosts)
        if not all(isinstance(host, str) for host in candidates):
            raise ValueError("Artifact links require exact allowed hostnames")
        hosts = frozenset(host.lower() for host in candidates)
        if not hosts or any(len(host) > 253 or not _HOST.fullmatch(host) for host in hosts):
            raise ValueError("Artifact links require exact allowed hostnames")
        if type(max_bytes) is not int or max_bytes <= 0:
            raise ValueError("Artifact link size limit must be a positive integer")
        self._resolve = resolve
        self._allowed_hosts = hosts
        self._max_bytes = max_bytes

    def _is_allowed(self, artifact: HostedArtifact) -> bool:
        return (
            type(artifact.size_bytes) is int
            and 0 <= artifact.size_bytes <= self._max_bytes
            and type(artifact.expires_at) in (int, float)
            and time.time() < artifact.expires_at < float("inf")
            and isinstance(artifact.filename, str)
            and 0 < len(artifact.filename) <= 200
            and artifact.filename.isprintable()
            and artifact.filename not in (".", "..")
            and "/" not in artifact.filename
            and chr(92) not in artifact.filename
            and isinstance(artifact.media_type, str)
            and len(artifact.media_type) <= 127
            and _MEDIA_TYPE.fullmatch(artifact.media_type) is not None
            and self._is_allowed_url(artifact.url)
        )

    def _is_allowed_url(self, url: str) -> bool:
        if not isinstance(url, str) or not 0 < len(url) <= 4096 or chr(92) in url:
            return False
        if not url.isascii() or any(not char.isprintable() or char.isspace() for char in url):
            return False
        try:
            parts = urlsplit(url)
            host = parts.hostname
        except ValueError:
            return False
        return (
            parts.scheme == "https"
            and host in self._allowed_hosts
            and parts.netloc.lower() in (host, f"{host}:443")
            and not parts.fragment
        )

    async def _resolve_parts(self, output: dict[str, Any], fields: tuple[str, ...], identity: Identity) -> list[Part]:
        artifacts: list[HostedArtifact] = []
        unique_ids: set[str] = set()
        for field in fields:
            artifact_id = output.get(field)
            if not isinstance(artifact_id, str) or not _OPAQUE_ID.fullmatch(artifact_id) or artifact_id in unique_ids:
                continue
            unique_ids.add(artifact_id)
            try:
                metadata = await self._resolve(artifact_id, identity)
            except Exception:
                continue  # Do not expose resolver errors or signed URLs in task diagnostics.
            if isinstance(metadata, HostedArtifact):
                artifacts.append(metadata)

        return [
            Part(url=artifact.url, media_type=artifact.media_type, filename=artifact.filename)
            for artifact in artifacts
            if self._is_allowed(artifact)
        ]


def _link_fields(schema: Any) -> tuple[str, ...]:
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return ()
    if schema.get("x-sensitive") or not _SCHEMA_APPLICATORS.isdisjoint(schema):
        return ()
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return ()
    return tuple(
        name
        for name, declaration in properties.items()
        if isinstance(declaration, dict)
        and declaration.get("type") == "string"
        and declaration.get("x-a2a-artifact") is True
        and not declaration.get("x-sensitive")
        and _SCHEMA_APPLICATORS.isdisjoint(declaration)
    )


@dataclass(frozen=True, slots=True)
class _ArtifactDeclaration:
    registry: Any
    skill_id: str
    registration: Any
    schema: dict[str, Any]
    fields: tuple[str, ...]
    identity: Identity

    def is_current(self) -> bool:
        try:
            resolved = self.registry._resolve_registration(self.skill_id, None)
            if resolved is not self.registration:
                return False
            descriptor = self.registry._describe_registration(self.skill_id, resolved, warn_deprecation=False)
            return descriptor.output_schema == self.schema
        except Exception:
            return False


def _artifact_declaration(
    registry: Any, executor: Any, skill_id: str, identity: Identity
) -> _ArtifactDeclaration | None:
    """Use a stable declaration from the registry the Core executor actually uses."""
    if not isinstance(identity.id, str) or not identity.id:
        return None
    if not isinstance(executor, Executor) or executor.registry is not registry:
        return None
    try:
        step_types = {type(step) for step in executor.current_strategy.steps}
        if not {BuiltinExecute, BuiltinOutputValidation} <= step_types:
            return None
        registration = registry._resolve_registration(skill_id, None)
        if registration is None or callable(getattr(registration.module, "stream", None)):
            return None
        descriptor = registry._describe_registration(skill_id, registration, warn_deprecation=False)
        annotations = descriptor.annotations
        streaming = (
            annotations.get("streaming") if isinstance(annotations, dict) else getattr(annotations, "streaming", False)
        )
        schema = deepcopy(descriptor.output_schema)
        fields = _link_fields(schema)
        if streaming or not fields:
            return None
        return _ArtifactDeclaration(registry, skill_id, registration, schema, fields, deepcopy(identity))
    except Exception:
        # Older Core or an unprovable declaration keeps ordinary output behavior.
        return None


def _validated_output(trace: Any) -> bool:
    """Ignore outputs recovered from a failure before final validation."""
    completed = set()
    for step in trace.steps:
        if step.name == "context_creation":
            completed.clear()
        if (
            not step.skipped
            and not step.skip_reason
            and step.result.action == "continue"
            and step.result.explanation is None
        ):
            completed.add(step.name)
    return {"execute", "output_validation", "return_result"} <= completed
