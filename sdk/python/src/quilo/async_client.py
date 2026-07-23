"""Async facade for the dependency-free Quilo client."""

from __future__ import annotations

import asyncio
from typing import Any

from .client import QuiloClient


class _AsyncProxy:
    def __init__(self, target: Any) -> None:
        self._target = target

    def __getattr__(self, name: str) -> Any:
        method = getattr(self._target, name)

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await asyncio.to_thread(method, *args, **kwargs)

        return call


class AsyncQuiloClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._sync = QuiloClient(*args, **kwargs)
        self.jobs = _AsyncProxy(self._sync.jobs)
        self.pdf = _AsyncProxy(self._sync.pdf)
        self.reports = _AsyncProxy(self._sync.reports)
        self.conversions = _AsyncProxy(self._sync.conversions)
        self.documents = _AsyncProxy(self._sync.documents)
        self.tools = _AsyncProxy(self._sync.tools)
        self.studios = _AsyncProxy(self._sync.studios)
        self.file_chat = _AsyncProxy(self._sync.file_chat)
        self.knowledge = _AsyncProxy(self._sync.knowledge)
        self.community = _AsyncProxy(self._sync.community)
        self.webhooks = _AsyncProxy(self._sync.webhooks)
        self.integrations = _AsyncProxy(self._sync.integrations)

    async def account(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.account)

    async def features(self, query: str | None = None) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._sync.features, query)
