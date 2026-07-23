"""Dependency-free HTTP and multipart helpers for the Quilo SDK."""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .exceptions import QuiloApiError


@dataclass(slots=True)
class HttpResponse:
    status: int
    headers: Any
    body: bytes

    def json(self) -> dict[str, Any]:
        if not self.body:
            return {}
        value = json.loads(self.body.decode("utf-8"))
        return value if isinstance(value, dict) else {"data": value}


def encode_multipart(
    fields: dict[str, Any] | None = None,
    files: Iterable[tuple[str, str | os.PathLike[str], str | None]] | None = None,
) -> tuple[bytes, str]:
    boundary = f"----quilo-{secrets.token_hex(16)}"
    chunks: list[bytes] = []

    def line(value: str) -> None:
        chunks.append(value.encode("utf-8") + b"\r\n")

    for name, value in (fields or {}).items():
        values = value if isinstance(value, (list, tuple)) else [value]
        for item in values:
            if item is None:
                continue
            if isinstance(item, bool):
                item = "true" if item else "false"
            elif isinstance(item, (dict, list)):
                item = json.dumps(item, ensure_ascii=False)
            line(f"--{boundary}")
            line(f'Content-Disposition: form-data; name="{name}"')
            line("")
            line(str(item))

    for field, file_path, content_type in files or []:
        path = Path(file_path).expanduser().resolve(strict=True)
        mime = content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        safe_name = path.name.replace('"', "")
        line(f"--{boundary}")
        line(f'Content-Disposition: form-data; name="{field}"; filename="{safe_name}"')
        line(f"Content-Type: {mime}")
        line("")
        chunks.append(path.read_bytes())
        chunks.append(b"\r\n")

    line(f"--{boundary}--")
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def raise_api_error(response: HttpResponse) -> None:
    try:
        body: Any = response.json()
    except Exception:
        body = {"error": response.body.decode("utf-8", errors="replace")[:1000]}
    message = body.get("error") if isinstance(body, dict) else None
    if isinstance(message, dict):
        message = message.get("message")
    raise QuiloApiError(
        str(message or f"Quilo returned HTTP {response.status}"),
        status_code=response.status,
        code=body.get("code") if isinstance(body, dict) else None,
        request_id=(body.get("requestId") if isinstance(body, dict) else None)
        or response.headers.get("X-Request-Id"),
        body=body,
    )


def request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 60.0,
) -> HttpResponse:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as opened:
            return HttpResponse(opened.status, opened.headers, opened.read())
    except urllib.error.HTTPError as error:
        response = HttpResponse(error.code, error.headers, error.read())
        raise_api_error(response)
        raise AssertionError("unreachable")


def query_string(values: dict[str, Any] | None) -> str:
    clean = {key: value for key, value in (values or {}).items() if value is not None}
    return urllib.parse.urlencode(clean, doseq=True)
