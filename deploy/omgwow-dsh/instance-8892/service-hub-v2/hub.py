#!/usr/bin/env python3
"""DSH 本地服务台 v2 —— 合并实例 / 会话 / 服务页面 / 集群任务 / 输入统计的单进程本地面板。

单文件 Python 3 标准库实现（http.server + sqlite3；zstandard 惰性导入，无其它依赖），
绑定 127.0.0.1:6692（DSH_SERVICE_HUB_PORT 可覆盖）。合并并扩展 v1 服务台与 omp
cluster-monitor：一个后台线程每 120s（DSH_HUB_POLL_INTERVAL，下限 60s）轮询
K8s/SSH 来源，snapshot 落到 source_snapshots；会话任务的 pattern 据此做正则匹配。
输入统计只统计 dsh 会话日志中 type=user/message 且 data.source.kind=='user' 的事件。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

HOST = os.environ.get("DSH_SERVICE_HUB_HOST", "127.0.0.1")
PORT = int(os.environ.get("DSH_SERVICE_HUB_PORT", "6692"))
BASE_DIR = Path(__file__).resolve().parent
STATE_DIR = Path(os.environ.get("DSH_SERVICE_HUB_STATE_DIR", BASE_DIR / "state"))
DB_PATH = STATE_DIR / "service-hub-v2.sqlite3"
LOG_DIR = STATE_DIR / "logs"

MAX_BODY_BYTES = 1_048_576
CHECK_INTERVAL_SECONDS = 10
STALE_AFTER_SECONDS = 45
ALLOWED_STATUSES = {"starting", "online", "standby", "offline", "error"}
DB_LOCK = threading.RLock()

# ---- input-stats 常量（沿用 v1：字符 <=10 或输入 <=1 次的会话不计入） ---------
MIN_SESSION_CHARACTERS = 10
MIN_SESSION_PROMPTS_EXCLUSIVE = 0
USAGE_CACHE_SECONDS = 60

# ---- cluster poller 常量 ---------------------------------------------------
POLL_INTERVAL = max(60, int(os.environ.get("DSH_HUB_POLL_INTERVAL", "120")))
SSH_TIMEOUT = 18
KUBECTL_TIMEOUT = 30
NODE_CAP_TTL = 3600
CONFIG_PATH = Path(os.environ.get("DSH_HUB_CLUSTER_CONFIG", str(Path.home() / ".omp/cluster-monitor/config.json")))
KUBECONFIG_CACHE = Path.home() / ".omp/cluster-monitor/state/kubeconfig.yaml"
KUBECONFIG_META = Path.home() / ".omp/cluster-monitor/state/kubeconfig.meta.json"
KUBECONFIG_FALLBACK = Path.home() / ".kube" / "config"

DEFAULT_CONFIG = {
    "ssh_hosts": [
        {"name": "bastion01", "enabled": True},
        {"name": "sg-compute", "enabled": True},
        {"name": "token-router-01", "enabled": True},
        {"name": "oracle-sg-bastion01", "enabled": True},
        {"name": "owtr-log-pipeline-01", "enabled": True},
        {"name": "dsh-sg", "enabled": True},
        {"name": "sing", "enabled": False, "note": "publickey denied 2026-08-22"},
        {"name": "sing2", "enabled": False, "note": "publickey denied 2026-08-22"},
        {"name": "workspace2", "enabled": False, "note": "publickey denied 2026-08-22"},
        {"name": "deploy-gpu01-cn-via-bastion", "enabled": False, "note": "RemoteCommand host; cannot exec remote command"},
        {"name": "alaya-bastion01", "enabled": False, "note": "connect timeout (VPN?)"},
        {"name": "alaya-slurm-client01", "enabled": False, "note": "proxy jump timeout"},
        {"name": "alaya-gpu-compute00001", "enabled": False, "note": "proxy jump timeout"},
    ],
    "k8s_clusters": [
        {"name": "chengdu", "enabled": True},
        {"name": "weihai", "enabled": True},
        {"name": "liaoning", "enabled": True},
        {"name": "jiaqi-b300", "enabled": True},
    ],
    "base_interval": 120,
}

SSH_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ClearAllForwardings=yes",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
]

SSH_PROBE = (
    "LANG=C uptime; echo @@; "
    "nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null; echo @@; "
    "free -m 2>/dev/null | awk 'NR==2{print $2\" \"$3}'; echo @@; "
    "ps -eo pid,user,pcpu,pmem,etime,args --sort=-pcpu 2>/dev/null | head -16 | cut -c1-200; echo @@; "
    "command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi "
    "--query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ====================================================================== DB ===

def connect() -> sqlite3.Connection:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(DB_PATH), timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


def initialize_database() -> None:
    with DB_LOCK, connect() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS instances (
                instance_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                base_url TEXT,
                dsh_home TEXT,
                hub_port INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS services (
                id TEXT PRIMARY KEY,
                instance_id TEXT,
                session_id TEXT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                host TEXT NOT NULL DEFAULT '127.0.0.1',
                port INTEGER,
                cwd TEXT,
                description TEXT NOT NULL DEFAULT '',
                start_command TEXT,
                stop_command TEXT,
                health_url TEXT,
                pid INTEGER,
                status TEXT NOT NULL DEFAULT 'offline',
                managed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT,
                last_error TEXT NOT NULL DEFAULT ''
            )
            """
        )
        db.execute("CREATE INDEX IF NOT EXISTS services_updated_idx ON services(updated_at DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS services_session_idx ON services(session_id)")
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                instance_id TEXT,
                workspace TEXT,
                title TEXT,
                first_seen_at TEXT,
                last_seen_at TEXT
            )
            """
        )
        db.execute("CREATE INDEX IF NOT EXISTS sessions_instance_idx ON sessions(instance_id)")
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS session_tasks (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                kind TEXT NOT NULL,
                target TEXT NOT NULL,
                pattern TEXT NOT NULL,
                hub_service_id TEXT,
                title TEXT NOT NULL,
                note TEXT,
                cwd TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.execute("CREATE INDEX IF NOT EXISTS session_tasks_session_idx ON session_tasks(session_id)")
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS source_snapshots (
                source_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                status TEXT,
                last_ok_at TEXT,
                last_error TEXT
            )
            """
        )


# ================================================================ instances ===

def list_instances() -> list[dict[str, Any]]:
    with DB_LOCK, connect() as db:
        rows = db.execute("SELECT * FROM instances ORDER BY name COLLATE NOCASE, instance_id").fetchall()
    return [dict(row) for row in rows]


def get_instance(instance_id: str) -> Optional[dict[str, Any]]:
    with DB_LOCK, connect() as db:
        row = db.execute("SELECT * FROM instances WHERE instance_id = ?", (instance_id,)).fetchone()
    return dict(row) if row else None


def upsert_instance(payload: dict[str, Any]) -> dict[str, Any]:
    instance_id = str(payload.get("instance_id") or "").strip()
    if not instance_id:
        raise ValueError("instance_id is required")
    name = str(payload.get("name") or "").strip() or instance_id
    base_url = str(payload.get("base_url") or "").strip() or None
    dsh_home = str(payload.get("dsh_home") or "").strip() or None
    hub_port_value = payload.get("hub_port")
    hub_port = int(hub_port_value) if hub_port_value not in (None, "") else None
    existing = get_instance(instance_id)
    now = utc_now()
    with DB_LOCK, connect() as db:
        db.execute(
            """INSERT INTO instances (instance_id, name, base_url, dsh_home, hub_port, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(instance_id) DO UPDATE SET
                 name=excluded.name, base_url=excluded.base_url, dsh_home=excluded.dsh_home,
                 hub_port=excluded.hub_port, updated_at=excluded.updated_at""",
            (instance_id, name, base_url, dsh_home, hub_port,
             existing["created_at"] if existing else now, now),
        )
    return get_instance(instance_id) or {}


# ================================================================= sessions ===

def get_session(session_id: str) -> Optional[dict[str, Any]]:
    with DB_LOCK, connect() as db:
        row = db.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    return dict(row) if row else None


def upsert_session(payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("session_id") or "").strip()
    if not session_id:
        raise ValueError("session_id is required")
    instance_id = str(payload.get("instance_id") or "").strip() or None
    workspace = str(payload.get("workspace") or "").strip() or None
    title = str(payload.get("title") or "").strip() or None
    existing = get_session(session_id)
    now = utc_now()
    first_seen = existing["first_seen_at"] if existing else now
    merged_instance = instance_id or (existing.get("instance_id") if existing else None)
    merged_workspace = workspace if workspace is not None else (existing.get("workspace") if existing else None)
    merged_title = title if title is not None else (existing.get("title") if existing else None)
    with DB_LOCK, connect() as db:
        db.execute(
            """INSERT INTO sessions (session_id, instance_id, workspace, title, first_seen_at, last_seen_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(session_id) DO UPDATE SET
                 instance_id=excluded.instance_id, workspace=excluded.workspace,
                 title=excluded.title, last_seen_at=excluded.last_seen_at""",
            (session_id, merged_instance, merged_workspace, merged_title, first_seen, now),
        )
    return get_session(session_id) or {}


def _usage_map() -> dict[str, dict[str, Any]]:
    """缓存中的聚合结果：session_id -> sessions[] 条目（用于派生标题与输入统计）。"""
    return {s["session_id"]: s for s in aggregate_usage().get("sessions", [])}


def derive_title(session_id: str, stored_title: Optional[str]) -> str:
    usage = _usage_map().get(session_id)
    if usage and usage.get("title"):
        return usage["title"]
    if stored_title:
        return stored_title
    # usage 缺失（如字符数过低被排除）时，直接从会话日志提取标题
    for root in _scan_roots():
        for log_path in root.rglob("session.jsonl.zstd"):
            if log_path.parent.name != session_id:
                continue
            for record in _session_records(log_path):
                if record.get("type") == "session/title":
                    data = record.get("data") or {}
                    value = data.get("title") if isinstance(data, dict) else None
                    if isinstance(value, str) and value.strip():
                        return value.strip()
            return ""
    return ""


