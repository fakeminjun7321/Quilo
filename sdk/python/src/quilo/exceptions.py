"""Quilo SDK exceptions."""

from __future__ import annotations

from typing import Any


class QuiloError(Exception):
    """Base exception raised by the Quilo SDK."""


class QuiloApiError(QuiloError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: str | None = None,
        request_id: str | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.request_id = request_id
        self.body = body


class QuiloTimeoutError(QuiloError):
    """Raised when waiting for a Quilo job exceeds the caller timeout."""
