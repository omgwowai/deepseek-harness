#!/usr/bin/env python3
"""CLI for the dsh local service hub v2 (http://127.0.0.1:6692).

子命令：register / start / stop / standby / check / heartbeat / remove / list / health / open。

`register` 支持两种登记形态（按是否传 --kind 区分）：
  1. 本地网页（无 --kind）→ POST /api/services；
  2. 集群任务（--kind k8s|ssh）→ POST /api/sessions/{session_id}/tasks，
     此时 --session 必填，--title 缺省用 --name。

`remove <id>` 同时尝试删除 task 与 service（task 的 session 用 --session 指定，
否则回退到最近会话），两者都失败才报错。
"""

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


# 默认指向本机 6692；无 DSH_SERVICE_HUB_PORT 环境变量，因此不存在 '0' 默认端口 bug。
HUB_URL = os.environ.get("DSH_SERVICE_HUB_URL", "http://127.0.0.1:6692").rstrip("/")


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


def _cwd(args: argparse.Namespace) -> str:
    return str(Path(args.cwd).expanduser().resolve()) if args.cwd else str(Path.cwd())


def add_service(args: argparse.Namespace) -> dict[str, Any]:
    """本地网页登记 → POST /api/services。"""
    if not args.url:
        raise HubError("url is required (or use --kind k8s|ssh to register a cluster task)")
    payload = {
        "id": args.id,
        "name": args.name,
        "url": args.url,
        "cwd": _cwd(args),
        "description": args.description,
        "start_command": args.start_command,
        "stop_command": args.stop_command,
        "health_url": args.health_url or args.url,
        "pid": args.pid,
        "status": args.status,
        "managed": args.managed,
        "port": args.port,
        "instance_id": args.instance or "",
        "session_id": args.session or "",
    }
    return request("POST", "/api/services", payload)


def add_task(args: argparse.Namespace) -> dict[str, Any]:
    """集群任务登记 → POST /api/sessions/{session_id}/tasks。"""
    if not args.session:
        raise HubError("task registration requires --session <session_id>")
    if not args.target:
        raise HubError("task registration requires --target <cluster|ssh-alias>")
    # 提供 --instance 时先幂等 upsert 会话行，保证任务登记不会因会话缺失而 404。
    if args.instance:
        request("POST", "/api/sessions", {
            "session_id": args.session,
            "instance_id": args.instance,
            "workspace": _cwd(args),
            "title": "",
        })
    payload = {
        "id": args.id,
        "kind": args.kind,
        "target": args.target,
        "pattern": args.pattern,
        "title": args.title or args.name,
        "note": args.note,
        "hub_service_id": args.hub_service,
        "cwd": _cwd(args),
    }
    return request("POST", f"/api/sessions/{quote(args.session, safe='')}/tasks", payload)


def remove_record(args: argparse.Namespace) -> dict[str, Any]:
    """同时尝试删除 task 与 service，两者都失败才报错。"""
    errors: list[str] = []
    task_deleted = False
    service_deleted = False

    # 1) 集群任务：--session 指定，否则回退到最近会话。
    session = args.session
    if not session:
        try:
            sessions = request("GET", "/api/sessions") or []
            session = sessions[0]["session_id"] if sessions else None
        except HubError:
            session = None
    if session:
        try:
            request("DELETE", f"/api/sessions/{quote(session, safe='')}/tasks/{quote(args.id, safe='')}")
            task_deleted = True
        except HubError as exc:
            errors.append(f"task: {exc}")
    # 2) 本地网页。
    try:
        request("DELETE", f"/api/services/{quote(args.id, safe='')}")
        service_deleted = True
    except HubError as exc:
        errors.append(f"service: {exc}")

    if task_deleted or service_deleted:
        return {"deleted": args.id, "task": task_deleted, "service": service_deleted}
    raise HubError("remove failed: " + ("; ".join(errors) if errors else "no matching record"))


def print_service(service: dict[str, Any]) -> None:
    print(f"{service['id']}\t{service['status']}\t{service['name']}\t{service['url']}\t{service.get('cwd') or '-'}")


def print_task(task: dict[str, Any]) -> None:
    hub = f"\thub={task['hub_service_id']}" if task.get("hub_service_id") else ""
    print(f"{task['id']}\t{task['title']}\t{task['kind']}:{task['target']}\tpattern={task.get('pattern') or ''}{hub}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    sub.add_parser("open")
    listing = sub.add_parser("list")
    listing.add_argument("--check", action="store_true")

    add = sub.add_parser("register", help="register a local page (default) or a cluster task (--kind k8s|ssh)")
    add.add_argument("--id", default="", help="stable id; reuse to update")
    add.add_argument("--name", required=True, help="service name, or fallback task title")
    # 本地网页形态的字段（任务形态忽略这些）。
    add.add_argument("--url", default="", help="page URL (required unless --kind is given)")
    add.add_argument("--cwd", default="")
    add.add_argument("--description", default="")
    add.add_argument("--start-command", default="")
    add.add_argument("--stop-command", default="")
    add.add_argument("--health-url", default="")
    add.add_argument("--pid", type=int)
    add.add_argument("--port", type=int)
    add.add_argument("--status", choices=["starting", "online", "standby", "offline", "error"], default="offline")
    add.add_argument("--managed", action="store_true")
    # 归属（两种形态共享）。
    add.add_argument("--instance", default="", help="instance_id (service body / task 时先确保会话存在)")
    add.add_argument("--session", default="", help="session_id (service body / task 必填)")
    # 集群任务形态。
    add.add_argument("--kind", choices=["k8s", "ssh"], default=None, help="route to task registration when set")
    add.add_argument("--target", default="", help="cluster name or ssh host alias (task)")
    add.add_argument("--pattern", default="", help="regex on pod name / process cmdline (task)")
    add.add_argument("--title", default="", help="task title (defaults to --name)")
    add.add_argument("--note", default="", help="task note")
    add.add_argument("--hub-service", default="", help="hub service id to link (task -> hub_service_id)")

    for name in ("start", "stop", "standby", "check", "heartbeat"):
        action = sub.add_parser(name)
        action.add_argument("id")
    rem = sub.add_parser("remove", help="remove a task and/or a service with this id")
    rem.add_argument("id")
    rem.add_argument("--session", default="", help="session_id of the task (defaults to most recent session)")
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
            if args.kind is not None:
                print_task(add_task(args))
            else:
                print_service(add_service(args))
        elif args.command == "remove":
            print(json.dumps(remove_record(args), ensure_ascii=False))
        else:
            service = request("POST", f"/api/services/{quote(args.id, safe='')}/{args.command}")
            print_service(service)
        return 0
    except (HubError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
