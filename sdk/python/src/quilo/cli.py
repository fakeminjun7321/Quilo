"""Quilo command-line client."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .client import QuiloClient
from .exceptions import QuiloApiError, QuiloError


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="quilo", description="Quilo API CLI")
    root.add_argument("--api-key", default=os.getenv("QUILO_ACCESS_TOKEN"))
    root.add_argument("--base-url", default=os.getenv("QUILO_BASE_URL"))
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("account")
    features = commands.add_parser("features")
    features.add_argument("query", nargs="?")
    commands.add_parser("jobs")
    job = commands.add_parser("job")
    job.add_argument("id")
    estimate = commands.add_parser("estimate-pdf")
    estimate.add_argument("file")
    estimate.add_argument("--mode", default="auto", choices=["auto", "inplace", "retypeset"])
    estimate.add_argument("--model", default="claude-sonnet-5")
    translate = commands.add_parser("translate-pdf")
    translate.add_argument("files", nargs="+")
    translate.add_argument("--mode", default="auto", choices=["auto", "inplace", "retypeset"])
    translate.add_argument("--model", default="claude-sonnet-5")
    translate.add_argument("--background", action="store_true")
    translate.add_argument("--wait", action="store_true")
    download = commands.add_parser("download")
    download.add_argument("id")
    download.add_argument("destination")
    download.add_argument("--file-index", type=int)
    convert = commands.add_parser("convert-docx")
    convert.add_argument("file")
    convert.add_argument("destination")
    return root


def emit(value: object) -> None:
    if hasattr(value, "raw"):
        value = value.raw
    if isinstance(value, Path):
        value = {"path": str(value)}
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    client = QuiloClient(api_key=args.api_key, base_url=args.base_url)
    try:
        if args.command == "account":
            emit(client.account())
        elif args.command == "features":
            emit(client.features(args.query))
        elif args.command == "jobs":
            emit([job.raw for job in client.jobs.list()])
        elif args.command == "job":
            emit(client.jobs.retrieve(args.id))
        elif args.command == "estimate-pdf":
            emit(client.pdf.estimate(args.file, mode=args.mode, model=args.model))
        elif args.command == "translate-pdf":
            job = client.pdf.translate(args.files, mode=args.mode, model=args.model, background=args.background)
            emit(client.jobs.wait(job.id) if args.wait else job)
        elif args.command == "download":
            emit(client.jobs.download(args.id, args.destination, file_index=args.file_index))
        elif args.command == "convert-docx":
            emit(client.conversions.docx_to_hwpx(args.file, args.destination))
        return 0
    except QuiloApiError as error:
        print(f"Quilo API error ({error.status_code}/{error.code or 'UNKNOWN'}): {error}", file=sys.stderr)
        if error.request_id:
            print(f"requestId: {error.request_id}", file=sys.stderr)
        return 2
    except (QuiloError, OSError, ValueError) as error:
        print(f"Quilo error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
