"""Small typed models returned by the Quilo SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class Job:
    id: str
    status: str = "unknown"
    type: str = ""
    model: str = ""
    filename: str | None = None
    file_id: str | None = None
    error: str | None = None
    progress: list[Any] = field(default_factory=list)
    download_url: str | None = None
    events_url: str | None = None
    files: list[dict[str, Any]] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def terminal(self) -> bool:
        return self.status in {"completed", "failed", "cancelled", "interrupted"}

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Job":
        return cls(
            id=str(value.get("id") or value.get("jobId") or ""),
            status=str(value.get("status") or ("running" if value.get("jobId") else "unknown")),
            type=str(value.get("type") or value.get("reportType") or ""),
            model=str(value.get("model") or ""),
            filename=value.get("filename"),
            file_id=value.get("fileId"),
            error=value.get("error"),
            progress=list(value.get("progress") or []),
            download_url=value.get("downloadUrl"),
            events_url=value.get("eventsUrl"),
            files=list(value.get("files") or []),
            raw=dict(value),
        )


@dataclass(slots=True)
class JobEvent:
    event: str
    data: Any