def _enrich_session(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["title"] = derive_title(out["session_id"], out.get("title"))
    usage = _usage_map().get(out["session_id"])
    if usage:
        out["characters"] = usage.get("characters", 0)
        out["prompts"] = usage.get("prompts", 0)
        out["active_days"] = usage.get("active_days", 0)
    else:
        out["characters"] = 0
        out["prompts"] = 0
        out["active_days"] = 0
    with DB_LOCK, connect() as db:
        out["pages"] = db.execute(
            "SELECT COUNT(*) FROM services WHERE session_id = ?", (out["session_id"],)
        ).fetchone()[0]
        out["tasks"] = db.execute(
            "SELECT COUNT(*) FROM session_tasks WHERE session_id = ?", (out["session_id"],)
        ).fetchone()[0]
    return out


def list_sessions(instance_id: Optional[str] = None) -> list[dict[str, Any]]:
    if instance_id:
        with DB_LOCK, connect() as db:
            rows = db.execute(
                "SELECT * FROM sessions WHERE instance_id = ? ORDER BY last_seen_at DESC",
                (instance_id,),
            ).fetchall()
    else:
        with DB_LOCK, connect() as db:
            rows = db.execute("SELECT * FROM sessions ORDER BY last_seen_at DESC").fetchall()
    return [_enrich_session(dict(row)) for row in rows]


# ================================================================== tasks ===

def list_tasks(session_id: Optional[str] = None) -> list[dict[str, Any]]:
    if session_id:
        with DB_LOCK, connect() as db:
            rows = db.execute(
                "SELECT * FROM session_tasks WHERE session_id = ? ORDER BY created_at DESC",
                (session_id,),
            ).fetchall()
    else:
        with DB_LOCK, connect() as db:
            rows = db.execute("SELECT * FROM session_tasks ORDER BY created_at DESC").fetchall()
    return [dict(row) for row in rows]


def upsert_task(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not get_session(session_id):
        raise KeyError(session_id)
    title = str(payload.get("title") or "").strip()
    kind = str(payload.get("kind") or "").strip()
    target = str(payload.get("target") or "").strip()
    if not title:
        raise ValueError("title is required")
    if kind not in ("ssh", "k8s"):
        raise ValueError("kind must be 'ssh' or 'k8s'")
    if not target:
        raise ValueError("target is required (cluster or ssh host name)")
    task_id = str(payload.get("id") or uuid.uuid4().hex[:10]).strip()
    pattern = str(payload.get("pattern") or "").strip() or re.escape(title)
    try:
        re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"invalid pattern regex: {exc}") from exc
    now = utc_now()
    hub_service_id = str(payload.get("hub_service_id") or "").strip() or None
    note = str(payload.get("note") or "").strip() or None
    cwd = str(payload.get("cwd") or "").strip() or None
    with DB_LOCK, connect() as db:
        existing = db.execute("SELECT created_at FROM session_tasks WHERE id = ?", (task_id,)).fetchone()
        db.execute(
            """INSERT INTO session_tasks (id, session_id, kind, target, pattern, hub_service_id, title, note, cwd, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 session_id=excluded.session_id, kind=excluded.kind, target=excluded.target,
                 pattern=excluded.pattern, hub_service_id=excluded.hub_service_id, title=excluded.title,
                 note=excluded.note, cwd=excluded.cwd, updated_at=excluded.updated_at""",
            (task_id, session_id, kind, target, pattern, hub_service_id, title, note, cwd,
             existing["created_at"] if existing else now, now),
        )
    return next((t for t in list_tasks(session_id) if t["id"] == task_id), {})


def delete_task(session_id: str, task_id: str) -> None:
    with DB_LOCK, connect() as db:
        cursor = db.execute("DELETE FROM session_tasks WHERE id = ? AND session_id = ?", (task_id, session_id))
    if cursor.rowcount == 0:
        raise KeyError(task_id)


# =========================================================== source snapshots ==

def list_snapshots() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    with DB_LOCK, connect() as db:
        rows = db.execute("SELECT * FROM source_snapshots").fetchall()
    for row in rows:
        item = dict(row)
        try:
            item["payload"] = json.loads(item["payload"] or "{}")
        except json.JSONDecodeError:
            item["payload"] = {}
        out[item["source_id"]] = item
    return out


def upsert_snapshot(source_id: str, payload: dict[str, Any], status: str,
                    last_ok_at: Optional[str] = None, last_error: str = "") -> None:
    with DB_LOCK, connect() as db:
        db.execute(
            """INSERT INTO source_snapshots (source_id, payload, status, last_ok_at, last_error)
               VALUES (?,?,?,?,?)
               ON CONFLICT(source_id) DO UPDATE SET
                 payload=excluded.payload, status=excluded.status,
                 last_ok_at=excluded.last_ok_at, last_error=excluded.last_error""",
            (source_id, json.dumps(payload, ensure_ascii=False), status, last_ok_at, last_error),
        )


def record_snapshot_failure(source_id: str, message: str) -> None:
    with DB_LOCK, connect() as db:
        db.execute(
            """UPDATE source_snapshots SET status='unreachable', last_error=? WHERE source_id=?""",
            (message[:300], source_id),
        )


# ================================================================ services ===

def row_dict(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["managed"] = bool(item["managed"])
    return item


def list_services(instance_id: Optional[str] = None, session_id: Optional[str] = None,
                  status: Optional[str] = None, q: Optional[str] = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM services"
    where: list[str] = []
    args: list[Any] = []
    if instance_id:
        where.append("instance_id = ?")
        args.append(instance_id)
    if session_id:
        where.append("session_id = ?")
        args.append(session_id)
    if status:
        where.append("status = ?")
        args.append(status)
    if q:
        like = f"%{q.lower()}%"
        where.append("(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(COALESCE(cwd,'')) LIKE ? OR LOWER(url) LIKE ? OR LOWER(id) LIKE ?)")
        args.extend([like, like, like, like, like])
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC, name COLLATE NOCASE"
    with DB_LOCK, connect() as db:
        rows = db.execute(sql, args).fetchall()
    return [row_dict(row) for row in rows]


def get_service(service_id: str) -> Optional[dict[str, Any]]:
    with DB_LOCK, connect() as db:
        row = db.execute("SELECT * FROM services WHERE id = ?", (service_id,)).fetchone()
    return row_dict(row) if row else None


def infer_url_parts(url: str) -> tuple[str, Optional[int]]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("url must be an http:// or https:// address")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.hostname, port


def validate_payload(payload: dict[str, Any], existing: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    merged: dict[str, Any] = dict(existing or {})
    merged.update(payload)
    name = str(merged.get("name", "")).strip()
    url = str(merged.get("url", "")).strip()
    if not name:
        raise ValueError("name is required")
    if not url:
        raise ValueError("url is required")
    host, inferred_port = infer_url_parts(url)
    port_value = merged.get("port", inferred_port)
    port = int(port_value) if port_value not in (None, "") else None
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("port must be between 1 and 65535")
    status = str(merged.get("status", "offline"))
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"status must be one of: {', '.join(sorted(ALLOWED_STATUSES))}")
    cwd_value = str(merged.get("cwd", "")).strip()
    if cwd_value:
        cwd_value = str(Path(cwd_value).expanduser().resolve())
    pid_value = merged.get("pid")
    pid = int(pid_value) if pid_value not in (None, "") else None
    instance_id = str(merged.get("instance_id") or "").strip() or None
    session_id = str(merged.get("session_id") or "").strip() or None
    return {
        "id": str(merged.get("id") or uuid.uuid4().hex[:12]),
        "instance_id": instance_id,
        "session_id": session_id,
        "name": name,
        "url": url,
        "host": str(merged.get("host") or host),
        "port": port,
        "cwd": cwd_value,
        "description": str(merged.get("description", "")).strip(),
        "start_command": str(merged.get("start_command", "")).strip() or None,
        "stop_command": str(merged.get("stop_command", "")).strip() or None,
        "health_url": str(merged.get("health_url", "")).strip() or url,
        "pid": pid,
        "status": status,
        "managed": bool(merged.get("managed", False)),
        "created_at": str(merged.get("created_at") or utc_now()),
        "updated_at": utc_now(),
        "last_seen_at": merged.get("last_seen_at"),
        "last_error": str(merged.get("last_error", "")),
    }


def upsert_service(payload: dict[str, Any]) -> dict[str, Any]:
    requested_id = str(payload.get("id", "")).strip()
    existing = get_service(requested_id) if requested_id else None
    service = validate_payload(payload, existing)
    columns = tuple(service)
    placeholders = ",".join("?" for _ in columns)
    updates = ",".join(f"{column}=excluded.{column}" for column in columns if column not in {"id", "created_at"})
    with DB_LOCK, connect() as db:
        db.execute(
            f"INSERT INTO services ({','.join(columns)}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}",
            tuple(service[column] for column in columns),
        )
    return get_service(service["id"]) or service


def update_fields(service_id: str, **fields: Any) -> dict[str, Any]:
    if not fields:
        service = get_service(service_id)
        if not service:
            raise KeyError(service_id)
        return service
    fields["updated_at"] = utc_now()
    assignments = ",".join(f"{name} = ?" for name in fields)
    with DB_LOCK, connect() as db:
        cursor = db.execute(
            f"UPDATE services SET {assignments} WHERE id = ?",
            (*fields.values(), service_id),
        )
        if cursor.rowcount == 0:
            raise KeyError(service_id)
    service = get_service(service_id)
    if not service:
        raise KeyError(service_id)
    return service


def pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def endpoint_alive(service: dict[str, Any], timeout: float = 1.2) -> tuple[bool, str]:
    health_url = service.get("health_url") or service["url"]
    try:
        request = Request(health_url, method="GET", headers={"User-Agent": "DSH-Service-Hub/2.0"})
        with urlopen(request, timeout=timeout) as response:
            return response.status < 500, ""
    except HTTPError as exc:
        return exc.code < 500, f"HTTP {exc.code}"
    except (URLError, TimeoutError, OSError) as exc:
        return False, str(exc.reason if isinstance(exc, URLError) else exc)


def check_service(service_id: str, preserve_standby: bool = True) -> dict[str, Any]:
    service = get_service(service_id)
    if not service:
        raise KeyError(service_id)
    alive, message = endpoint_alive(service)
    if alive:
        status = "standby" if preserve_standby and service["status"] == "standby" else "online"
        return update_fields(service_id, status=status, last_seen_at=utc_now(), last_error="")
    if pid_alive(service.get("pid")):
        return update_fields(service_id, status="starting", last_error=message)
    status = "standby" if preserve_standby and service["status"] == "standby" else "offline"
    return update_fields(service_id, status=status, pid=None, last_error=message)


def start_service(service_id: str) -> dict[str, Any]:
    service = get_service(service_id)
    if not service:
        raise KeyError(service_id)
    if not service.get("start_command"):
        raise ValueError("service has no start_command")
    cwd = service.get("cwd") or str(Path.home())
    if not Path(cwd).is_dir():
        raise ValueError(f"working directory does not exist: {cwd}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{service_id}.log"
    log_handle = open(log_path, "ab", buffering=0)
    process = subprocess.Popen(
        service["start_command"],
        cwd=cwd,
        shell=True,
        executable="/bin/zsh",
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log_handle.close()
    updated = update_fields(service_id, pid=process.pid, status="starting", managed=1, last_error="")
    for _ in range(15):
        time.sleep(0.2)
        alive, _ = endpoint_alive(updated, timeout=0.35)
        if alive:
            return update_fields(service_id, status="online", last_seen_at=utc_now(), last_error="")
        if process.poll() is not None:
            return update_fields(
                service_id,
                status="error",
                pid=None,
                last_error=f"start command exited with status {process.returncode}; see {log_path}",
            )
    return get_service(service_id) or updated


def stop_process_group(pid: int) -> None:
    if not pid_alive(pid):
        return  # 进程已退出，无需信号
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def stop_service(service_id: str) -> dict[str, Any]:
    service = get_service(service_id)
    if not service:
        raise KeyError(service_id)
    if service.get("stop_command"):
        result = subprocess.run(
            service["stop_command"],
            cwd=service.get("cwd") or str(Path.home()),
            shell=True,
            executable="/bin/zsh",
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode != 0:
            message = (result.stderr or result.stdout).strip()
            return update_fields(service_id, status="error", last_error=message or f"stop exited {result.returncode}")
    elif service.get("managed") and service.get("pid"):
        stop_process_group(int(service["pid"]))
    else:
        raise ValueError("service is not managed and has no stop_command")
    return update_fields(service_id, status="offline", pid=None, last_error="")


def delete_service(service_id: str) -> None:
    service = get_service(service_id)
    if not service:
        raise KeyError(service_id)
    if service.get("managed") and pid_alive(service.get("pid")):
        raise ValueError("stop the managed service before removing its record")
    with DB_LOCK, connect() as db:
        db.execute("DELETE FROM services WHERE id = ?", (service_id,))


def refresh_loop(stop_event: threading.Event) -> None:
    while not stop_event.wait(CHECK_INTERVAL_SECONDS):
        for service in list_services():
            try:
                check_service(service["id"], preserve_standby=True)
            except Exception:
                continue


# ============================================================== input stats ===

def _scan_roots() -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()
    for inst in list_instances():
        home = inst.get("dsh_home")
        if not home:
            continue
        root = Path(home) / "sessions"
        key = str(root)
        if key in seen:
            continue
        seen.add(key)
        roots.append(root)
    return roots


def _character_metrics(text: str) -> tuple[int, int, int, int]:
    characters = len(text)
    utf8_bytes = len(text.encode("utf-8"))
    non_whitespace = sum(1 for char in text if not char.isspace())
    lines = text.count("\n") + 1 if text else 0
    return characters, utf8_bytes, non_whitespace, lines


def _decompress_zstd_stream(data: bytes) -> bytes:
    """Decompress a concatenated-frame zstd stream (dsh append-only log)."""
    import zstandard
    dctx = zstandard.ZstdDecompressor()
    try:
        return dctx.decompress(data)
    except zstandard.ZstdError:
        reader = dctx.stream_reader(io.BytesIO(data), read_across_frames=True)
        out = io.BytesIO()
        while True:
            chunk = reader.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
        return out.getvalue()


def _session_records(path: Path) -> list[dict[str, Any]]:
    try:
        raw = _decompress_zstd_stream(path.read_bytes())
    except Exception:
        return []
    records: list[dict[str, Any]] = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def _user_text(event: dict[str, Any]) -> tuple[str, str]:
    """Extract (text, source-kind) from a user/message event."""
    data = event.get("data") or {}
    if not isinstance(data, dict):
        return "", ""
    source = data.get("source") or {}
    kind = source.get("kind") if isinstance(source, dict) else ""
    content = data.get("content")
    parts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
    elif isinstance(content, str):
        parts.append(content)
    return "\n".join(parts), kind or ""


def _scan_sessions() -> list[dict[str, Any]]:
    sessions: list[dict[str, Any]] = []
    for root in _scan_roots():
        if not root.is_dir():
            continue
        for log_path in sorted(root.rglob("session.jsonl.zstd")):
            records = _session_records(log_path)
            header: dict[str, Any] = {}
            title = ""
            cwd = ""
            inputs: list[tuple[int, str]] = []
            for record in records:
                rtype = record.get("type")
                if rtype == "session":
                    header = record
                    cwd = str(header.get("cwd") or "")
                    header_title = header.get("title")
                    if isinstance(header_title, str) and header_title.strip():
                        title = header_title.strip()
                    continue
                if rtype == "session/title":
                    data = record.get("data") or {}
                    value = data.get("title") if isinstance(data, dict) else None
                    if isinstance(value, str) and value.strip():
                        title = value.strip()
                    continue
                if rtype == "user/message":
                    text, kind = _user_text(record)
                    # CRITICAL：只统计真实用户输入（source.kind=='user'）。
                    # plugin / skill-catalog / goal / coordinator / subagent-settled /
                    # subagent-report / agent-instructions 等注入上下文一律不计入。
                    if kind != "user":
                        continue
                    if not text.strip():
                        continue
                    inputs.append((int(record.get("time") or 0), text))
                    continue
            if not inputs:
                continue
            sessions.append({
                "session_id": str(header.get("id") or log_path.parent.name),
                "title": title,
                "cwd": cwd,
                "inputs": sorted(inputs),
            })
    return sessions


def _database_key() -> Optional[tuple[Any, ...]]:
    roots = tuple(sorted(str(r) for r in _scan_roots()))
    newest: Optional[tuple[int, int]] = None
    for root in _scan_roots():
        if not root.is_dir():
            continue
        for path in root.rglob("session.jsonl.zstd"):
            try:
                stat = path.stat()
            except OSError:
                continue
            key = (stat.st_mtime_ns, stat.st_size)
            if newest is None or key > newest:
                newest = key
    return (roots, newest)


_USAGE_CACHE_LOCK = threading.Lock()
_USAGE_CACHE_AT = 0.0
_USAGE_CACHE_KEY: Optional[tuple[Any, ...]] = None
_USAGE_CACHE_VALUE: Optional[dict[str, Any]] = None


def _local_datetime(epoch_ms: int) -> datetime:
    return datetime.fromtimestamp(epoch_ms / 1000).astimezone()


def _metric_note() -> str:
    return (
        "只统计 dsh 会话日志中 type=user/message 且 source.kind=user 的事件（真实对话输入）；"
        "assistant 回复、reasoning、tool/call、tool/result、session/title、request/context、"
        "steering 与 subagent 注入（subagent-settled / subagent-report / plugin / skill-catalog / "
        "goal / coordinator / agent-instructions）一律不计入。"
        f"只忽略累计输入字符数不超过 {MIN_SESSION_CHARACTERS} 的会话；任何输入次数的会话都计入。"
        "字符按 Unicode code point，字节按 UTF-8。"
    )


def aggregate_usage(force: bool = False) -> dict[str, Any]:
    global _USAGE_CACHE_AT, _USAGE_CACHE_KEY, _USAGE_CACHE_VALUE
    key = _database_key()
    now = time.monotonic()
    with _USAGE_CACHE_LOCK:
        if not force and _USAGE_CACHE_VALUE is not None and key == _USAGE_CACHE_KEY and now - _USAGE_CACHE_AT < USAGE_CACHE_SECONDS:
            return _USAGE_CACHE_VALUE
        value = _aggregate_uncached()
        _USAGE_CACHE_KEY = key
        _USAGE_CACHE_AT = now
        _USAGE_CACHE_VALUE = value
        return value


def _aggregate_uncached() -> dict[str, Any]:
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    metric_note = _metric_note()
    sources = ", ".join(str(r) for r in _scan_roots()) or "(no dsh_home registered)"
    empty = {
        "generated_at": generated_at,
        "local_date": datetime.now().astimezone().date().isoformat(),
        "timezone": datetime.now().astimezone().tzname(),
        "source": sources,
        "minimum_session_characters_exclusive": MIN_SESSION_CHARACTERS,
        "minimum_session_prompts_exclusive": MIN_SESSION_PROMPTS_EXCLUSIVE,
        "metric_note": metric_note,
        "summary": {"prompts": 0, "characters": 0, "utf8_bytes": 0, "non_whitespace": 0, "lines": 0, "sessions": 0, "days": 0, "excluded_sessions": 0},
        "days": [],
        "sessions": [],
    }

    raw_sessions = _scan_sessions()
    if not raw_sessions:
        return empty

    excluded = 0
    sessions: dict[str, dict[str, Any]] = {}
    days: dict[str, dict[str, Any]] = {}
    day_sessions: dict[tuple[str, str], dict[str, Any]] = {}
    totals = {"prompts": 0, "characters": 0, "utf8_bytes": 0, "non_whitespace": 0, "lines": 0}

    for raw in raw_sessions:
        session_id = raw["session_id"]
        inputs = raw["inputs"]
        total_chars = sum(len(text) for _, text in inputs)
        if total_chars <= MIN_SESSION_CHARACTERS or len(inputs) <= MIN_SESSION_PROMPTS_EXCLUSIVE:
            excluded += 1
            continue

        first_time, first_text = inputs[0]
        last_time, last_text = inputs[-1]
        first_at = _local_datetime(first_time)
        last_at = _local_datetime(last_time)
        preview = " ".join(last_text.split())[:120]
        title = raw["title"] or " ".join(first_text.split())[:40] or "未命名会话"

        session = sessions.setdefault(session_id, {
            "session_id": session_id,
            "title": title,
            "cwd": raw["cwd"],
            "first_input_at": first_at.isoformat(timespec="seconds"),
            "last_input_at": last_at.isoformat(timespec="seconds"),
            "first_preview": " ".join(first_text.split())[:120],
            "last_preview": preview,
            "prompts": 0,
            "characters": 0,
            "utf8_bytes": 0,
            "non_whitespace": 0,
            "lines": 0,
            "active_days": set(),
        })

        day = last_at.date().isoformat()
        day_row = days.setdefault(day, {
            "date": day, "prompts": 0, "characters": 0, "utf8_bytes": 0, "non_whitespace": 0, "lines": 0, "session_ids": set(),
        })
        day_session = day_sessions.setdefault((day, session_id), {
            "session_id": session_id,
            "title": title,
            "cwd": raw["cwd"],
            "prompts": 0, "characters": 0, "utf8_bytes": 0, "non_whitespace": 0, "lines": 0,
            "last_preview": preview,
        })

        for _, text in inputs:
            characters, utf8_bytes, non_whitespace, lines = _character_metrics(text)
            metric = {"prompts": 1, "characters": characters, "utf8_bytes": utf8_bytes, "non_whitespace": non_whitespace, "lines": lines}
            for name, amount in metric.items():
                totals[name] += amount
                session[name] += amount
                day_row[name] += amount
                day_session[name] += amount
            session["active_days"].add(day)
            day_row["session_ids"].add(session_id)
        session["last_input_at"] = last_at.isoformat(timespec="seconds")
        session["last_preview"] = preview

    session_values: list[dict[str, Any]] = []
    for session in sessions.values():
        session["active_days"] = len(session["active_days"])
        session_values.append(session)
    session_values.sort(key=lambda item: (item["last_input_at"], item["characters"]), reverse=True)

    day_values: list[dict[str, Any]] = []
    for day, day_row in days.items():
        day_row["sessions"] = len(day_row.pop("session_ids"))
        day_row["session_breakdown"] = sorted(
            (value for (value_day, _), value in day_sessions.items() if value_day == day),
            key=lambda item: (item["characters"], item["prompts"]),
            reverse=True,
        )
        day_values.append(day_row)
    day_values.sort(key=lambda item: item["date"], reverse=True)

    return {
        "generated_at": generated_at,
        "local_date": datetime.now().astimezone().date().isoformat(),
        "timezone": datetime.now().astimezone().tzname(),
        "source": sources,
        "minimum_session_characters_exclusive": MIN_SESSION_CHARACTERS,
        "minimum_session_prompts_exclusive": MIN_SESSION_PROMPTS_EXCLUSIVE,
        "metric_note": metric_note,
        "summary": {**totals, "sessions": len(session_values), "days": len(day_values), "excluded_sessions": excluded},
        "days": day_values,
        "sessions": session_values,
    }


def session_usage(session_id: str) -> dict[str, Any]:
    usage = _usage_map().get(session_id)
    if usage:
        out = dict(usage)
    else:
        out = {
            "session_id": session_id,
            "title": derive_title(session_id, (get_session(session_id) or {}).get("title")),
            "cwd": (get_session(session_id) or {}).get("workspace") or "",
            "characters": 0, "prompts": 0, "active_days": 0,
            "utf8_bytes": 0, "non_whitespace": 0, "lines": 0,
        }
    out["note"] = "subagent 注入不计入"
    return out


# ============================================================ cluster poller ==

def resolve_kubectl() -> Optional[str]:
    home_bin = Path.home() / "bin" / "kubectl"
    if home_bin.is_file():
        return str(home_bin)
    return shutil.which("kubectl")


def load_config() -> dict[str, Any]:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return json.loads(json.dumps(DEFAULT_CONFIG))


def build_sources() -> list[dict[str, Any]]:
    config = load_config()
    sources: list[dict[str, Any]] = []
    for host in config.get("ssh_hosts", []):
        sources.append({"id": f"ssh:{host['name']}", "kind": "ssh", "name": host["name"],
                        "enabled": bool(host.get("enabled", True)), "note": host.get("note", "")})
    for cluster in config.get("k8s_clusters", []):
        sources.append({"id": f"k8s:{cluster['name']}", "kind": "k8s", "name": cluster["name"],
                        "enabled": bool(cluster.get("enabled", True)), "note": cluster.get("note", "")})
    return sources


def kubeconfig_context(name: str) -> tuple[Path, str]:
    if KUBECONFIG_CACHE.exists() and KUBECONFIG_META.exists():
        try:
            meta = json.loads(KUBECONFIG_META.read_text(encoding="utf-8"))
            context = (meta.get("clusters") or {}).get(name)
            if context:
                return KUBECONFIG_CACHE, context
        except (OSError, json.JSONDecodeError):
            pass
    if KUBECONFIG_FALLBACK.exists():
        return KUBECONFIG_FALLBACK, name
    raise RuntimeError("kubeconfig not found (cached state/kubeconfig.yaml or ~/.kube/config)")


def parse_quantity(value: str) -> float:
    if not value:
        return 0.0
    value = str(value)
    suffixes = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40,
                "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "m": 1e-3}
    for suffix, factor in suffixes.items():
        if value.endswith(suffix):
            try:
                return float(value[:-len(suffix)]) * factor
            except ValueError:
                return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


_NODE_CAP_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def node_capacities(name: str, kubeconfig: Path, context: str) -> dict[str, Any]:
    cached = _NODE_CAP_CACHE.get(name)
    if cached and time.monotonic() - cached[0] < NODE_CAP_TTL:
        return cached[1]
    kubectl = resolve_kubectl()
    if not kubectl:
        return {}
    command = [
        kubectl, "--kubeconfig", str(kubeconfig), "--context", context,
        "get", "nodes", "-o",
        r"custom-columns=NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu,CPU:.status.allocatable.cpu",
        "--no-headers", f"--request-timeout={KUBECTL_TIMEOUT - 5}s",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=KUBECTL_TIMEOUT)
        if result.returncode != 0:
            return cached[1] if cached else {}
        caps: dict[str, Any] = {}
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if len(parts) >= 3:
                caps[parts[0]] = {
                    "gpu": 0 if parts[1] == "<none>" else int(parts[1]),
                    "cpu": parse_quantity(parts[2]),
                }
        _NODE_CAP_CACHE[name] = (time.monotonic(), caps)
        return caps
    except Exception:
        return cached[1] if cached else {}


def poll_k8s(name: str) -> dict[str, Any]:
    kubectl = resolve_kubectl()
    if not kubectl:
        raise RuntimeError("kubectl binary not found")
    kubeconfig, context = kubeconfig_context(name)
    command = [
        kubectl, "--kubeconfig", str(kubeconfig), "--context", context,
        "get", "pods", "-o", "json",
        "--field-selector=status.phase!=Succeeded,status.phase!=Failed",
        f"--request-timeout={KUBECTL_TIMEOUT - 5}s",
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=KUBECTL_TIMEOUT)
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip().splitlines()
        detail = message[-1][:300] if message else f"kubectl exited {result.returncode}"
        if "Unauthorized" in detail or "expired" in detail:
            detail += " — kubeconfig 可能过期"
        raise RuntimeError(detail)
    data = json.loads(result.stdout)
    pods = []
    for item in data.get("items", []):
        spec = item.get("spec", {})
        status = item.get("status", {})
        cpu = mem = gpu = 0.0
        for container in spec.get("containers", []):
            resources = container.get("resources", {})
            req = resources.get("requests") or resources.get("limits") or {}
            cpu += parse_quantity(req.get("cpu", "0"))
            mem += parse_quantity(req.get("memory", "0"))
            gpu += parse_quantity(req.get("nvidia.com/gpu", "0"))
        restarts = sum(cs.get("restartCount", 0) for cs in status.get("containerStatuses", []))
        pods.append({
            "name": item.get("metadata", {}).get("name", "?"),
            "phase": status.get("phase", "?"),
            "node": spec.get("nodeName") or "-",
            "cpu": round(cpu, 2),
            "mem_gib": round(mem / 2**30, 1),
            "gpu": int(gpu),
            "restarts": restarts,
            "started": status.get("startTime") or "",
        })
    pods.sort(key=lambda p: (p["node"], -p["gpu"], -p["cpu"], p["name"]))
    namespace = data["items"][0]["metadata"]["namespace"] if data.get("items") else "mc-bochao-li"
    caps = node_capacities(name, kubeconfig, context)
    nodes: dict[str, dict[str, Any]] = {}
    for pod in pods:
        entry = nodes.setdefault(pod["node"], {"gpu_used": 0, "cpu_used": 0.0, "pods": 0, "running": 0})
        entry["pods"] += 1
        if pod["phase"] == "Running":
            entry["running"] += 1
            entry["gpu_used"] += pod["gpu"]
            entry["cpu_used"] = round(entry["cpu_used"] + pod["cpu"], 1)
    for node_name, entry in nodes.items():
        cap = caps.get(node_name, {})
        entry["gpu_cap"] = cap.get("gpu")
        entry["cpu_cap"] = cap.get("cpu")
    return {
        "namespace": namespace,
        "pods": pods,
        "nodes": nodes,
        "totals": {
            "running": sum(1 for p in pods if p["phase"] == "Running"),
            "pending": sum(1 for p in pods if p["phase"] == "Pending"),
            "cpu": round(sum(p["cpu"] for p in pods if p["phase"] == "Running"), 1),
            "mem_gib": round(sum(p["mem_gib"] for p in pods if p["phase"] == "Running"), 1),
            "gpu": sum(p["gpu"] for p in pods if p["phase"] == "Running"),
        },
        "bytes": len(result.stdout),
    }


def poll_ssh(name: str) -> dict[str, Any]:
    result = subprocess.run(
        ["ssh", *SSH_OPTS, name, SSH_PROBE],
        capture_output=True, text=True, timeout=SSH_TIMEOUT,
    )
    if result.returncode != 0 and not result.stdout.strip():
        message = result.stderr.strip().splitlines()
        raise RuntimeError(message[-1][:300] if message else f"ssh exited {result.returncode}")
    sections = result.stdout.split("@@")
    uptime_line = sections[0].strip() if sections else ""
    load = ""
    match = re.search(r"load averages?: (.+)$", uptime_line)
    if match:
        load = match.group(1).strip()
    cpu_count = 0
    if len(sections) > 1:
        try:
            cpu_count = int(sections[1].strip().splitlines()[0])
        except (ValueError, IndexError):
            pass
    mem_total = mem_used = 0
    if len(sections) > 2 and sections[2].strip():
        parts = sections[2].split()
        if len(parts) >= 2:
            try:
                mem_total, mem_used = int(parts[0]), int(parts[1])
            except ValueError:
                pass
    processes = []
    if len(sections) > 3:
        for line in sections[3].strip().splitlines()[1:]:
            fields = line.split(None, 5)
            if len(fields) < 6:
                continue
            try:
                pcpu, pmem = float(fields[2]), float(fields[3])
            except ValueError:
                continue
            if pcpu < 0.5 and pmem < 1.0:
                continue
            processes.append({
                "pid": fields[0], "user": fields[1], "cpu": pcpu,
                "mem": pmem, "etime": fields[4], "cmd": fields[5][:160],
            })
    gpus = []
    if len(sections) > 4:
        for line in sections[4].strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 4:
                gpus.append({"index": parts[0], "util": parts[1], "mem_used": parts[2], "mem_total": parts[3]})
    return {
        "uptime": uptime_line,
        "load": load,
        "cpu_count": cpu_count,
        "mem_total_mib": mem_total,
        "mem_used_mib": mem_used,
        "processes": processes,
        "gpus": gpus,
        "bytes": len(result.stdout),
    }


def poll_source(source: dict[str, Any]) -> None:
    source_id = source["id"]
    try:
        if source["kind"] == "k8s":
            payload = {"k8s": poll_k8s(source["name"])}
        else:
            payload = {"ssh": {"hosts": {source["name"]: poll_ssh(source["name"])}}}
        payload["collected_at"] = utc_now()
        upsert_snapshot(source_id, payload, "online", last_ok_at=utc_now(), last_error="")
    except Exception as exc:
        sys.stderr.write(f"[service-hub] poll {source_id} failed: {exc}\n")
        record_snapshot_failure(source_id, str(exc)[:300])


def poll_loop(stop_event: threading.Event) -> None:
    while not stop_event.wait(POLL_INTERVAL):
        try:
            for source in build_sources():
                if stop_event.is_set():
                    return
                if not source.get("enabled"):
                    continue
                poll_source(source)
        except Exception as exc:
            sys.stderr.write(f"[service-hub] poll loop error: {exc}\n")
            time.sleep(5)


# ======================================================== matching (pods) ===

def compile_task_regex(task: dict[str, Any]) -> Optional[re.Pattern]:
    try:
        return re.compile(task["pattern"])
    except re.error:
        return None


def compute_session_pod_matches(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    snapshots = list_snapshots()
    for task in tasks:
        source_id = f"{task['kind']}:{task['target']}"
        payload = (snapshots.get(source_id) or {}).get("payload", {})
        matches: list[dict[str, Any]] = []
        regex = compile_task_regex(task)
        if regex is not None:
            if task["kind"] == "k8s":
                for pod in (payload.get("k8s") or {}).get("pods", []):
                    if regex.search(pod.get("name", "")):
                        matches.append({
                            "name": pod.get("name", "?"),
                            "phase": pod.get("phase", "?"),
                            "gpu": pod.get("gpu", 0),
                            "cpu": pod.get("cpu", 0),
                            "node": pod.get("node", "-"),
                            "restarts": pod.get("restarts", 0),
                            "started": pod.get("started", ""),
                        })
            else:
                host_payload = (payload.get("ssh") or {}).get("hosts", {}).get(task["target"], {})
                for proc in host_payload.get("processes", []):
                    if regex.search(proc.get("cmd", "")):
                        matches.append({
                            "name": f"pid {proc['pid']} {proc['cmd'][:60]}",
                            "phase": "Running",
                            "gpu": 0,
                            "cpu": proc.get("cpu", 0),
                            "node": task["target"],
                            "restarts": 0,
                            "started": "",
                        })
        task["matches"] = matches
    return tasks


def cluster_view() -> dict[str, Any]:
    """集群维度总览：每个 k8s 集群的 pod/节点/总量快照 + 每个 SSH 主机的负载快照，
    并把已登记任务的 regex 匹配结果标注在 pod/进程上（跨会话视角）。"""
    snapshots = list_snapshots()
    k8s_clusters: dict[str, dict[str, Any]] = {}
    ssh_hosts: dict[str, dict[str, Any]] = {}
    for source_id, snap in snapshots.items():
        kind, _, name = source_id.partition(":")
        payload = snap.get("payload") or {}
        meta = {
            "status": snap.get("status") or "unknown",
            "last_ok_at": snap.get("last_ok_at"),
            "last_error": snap.get("last_error") or "",
        }
        if kind == "k8s":
            k8s_clusters[name] = {**meta, **(payload.get("k8s") or {})}
        elif kind == "ssh":
            for host, data in ((payload.get("ssh") or {}).get("hosts") or {}).items():
                ssh_hosts[host] = {**meta, **data}

    tasks_by_source: dict[str, list[dict[str, Any]]] = {}
    for task in list_tasks():
        regex = compile_task_regex(task)
        if regex is None:
            continue
        source_key = f"{task['kind']}:{task['target']}"
        tasks_by_source.setdefault(source_key, []).append({
            "title": task["title"], "id": task["id"], "session_id": task["session_id"], "regex": regex,
        })

    def annotate(scope: str, rows: list[dict[str, Any]], field: str) -> None:
        entries = tasks_by_source.get(f"{scope}", [])
        for row in rows:
            matched = []
            for entry in entries:
                if entry["regex"].search(str(row.get(field, ""))):
                    matched.append({"task_id": entry["id"], "title": entry["title"], "session_id": entry["session_id"]})
            if matched:
                row["matched_tasks"] = matched

    for name, cluster in k8s_clusters.items():
        annotate(f"k8s:{name}", cluster.get("pods", []), "name")
        cluster["_task_count"] = len(tasks_by_source.get(f"k8s:{name}", []))
    for host, data in ssh_hosts.items():
        annotate(f"ssh:{host}", data.get("processes", []), "cmd")
        data["_task_count"] = len(tasks_by_source.get(f"ssh:{host}", []))

    return {
        "k8s": [{"name": name, **cluster} for name, cluster in sorted(k8s_clusters.items())],
        "ssh": [{"name": host, **data} for host, data in sorted(ssh_hosts.items())],
    }


# ================================================================== HTML ===

CLUSTERS_HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>集群总览 · DSH 服务台 v2</title>
<style>
:root{color-scheme:dark;--bg:#09111f;--panel:#101b2d;--panel2:#0c1728;--line:#263750;--text:#e8eef8;--muted:#91a3bb;--cyan:#4fd1c5;--green:#55d98b;--amber:#f2bd5a;--red:#ff7185;--blue:#6ea8fe}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f5f7fb;--panel:#ffffff;--panel2:#eef2f8;--line:#d8e0ec;--text:#17233a;--muted:#64748b;--cyan:#0f9f95;--green:#189a4a;--amber:#b57a10;--red:#d4374c;--blue:#3b72d6}}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#183052 0,transparent 38%),var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
main{max-width:1440px;margin:auto;padding:38px 26px 64px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-bottom:22px}h1{font-size:32px;letter-spacing:-.8px;margin:0}.subtitle{color:var(--muted);margin:8px 0 0}.hub{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--cyan);background:var(--panel2);border:1px solid var(--line);padding:8px 12px;border-radius:10px}
.toolbar{display:flex;gap:12px;align-items:center;margin:18px 0}.toolbar a{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:9px 13px;cursor:pointer;text-decoration:none;font-weight:650}
.card{background:linear-gradient(155deg,rgba(20,34,55,.98),rgba(12,23,39,.98));border:1px solid var(--line);border-radius:15px;padding:17px;margin:10px 0}
@media (prefers-color-scheme:light){.card{background:linear-gradient(155deg,#fff,#f7f9fc)}}
h2{font-size:18px;color:var(--cyan);margin:26px 0 10px}.cluster-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.totals{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}.total{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px 14px;font-family:ui-monospace,Menlo,monospace}.total b{font-size:17px}.total span{display:block;color:var(--muted);font:10px ui-sans-serif;text-transform:uppercase;letter-spacing:.08em}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px}.dot.online{background:var(--green)}.dot.unreachable{background:var(--red)}.dot.unknown{background:var(--amber)}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}th{color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.08em}td{font-family:ui-monospace,Menlo,monospace}
.pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11px;background:var(--panel2);border:1px solid var(--line);margin:1px 2px}.pill.run{color:var(--green);border-color:var(--green)}.pill.miss{color:var(--amber)}.pill.task{color:var(--blue);border-color:var(--blue)}
.empty{padding:40px 20px;text-align:center;border:1px dashed var(--line);border-radius:16px;color:var(--muted)}.err{color:var(--red);font-size:11px}.foot{color:var(--muted);text-align:center;margin-top:30px;font-size:12px}
.pod-row{cursor:default}.node-cap{color:var(--muted)}
@media(max-width:820px){.top{align-items:flex-start;flex-direction:column}.totals{gap:6px}}
</style>
</head>
<body><main>
<section class="top"><div><h1>集群总览</h1><p class="subtitle">集群维度的资源 / Pod / 主机占用快照（每 120s 后台轮询；页面每 8s 刷新）</p></div><div><a class="toolbar" href="/">会话与任务</a> <a class="toolbar" href="/usage">对话输入统计</a> <span class="hub" id="hubAddr">http://127.0.0.1:6692</span></div></section>
<div id="content"><div class="empty">正在读取集群快照…</div></div>
<div class="foot">只访问 127.0.0.1 · 远程采集在服务台后台线程进行 · 不可达来源如实显示</div>
</main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>{if(!v)return'—';try{return new Date(v).toLocaleString()}catch{return v}};
const num=(n,d=1)=>{const x=Number(n||0);return x>=1000?Math.round(x):x.toFixed(d)};
function statusDot(s){const cls=s==='online'?'online':(s==='unreachable'?'unreachable':'unknown');return `<span class="dot ${cls}"></span>`}
function matchedPills(m){return (m||[]).map(x=>`<a class="pill task" href="/?session=${encodeURIComponent(x.session_id||'')}" title="会话 ${esc(x.session_id)}">${esc(x.title)}</a>`).join('')}
function renderK8s(cluster){
 const t=cluster.totals||{};const nodes=cluster.nodes||{};const pods=cluster.pods||[];
 const nodeRows=Object.keys(nodes).map(n=>{const e=nodes[n];return `<tr><td>${esc(n)}</td><td>${e.running}/${e.pods}</td><td>${e.gpu_used}${e.gpu_cap!=null?'<span class="node-cap"> / '+e.gpu_cap+'</span>':''}</td><td>${num(e.cpu_used)}${e.cpu_cap!=null?'<span class="node-cap"> / '+num(e.cpu_cap)+'</span>':''}</td></tr>`}).join('');
 const podRows=pods.map(p=>`<tr class="pod-row"><td>${esc(p.name)}</td><td>${esc(p.node)}</td><td>${esc(p.phase)}</td><td>${p.gpu||0}</td><td>${num(p.cpu)}</td><td>${p.mem_gib||0}</td><td>${p.restarts||0}</td><td>${esc(p.started||'')}</td><td>${matchedPills(p.matched_tasks)||'<span class="pill miss">未登记</span>'}</td></tr>`).join('');
 const err=cluster.status==='unreachable'?`<div class="err">不可达：${esc(cluster.last_error||'')}</div>`:'';
 return `<section class="card"><div class="cluster-head"><h2 style="margin:0">${statusDot(cluster.status)}K8s · ${esc(cluster.name)}</h2><span style="color:var(--muted);font-size:12px">快照 ${esc(time(cluster.last_ok_at))} · 已登记任务 ${cluster._task_count||0}</span></div>${err}
 <div class="totals"><div class="total"><b>${t.running??0}</b><span>Running</span></div><div class="total"><b>${t.pending??0}</b><span>Pending</span></div><div class="total"><b>${t.gpu??0}</b><span>GPU 占用</span></div><div class="total"><b>${num(t.cpu||0)}</b><span>CPU 核</span></div><div class="total"><b>${num(t.mem_gib||0)}</b><span>内存 GiB</span></div></div>
 <table><tr><th>节点</th><th>Pod (running/总)</th><th>GPU 占用/上限</th><th>CPU 占用/上限</th></tr>${nodeRows||'<tr><td colspan="4" class="empty">无节点数据</td></tr>'}</table>
 <table><tr><th>Pod</th><th>节点</th><th>Phase</th><th>GPU</th><th>CPU</th><th>Mem(GiB)</th><th>重启</th><th>启动时间</th><th>登记任务（点击跳会话）</th></tr>${podRows||'<tr><td colspan="9" class="empty">无 Pod 数据</td></tr>'}</table></section>`;
}
function renderSsh(host){
 const procs=(host.processes||[]).map(p=>`<tr><td>${esc(p.pid)}</td><td>${esc(p.user)}</td><td>${p.cpu}</td><td>${p.mem}</td><td>${esc(p.etime)}</td><td>${esc(p.cmd)}</td><td>${matchedPills(p.matched_tasks)||''}</td></tr>`).join('');
 const gpus=(host.gpus||[]).map(g=>`<span class="pill">GPU${esc(g.index)} ${esc(g.util)} · ${esc(g.mem_used)}/${esc(g.mem_total)}</span>`).join('');
 const memPct=host.mem_total_mib?Math.round(100*host.mem_used_mib/host.mem_total_mib):0;
 const err=host.status==='unreachable'?`<div class="err">不可达：${esc(host.last_error||'')}</div>`:'';
 return `<section class="card"><div class="cluster-head"><h2 style="margin:0">${statusDot(host.status)}SSH · ${esc(host.name)}</h2><span style="color:var(--muted);font-size:12px">快照 ${esc(time(host.last_ok_at))} · 已登记任务 ${host._task_count||0}</span></div>${err}
 <div class="totals"><div class="total"><b>${esc(host.load||'—')}</b><span>Load</span></div><div class="total"><b>${host.cpu_count||0}</b><span>CPU 数</span></div><div class="total"><b>${memPct}%</b><span>内存 ${num(host.mem_used_mib||0,0)}/${num(host.mem_total_mib||0,0)} MiB</span></div><div class="total"><span style="display:inline">GPU</span> ${gpus||'—'}</div></div>
 <table><tr><th>PID</th><th>用户</th><th>CPU%</th><th>MEM%</th><th>运行时长</th><th>命令</th><th>登记任务</th></tr>${procs||'<tr><td colspan="7" class="empty">无活跃进程</td></tr>'}</table></section>`;
}
async function load(){try{const r=await fetch('/api/clusters');if(!r.ok)throw new Error(r.statusText);const data=await r.json();const k=(data.k8s||[]).map(renderK8s).join('');const s=(data.ssh||[]).map(renderSsh).join('');document.getElementById('content').innerHTML=`<h2>Kubernetes 集群</h2>${k||'<div class="empty">暂无 k8s 来源</div>'}<h2>SSH 主机</h2>${s||'<div class="empty">暂无 ssh 来源</div>'}`}catch(e){document.getElementById('content').innerHTML=`<div class="empty">读取失败：${esc(e)}</div>`}}
document.getElementById('hubAddr').textContent=location.origin||'http://127.0.0.1:6692';
load();setInterval(load,8000);
</script></body></html>'''

DASHBOARD_HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 服务台 v2</title>
<style>
:root{color-scheme:dark;--bg:#09111f;--panel:#101b2d;--panel2:#0c1728;--line:#263750;--text:#e8eef8;--muted:#91a3bb;--cyan:#4fd1c5;--green:#55d98b;--amber:#f2bd5a;--red:#ff7185;--blue:#6ea8fe}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f5f7fb;--panel:#ffffff;--panel2:#eef2f8;--line:#d8e0ec;--text:#17233a;--muted:#64748b;--cyan:#0f9f95;--green:#189a4a;--amber:#b57a10;--red:#d4374c;--blue:#3b72d6}}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#183052 0,transparent 38%),var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
main{max-width:1280px;margin:auto;padding:38px 26px 64px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-bottom:22px}h1{font-size:32px;letter-spacing:-.8px;margin:0}.subtitle{color:var(--muted);margin:8px 0 0}.hub{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--cyan);background:var(--panel2);border:1px solid var(--line);padding:8px 12px;border-radius:10px}
.toolbar{display:flex;gap:12px;align-items:center;margin:18px 0}.toolbar select,.toolbar input{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;outline:none}.toolbar input{flex:1}.toolbar a,.toolbar button{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:9px 13px;cursor:pointer;text-decoration:none;font-weight:650}
.card{background:linear-gradient(155deg,rgba(20,34,55,.98),rgba(12,23,39,.98));border:1px solid var(--line);border-radius:15px;padding:17px;margin:10px 0;box-shadow:0 18px 45px rgba(0,0,0,.12)}
@media (prefers-color-scheme:light){.card{background:linear-gradient(155deg,#fff,#f7f9fc)}}
h2{font-size:16px;color:var(--cyan);margin:26px 0 10px}.ins-group{margin:22px 0}.ins-name{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:18px 0 8px}
.row{display:grid;grid-template-columns:minmax(220px,1.6fr) minmax(200px,1fr) repeat(3,minmax(70px,.5fr)) 90px;gap:10px;align-items:center;padding:13px 15px;border:1px solid var(--line);border-radius:12px;margin:8px 0;background:rgba(16,27,45,.7);cursor:pointer}
@media (prefers-color-scheme:light){.row{background:#fff}}
.row:hover{border-color:var(--blue)}
.s-title{font-weight:700}.s-sub{color:var(--muted);font:11px ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.num{font-family:ui-monospace,Menlo,monospace;text-align:right}.lbl{display:block;color:var(--muted);font:10px ui-sans-serif;text-transform:uppercase;letter-spacing:.08em}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px}.dot.online{background:var(--green);box-shadow:0 0 0 3px rgba(85,217,139,.15)}.dot.offline{background:var(--red)}.dot.standby{background:var(--amber)}.dot.starting{background:var(--blue)}.dot.error{background:var(--red)}
.empty{padding:60px 20px;text-align:center;border:1px dashed var(--line);border-radius:16px;color:var(--muted)}a{color:var(--blue)}.footer{color:var(--muted);text-align:center;margin-top:30px;font-size:12px}.back{margin:12px 0}.pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11px;background:var(--panel2);border:1px solid var(--line);margin:1px 2px}.pill.run{color:var(--green)}.pill.miss{color:var(--amber)}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.08em}td{font-family:ui-monospace,Menlo,monospace}
@media(max-width:820px){.row{grid-template-columns:1fr 1fr}.top{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body><main>
<section class="top"><div><h1>DSH 服务台 v2</h1><p class="subtitle">本机页面 / 会话 / 集群任务 / 输入统计（按实例聚合）</p></div><div><a class="toolbar" href="/clusters">集群总览</a> <a class="toolbar" href="/usage">对话输入统计</a> <span class="hub" id="hubAddr">http://127.0.0.1:6692</span></div></section>
<section class="toolbar"><select id="instanceFilter"><option value="all">全部实例</option></select><a href="/" onclick="return clearSession(event)">← 返回会话列表</a></section>
<div id="content"></div>
<div class="footer">数据保存在本机；页面每 8 秒自动刷新 · 集群任务匹配来自后台每 120s 的轮询快照</div>
</main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params=new URLSearchParams(location.search);
let INSTANCES=[],SESSIONS=[];let selInstance=params.get('instance')||'all';let selSession=params.get('session')||'';
const time=v=>{if(!v)return'—';try{return new Date(v).toLocaleString()}catch{return v}};
function setSelSession(id){selSession=id;if(id){const u=new URL(location.href);u.searchParams.set('session',id);history.replaceState(null,'',u)}else{const u=new URL(location.href);u.searchParams.delete('session');history.replaceState(null,'',u)}render()}
function clearSession(e){setSelSession('');return false}
async function load(){try{const[inst,sess]=await Promise.all([fetch('/api/instances').then(r=>r.json()),fetch('/api/sessions').then(r=>r.json())]);INSTANCES=inst;SESSIONS=sess;renderFilter();render()}catch(e){document.getElementById('content').innerHTML=`<div class="empty">无法读取服务台数据：${esc(e)}</div>`}}
function renderFilter(){const sel=document.getElementById('instanceFilter');const cur=sel.value||selInstance;sel.innerHTML='<option value="all">全部实例</option>'+INSTANCES.map(i=>`<option value="${esc(i.instance_id)}">${esc(i.name||i.instance_id)}</option>`).join('');sel.value=cur}
function render(){if(selSession){renderDetail(selSession)}else{renderList()}}
function statsLine(s){return `<span class="num"><span class="lbl">字符</span>${fmt(s.characters)}</span><span class="num"><span class="lbl">输入</span>${fmt(s.prompts)}</span><span class="num"><span class="lbl">活跃天</span>${fmt(s.active_days)}</span>`}
const fmt=n=>{if(n==null)return 0;if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n}
function renderList(){let rows=SESSIONS;if(selInstance!=='all')rows=rows.filter(s=>s.instance_id===selInstance);
 const byInst={};rows.forEach(s=>{(byInst[s.instance_id??'?']??=[]).push(s)});
 if(!rows.length){document.getElementById('content').innerHTML='<div class="empty">还没有登记的会话。启动 dsh 实例后会自动出现。</div>';return}
 const html=Object.keys(byInst).map(instId=>{const name=(INSTANCES.find(i=>i.instance_id===instId)||{}).name||instId;return `<div class="ins-group"><div class="ins-name">${esc(name)} · ${esc(instId)}</div>${byInst[instId].map(s=>`<div class="row" onclick="setSelSession('${esc(s.session_id)}')"><div><div class="s-title">${esc(s.title||'未命名会话')}</div><span class="s-sub">${esc(s.session_id)}</span></div><div><span class="s-sub" title="${esc(s.workspace||'')}">${esc(s.workspace||'—')}</span><br><span class="s-sub">${esc(time(s.first_seen_at))} → ${esc(time(s.last_seen_at))}</span></div>${statsLine(s)}<span class="num"><span class="lbl">页面</span>${s.pages||0}</span><span class="num"><span class="lbl">任务</span>${s.tasks||0}</span></div>`).join('')}</div>`}).join('');
 document.getElementById('content').innerHTML=html}
async function renderDetail(sid){const s=SESSIONS.find(x=>x.session_id===sid);
 document.getElementById('content').innerHTML='<div class="empty">正在加载会话详情…</div>';
 try{const[pages,pods]=await Promise.all([fetch(`/api/sessions/${encodeURIComponent(sid)}/pages`).then(r=>r.json()),fetch(`/api/sessions/${encodeURIComponent(sid)}/pods`).then(r=>r.json())]);
  const stat=s?`<div class="card">输入统计：<b>${fmt(s.characters)}</b> 字符 · <b>${fmt(s.prompts)}</b> 条输入 · <b>${fmt(s.active_days)}</b> 活跃天 <span class="pill miss">subagent 注入不计入</span></div>`:'';
  const pagesHtml=`<h2>本会话页面</h2>${pages.length?pages.map(p=>`<div class="card"><span class="dot ${esc(p.status)}"></span><b>${esc(p.name)}</b> <span class="pill">${esc(p.status)}</span><br><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a><br><span class="s-sub">${esc(p.description||'')}</span></div>`).join(''):'<div class="empty">本会话没有登记的本地页面</div>'}`;
  const podsHtml=`<h2>集群任务 ⇄ 实时匹配</h2>${pods.length?`<table><tr><th>任务</th><th>目标</th><th>匹配模式</th><th>实际负载</th></tr>${pods.map(t=>{const m=t.matches||[];const state=m.length?m.map(x=>`<span class="pill run" title="${esc(x.name)}">${esc(x.name.slice(0,40))}${x.gpu?` · ${x.gpu}GPU`:''}</span>`).join(''):'<span class="pill miss">未发现匹配负载</span>';return `<tr><td>${esc(t.title)}</td><td>${esc(t.kind)}:${esc(t.target)}</td><td title="${esc(t.pattern)}">${esc(t.pattern)}</td><td>${state}</td></tr>`}).join('')}</table>`:'<div class="empty">本会话没有登记的集群任务</div>'}`;
  document.getElementById('content').innerHTML=`<div class="back"><a href="/" onclick="return clearSession(event)">← 返回会话列表</a></div><div class="card"><b>${esc(s?.title||sid)}</b><br><span class="s-sub">${esc(sid)}</span> · <span class="s-sub">${esc(s?.workspace||'—')}</span></div>${stat}${pagesHtml}${podsHtml}`;
 }catch(e){document.getElementById('content').innerHTML=`<div class="empty">加载详情失败：${esc(e)}</div>`}}
document.getElementById('instanceFilter').addEventListener('change',e=>{selInstance=e.target.value;const u=new URL(location.href);if(selInstance==='all')u.searchParams.delete('instance');else u.searchParams.set('instance',selInstance);history.replaceState(null,'',u);renderList()});
document.getElementById('hubAddr').textContent=location.origin||'http://127.0.0.1:6692';
load();setInterval(load,8000);
</script></body></html>'''

USAGE_HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 对话输入统计</title>
<style>
:root{color-scheme:dark;--bg:#08111f;--panel:#101d31;--panel2:#0c1728;--line:#263a57;--text:#edf3fc;--muted:#91a5bf;--cyan:#4fd1c5;--blue:#75a7ff;--amber:#f0be62;--red:#ff7f91}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--panel2:#eef2f8;--line:#d8e0ec;--text:#17233a;--muted:#64748b;--cyan:#0f9f95;--blue:#3b72d6;--amber:#b57a10;--red:#d4374c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 0,#17365d 0,transparent 38%),var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1440px;margin:auto;padding:38px 28px 70px}
header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:25px}h1{font-size:32px;letter-spacing:-.7px;margin:0}.subtitle{color:var(--muted);margin:8px 0 0}.nav{display:flex;gap:9px}.nav a,.nav button{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:10px;padding:9px 13px;text-decoration:none;font-weight:700;cursor:pointer}.nav a:hover,.nav button:hover{border-color:var(--cyan);color:var(--cyan)}
.summary{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:12px}.metric{background:rgba(16,29,49,.93);border:1px solid var(--line);border-radius:15px;padding:18px}.metric b{font-size:28px;display:block;letter-spacing:-.4px}.metric span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.12em}.metric small{display:block;color:var(--muted);margin-top:3px}
@media (prefers-color-scheme:light){.metric{background:var(--panel)}}
.controls{display:flex;gap:10px;margin:22px 0}.controls input{flex:1;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:11px 13px;outline:none}.controls select{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:0 12px}
.panel{background:rgba(12,23,40,.94);border:1px solid var(--line);border-radius:16px;margin-top:16px;overflow:hidden}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:17px 19px;border-bottom:1px solid var(--line)}.panel-head h2{font-size:17px;margin:0}.panel-head span{color:var(--muted);font-size:12px}.days{padding:10px}.day{border:1px solid transparent;border-radius:12px;margin:4px 0}.day[open]{border-color:var(--line);background:var(--panel2)}.day summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:minmax(110px,1.2fr) repeat(4,minmax(90px,.7fr));gap:12px;padding:14px 15px;align-items:center}.day summary::-webkit-details-marker{display:none}.date{font-weight:800;font-size:15px}.value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right}.label{display:block;color:var(--muted);font:10px ui-sans-serif;text-transform:uppercase;letter-spacing:.08em}.breakdown{padding:0 15px 13px}.subrow{display:grid;grid-template-columns:minmax(230px,2fr) repeat(3,minmax(90px,.6fr));gap:12px;padding:10px;border-top:1px solid var(--line);align-items:center}.session-title{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.path{display:block;color:var(--muted);font:11px ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.table-wrap{overflow:auto;max-height:720px}table{width:100%;border-collapse:collapse;min-width:1050px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line)}th{position:sticky;top:0;background:var(--panel);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.09em;z-index:1}td.num{text-align:right;font-family:ui-monospace,Menlo,monospace}.sid{font-family:ui-monospace,Menlo,monospace;color:var(--blue);font-size:11px}.preview{max-width:300px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty,.error{padding:55px;text-align:center;color:var(--muted)}.error{color:var(--red)}.foot{color:var(--muted);font-size:12px;margin:18px 4px}
@media(max-width:850px){main{padding:25px 14px}header{align-items:flex-start;flex-direction:column}.summary{grid-template-columns:repeat(2,1fr)}.day summary{grid-template-columns:1fr 1fr}.subrow{grid-template-columns:1fr 1fr}}
</style>
</head>
<body><main>
<header><div><h1>对话输入统计</h1><p class="subtitle">只忽略累计输入字符 ≤ 10 的会话（任何输入次数都计入）；subagent 注入不计入</p></div><div class="nav"><a href="/">返回服务台</a><button id="refresh">刷新数据</button></div></header>
<section class="summary">
<div class="metric"><b id="todayChars">—</b><span>今日字符</span><small id="todayPrompts">— 条输入</small></div>
<div class="metric"><b id="allChars">—</b><span>累计字符</span><small id="allBytes">— UTF-8</small></div>
<div class="metric"><b id="promptCount">—</b><span>累计输入</span><small>用户提交的 prompt</small></div>
<div class="metric"><b id="sessionCount">—</b><span>会话数</span><small id="dayCount">— 个活跃日</small></div>
<div class="metric"><b id="avgChars">—</b><span>平均字符 / 输入</span><small id="generatedAt">—</small></div>
</section>
<section class="controls"><input id="search" placeholder="搜索会话标题、目录、Session ID 或输入预览"><select id="daysLimit"><option value="14">最近 14 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="all">全部日期</option></select></section>
<section class="panel"><div class="panel-head"><h2>每日输入量</h2><span>仅排除累计字符 ≤ 10 的会话</span></div><div class="days" id="days"></div></section>
<section class="panel"><div class="panel-head"><h2>会话汇总</h2><span id="sessionHint">仅排除累计字符 ≤ 10</span></div><div class="table-wrap"><table><thead><tr><th>会话</th><th>工作目录</th><th>最后输入</th><th>活跃天</th><th style="text-align:right">输入数</th><th style="text-align:right">字符</th><th style="text-align:right">UTF-8</th><th>最后输入预览</th></tr></thead><tbody id="sessionRows"></tbody></table></div></section>
<p class="foot" id="note"></p>
</main>
<script>
let data=null;const fmt=new Intl.NumberFormat('zh-CN');const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const compact=n=>{if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return fmt.format(n)};const time=s=>s?new Date(s).toLocaleString():'—';
function renderSummary(){const s=data.summary,today=data.local_date,d=data.days.find(x=>x.date===today);todayChars.textContent=compact(d?.characters||0);todayPrompts.textContent=fmt.format(d?.prompts||0)+' 条输入';allChars.textContent=compact(s.characters);allBytes.textContent=compact(s.utf8_bytes)+' UTF-8 字节';promptCount.textContent=fmt.format(s.prompts);sessionCount.textContent=fmt.format(s.sessions);dayCount.textContent=fmt.format(s.days)+' 个活跃日';avgChars.textContent=s.prompts?fmt.format(Math.round(s.characters/s.prompts)):'0';generatedAt.textContent='更新 '+time(data.generated_at)}
function matches(s,q){return [s.title,s.cwd,s.session_id,s.first_preview,s.last_preview].join(' ').toLowerCase().includes(q)}
function renderDays(){const q=search.value.trim().toLowerCase(),limit=daysLimit.value;let rows=data.days;if(limit!=='all')rows=rows.slice(0,Number(limit));if(q)rows=rows.map(d=>({...d,session_breakdown:d.session_breakdown.filter(s=>matches(s,q))})).filter(d=>d.session_breakdown.length);const max=Math.max(1,...rows.map(d=>d.characters));days.innerHTML=rows.length?rows.map((d,i)=>`<details class="day" ${i===0?'open':''}><summary><div><span class="date">${esc(d.date)}</span></div><div class="value"><span class="label">字符</span>${fmt.format(d.characters)}</div><div class="value"><span class="label">输入</span>${fmt.format(d.prompts)}</div><div class="value"><span class="label">Sessions</span>${fmt.format(d.sessions)}</div><div class="value"><span class="label">UTF-8</span>${fmt.format(d.utf8_bytes)}</div></summary><div class="breakdown">${d.session_breakdown.map(s=>`<div class="subrow"><div><div class="session-title">${esc(s.title||s.session_id)}</div><span class="path">${esc(s.cwd)} · ${esc(s.session_id)}</span></div><div class="value"><span class="label">字符</span>${fmt.format(s.characters)}</div><div class="value"><span class="label">输入</span>${fmt.format(s.prompts)}</div><div class="value"><span class="label">非空白</span>${fmt.format(s.non_whitespace)}</div></div>`).join('')}</div></details>`).join(''):`<div class="empty">没有匹配的日期数据</div>`}
function renderSessions(){const q=search.value.trim().toLowerCase();const rows=data.sessions.filter(s=>matches(s,q));sessionHint.textContent=`显示 ${fmt.format(rows.length)} / ${fmt.format(data.sessions.length)} 个会话`;sessionRows.innerHTML=rows.length?rows.map(s=>`<tr><td><strong>${esc(s.title)}</strong><br><span class="sid">${esc(s.session_id)}</span></td><td><span class="path" title="${esc(s.cwd)}">${esc(s.cwd)}</span></td><td>${esc(time(s.last_input_at))}</td><td class="num">${fmt.format(s.active_days)}</td><td class="num">${fmt.format(s.prompts)}</td><td class="num">${fmt.format(s.characters)}</td><td class="num">${fmt.format(s.utf8_bytes)}</td><td><div class="preview" title="${esc(s.last_preview)}">${esc(s.last_preview||'—')}</div></td></tr>`).join(''):`<tr><td colspan="8" class="empty">没有匹配的会话</td></tr>`}
function render(){renderSummary();renderDays();renderSessions();note.textContent=data.metric_note+` 时区：${data.timezone||'本地'}。数据源：${data.source}`}
async function load(force=false){days.innerHTML='<div class="empty">正在统计本地会话…</div>';try{const r=await fetch('/api/usage'+(force?'?refresh=1':''));if(!r.ok)throw new Error((await r.json()).error||r.statusText);data=await r.json();render()}catch(e){days.innerHTML=`<div class="error">统计失败：${esc(e.message||e)}</div>`}}
search.addEventListener('input',()=>data&&render());daysLimit.addEventListener('change',()=>data&&renderDays());refresh.addEventListener('click',()=>load(true));load();
</script></body></html>'''


# ================================================================ HTTP ===

def path_parts(path: str) -> list[str]:
    return [unquote(part) for part in path.split("/") if part]


class Handler(BaseHTTPRequestHandler):
    server_version = "DSHServiceHub/2.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        sys.stderr.write(f"[{self.log_date_time_string()}] {format_string % args}\n")

    def send_json(self, value: Any, status: int = 200) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, html: str) -> None:
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("invalid request body size")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object")
        return value

    # ---- GET ----
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        parts = path_parts(path)
        try:
            if path == "/":
                self.send_html(DASHBOARD_HTML)
                return
            if path == "/clusters":
                self.send_html(CLUSTERS_HTML)
                return
            if path == "/api/clusters":
                self.send_json(cluster_view())
                return
            if path == "/usage":
                self.send_html(USAGE_HTML)
                return
            if path == "/api/health":
                self.send_json({"status": "ok", "host": HOST, "port": PORT, "time": utc_now()})
                return
            if path == "/api/usage":
                self.send_json(aggregate_usage(force=query.get("refresh") == ["1"]))
                return
            if path == "/api/instances":
                self.send_json(list_instances())
                return
            if path == "/api/services":
                if query.get("check") == ["1"]:
                    for service in list_services():
                        try:
                            check_service(service["id"])
                        except Exception:
                            pass
                self.send_json(list_services(
                    instance_id=query.get("instance_id", [None])[0],
                    session_id=query.get("session_id", [None])[0],
                    status=query.get("status", [None])[0],
                    q=query.get("q", [None])[0],
                ))
                return
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "instances":
                inst = get_instance(parts[2])
                if inst:
                    self.send_json(inst)
                else:
                    self.send_json({"error": "instance not found"}, 404)
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "instances" and parts[3] == "sessions":
                self.send_json(list_sessions(instance_id=parts[2]))
                return
            if len(parts) == 2 and parts[0] == "api" and parts[1] == "sessions":
                self.send_json(list_sessions(instance_id=query.get("instance_id", [None])[0]))
                return
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "sessions":
                session = get_session(parts[2])
                if session:
                    self.send_json(_enrich_session(session))
                else:
                    self.send_json({"error": "session not found"}, 404)
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "sessions" and parts[3] == "pods":
                self.send_json(compute_session_pod_matches(list_tasks(session_id=parts[2])))
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "sessions" and parts[3] == "pages":
                self.send_json(list_services(session_id=parts[2]))
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "sessions" and parts[3] == "usage":
                self.send_json(session_usage(parts[2]))
                return
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "services":
                service = get_service(parts[2])
                if service:
                    self.send_json(service)
                else:
                    self.send_json({"error": "service not found"}, 404)
                return
            self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            self.send_json({"error": f"internal error: {exc}"}, 500)

    # ---- POST ----
    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        parts = path_parts(path)
        try:
            if path == "/api/instances":
                self.send_json(upsert_instance(self.read_json()), HTTPStatus.CREATED)
                return
            if path == "/api/sessions":
                self.send_json(upsert_session(self.read_json()), HTTPStatus.CREATED)
                return
            if path == "/api/services":
                self.send_json(upsert_service(self.read_json()), HTTPStatus.CREATED)
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "sessions" and parts[3] == "tasks":
                self.send_json(upsert_task(parts[2], self.read_json()), HTTPStatus.CREATED)
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "services":
                service_id, action = parts[2], parts[3]
                if action == "start":
                    result = start_service(service_id)
                elif action == "stop":
                    result = stop_service(service_id)
                elif action == "standby":
                    result = update_fields(service_id, status="standby")
                elif action == "check":
                    result = check_service(service_id, preserve_standby=False)
                elif action == "heartbeat":
                    result = update_fields(service_id, status="online", last_seen_at=utc_now(), last_error="")
                else:
                    self.send_json({"error": "unknown action"}, 404)
                    return
                self.send_json(result)
                return
            self.send_json({"error": "not found"}, 404)
        except KeyError:
            self.send_json({"error": "not found"}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except subprocess.TimeoutExpired:
            self.send_json({"error": "service command timed out"}, 504)
        except Exception as exc:
            self.send_json({"error": f"internal error: {exc}"}, 500)

    # ---- PUT ----
    def do_PUT(self) -> None:  # noqa: N802
        parts = path_parts(urlparse(self.path).path)
        try:
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "services":
                payload = self.read_json()
                payload["id"] = parts[2]
                self.send_json(upsert_service(payload))
                return
            self.send_json({"error": "not found"}, 404)
        except KeyError:
            self.send_json({"error": "service not found"}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)

    # ---- DELETE ----
    def do_DELETE(self) -> None:  # noqa: N802
        parts = path_parts(urlparse(self.path).path)
        try:
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "services":
                delete_service(parts[2])
                self.send_json({"deleted": parts[2]})
                return
            if len(parts) == 5 and parts[0] == "api" and parts[1] == "sessions" and parts[3] == "tasks":
                delete_task(parts[2], parts[4])
                self.send_json({"deleted": parts[4]})
                return
            self.send_json({"error": "not found"}, 404)
        except KeyError:
            self.send_json({"error": "not found"}, 404)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 409)


def serve() -> None:
    initialize_database()
    stop_event = threading.Event()
    threading.Thread(target=refresh_loop, args=(stop_event,), daemon=True).start()
    threading.Thread(target=poll_loop, args=(stop_event,), daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"DSH Service Hub v2 listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop_event.set()
        server.server_close()


def main() -> int:
    global HOST, PORT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    HOST = args.host
    PORT = args.port
    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
