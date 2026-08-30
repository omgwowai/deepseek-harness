#!/usr/bin/env python3
"""CLI for the DSH local HTML service registry."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


HUB_URL = os.environ.get("DSH_SERVICE_HUB_URL", "http://127.0.0.1:{}/".format(os.environ.get("DSH_SERVICE_HUB_PORT", "0"))).rstrip("/")


class HubError(RuntimeError):
    pass


def request(method: str, path: str, payload: Optional[dict[str, Any]] = None) -> Any:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    try:
        with urlopen(Request(HUB_URL + path, data=data, method=method, headers=headers), timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            message = json.loads(exc.read().decode("utf-8")).get("error", str(exc))
        except Exception:
            message = str(exc)
        raise HubError(message) from exc
    except (URLError, TimeoutError) as exc:
        raise HubError(f"service hub unavailable at {HUB_URL}: {exc}") from exc


def add_service(args: argparse.Namespace) -> dict[str, Any]:
    payload = {
        "id": args.id,
        "name": args.name,
        "url": args.url,
        "cwd": str(Path(args.cwd).expanduser().resolve()) if args.cwd else str(Path.cwd()),
        "description": args.description,
        "start_command": args.start_command,
        "stop_command": args.stop_command,
        "health_url": args.health_url or args.url,
        "pid": args.pid,
        "status": args.status,
        "managed": args.managed,
        "port": args.port,
    }
    return request("POST", "/api/services", payload)


def print_service(service: dict[str, Any]) -> None:
    print(f"{service['id']}\t{service['status']}\t{service['name']}\t{service['url']}\t{service.get('cwd') or '-'}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    sub.add_parser("open")
    listing = sub.add_parser("list")
    listing.add_argument("--check", action="store_true")
    add = sub.add_parser("register")
    add.add_argument("--id", default="")
    add.add_argument("--name", required=True)
    add.add_argument("--url", required=True)
    add.add_argument("--cwd", default="")
    add.add_argument("--description", default="")
    add.add_argument("--start-command", default="")
    add.add_argument("--stop-command", default="")
    add.add_argument("--health-url", default="")
    add.add_argument("--pid", type=int)
    add.add_argument("--port", type=int)
    add.add_argument("--status", choices=["starting", "online", "standby", "offline", "error"], default="offline")
    add.add_argument("--managed", action="store_true")
    for name in ("start", "stop", "standby", "check", "heartbeat", "remove"):
        action = sub.add_parser(name)
        action.add_argument("id")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "health":
            print(json.dumps(request("GET", "/api/health"), ensure_ascii=False, indent=2))
        elif args.command == "open":
            subprocess.run(["open", HUB_URL], check=True)
        elif args.command == "list":
            suffix = "?check=1" if args.check else ""
            for service in request("GET", "/api/services" + suffix):
                print_service(service)
        elif args.command == "register":
            print_service(add_service(args))
        elif args.command == "remove":
            print(json.dumps(request("DELETE", f"/api/services/{quote(args.id)}"), ensure_ascii=False))
        else:
            service = request("POST", f"/api/services/{quote(args.id)}/{args.command}")
            print_service(service)
        return 0
    except (HubError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
