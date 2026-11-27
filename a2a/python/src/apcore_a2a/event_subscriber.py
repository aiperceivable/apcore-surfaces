"""Opt-in A2A transport for APCore's event emitter."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from typing import Any

import httpx
from apcore.events import ApCoreEvent, EventRetryConfig, SubscriberRegistry

_logger = logging.getLogger(__name__)


class A2AEventSubscriber:
    """Deliver one HTTP attempt. APCore controls retry and dead letters."""

    subscriber_type = "a2a"

    def __init__(
        self,
        platform_url: str,
        auth: str | dict[str, str] | None = None,
        timeout_ms: int = 5000,
        skill_id: str = "apevo.event_receiver",
        *,
        retry: EventRetryConfig | dict[str, int | float] | None = None,
        subscriber_id: str | None = None,
    ) -> None:
        self._platform_url = platform_url
        self._timeout_s = timeout_ms / 1000 if timeout_ms > 0 else None
        self._skill_id = skill_id
        self._headers = {"Content-Type": "application/json"}
        if isinstance(auth, str):
            self._headers["Authorization"] = f"Bearer {auth}"
        elif isinstance(auth, dict):
            self._headers.update(auth)
        self.retry = retry
        self.subscriber_id = subscriber_id

    async def on_event(self, event: ApCoreEvent) -> None:
        payload = {"skillId": self._skill_id, "event": asdict(event)}
        async with (
            asyncio.timeout(self._timeout_s),
            httpx.AsyncClient(timeout=None, follow_redirects=True, trust_env=False) as client,
            client.stream("POST", self._platform_url, json=payload, headers=self._headers) as response,
        ):
            if response.status_code >= 500:
                raise RuntimeError(f"A2A event delivery failed with HTTP {response.status_code}")
            if response.status_code >= 400:
                _logger.warning("A2A event %s rejected with HTTP %d", event.event_type, response.status_code)


def _from_config(config: dict[str, Any]) -> A2AEventSubscriber:
    return A2AEventSubscriber(
        platform_url=config["platform_url"],
        auth=config.get("auth"),
        timeout_ms=config.get("timeout_ms", 5000),
        skill_id=config.get("skill_id", "apevo.event_receiver"),
        retry=config.get("retry"),
        subscriber_id=config.get("id"),
    )


def register_a2a_subscriber(registry: SubscriberRegistry) -> None:
    """Register the A2A transport for a host's configured subscribers."""
    registry.register("a2a", _from_config)
