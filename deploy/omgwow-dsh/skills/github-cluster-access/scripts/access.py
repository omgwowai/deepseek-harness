#!/usr/bin/env python3
"""GitHub SSH 与 Kubernetes 集群访问助手（dsh 版，固定 kubeconfig 路径 + SSH config 扫描）。

kubeconfig 固定位置：$HOME/Documents/cluster-access/kubeconfig.yaml（2026-08-21 从
~/Downloads/kubeconfig(2).yaml 一次性搬移）。不再扫描 Downloads。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence

KUBECONFIG = Path("/Users/lbc/Documents/dsh-credentials/kubeconfig.yaml")
SSH_CONFIG = Path.home() / ".ssh" / "config"

CONTEXT_RULES: dict[str, tuple[str, ...]] = {
    "chengdu": ("chengdu-h100", "chengdu"),
    "weihai": ("weihai-h100", "weihai"),
    "liaoning": ("liaoning-h100", "liaoning"),
    "jiaqi-b300": ("jq-b300", "jiaqi-b300"),
}
CONTEXT_ALIASES = {
    "jiaqi": "jiaqi-b300",
    "jq-b300": "jiaqi-b300",
    "chengdu-h100": "chengdu",
    "weihai-h100": "weihai",
    "liaoning-h100": "liaoning",
}


class AccessError(RuntimeError):
    """A safe, user-actionable access failure."""


def _tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        # dsh 会话 PATH 可能不含用户 bin 目录，按常见位置兜底
        for candidate_dir in (str(Path.home()/"bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
            candidate = Path(candidate_dir) / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        raise AccessError(f"Required executable not found: {name}")
    return path


def _completed(command: Sequence[str], *, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(list(command), check=False, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise AccessError(f"Command timed out after {timeout}s: {command[0]}") from exc


def _error_text(result: subprocess.CompletedProcess[str]) -> str:
    text = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    return text or f"command exited with status {result.returncode}"


def load_kubeconfig() -> Path:
    if not KUBECONFIG.is_file():
        raise AccessError(f"kubeconfig not found at fixed path {KUBECONFIG}; 请把最新 kubeconfig 放到该路径")
    return KUBECONFIG


def read_contexts(kubeconfig: Path) -> list[str]:
    result = _completed([_tool("kubectl"), "--kubeconfig", str(kubeconfig), "config", "get-contexts", "-o", "name"], timeout=15)
    if result.returncode != 0:
        raise AccessError(f"Cannot parse kubeconfig {kubeconfig}: {_error_text(result)}")
    contexts = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not contexts:
        raise AccessError(f"kubeconfig has no contexts: {kubeconfig}")
    return contexts


def map_expected_contexts(contexts: Sequence[str], kubeconfig: Path) -> dict[str, str]:
    available = set(contexts)
    mapped: dict[str, str] = {}
    missing: list[str] = []
    for logical, preferred in CONTEXT_RULES.items():
        exact = next((name for name in preferred if name in available), None)
        if exact is not None:
            mapped[logical] = exact
            continue
        if logical == "jiaqi-b300":
            matches = sorted(name for name in contexts if name.casefold().startswith(("jiaqi-", "jq-")) and "b300" in name.casefold())
        else:
            prefix = logical.casefold() + "-"
            matches = sorted(name for name in contexts if name.casefold().startswith(prefix))
        if len(matches) == 1:
            mapped[logical] = matches[0]
        elif len(matches) > 1:
            raise AccessError(f"kubeconfig has ambiguous contexts for {logical}: {', '.join(matches)}")
        else:
            missing.append(logical)
    if missing:
        raise AccessError(f"kubeconfig {kubeconfig} is missing expected clusters: {', '.join(missing)}")
    return mapped


def load_cluster_access() -> tuple[Path, list[str], dict[str, str]]:
    kubeconfig = load_kubeconfig()
    contexts = read_contexts(kubeconfig)
    mapped = map_expected_contexts(contexts, kubeconfig)
    return kubeconfig, contexts, mapped


def resolve_context(requested: str, contexts: Sequence[str], mapped: dict[str, str]) -> str:
    normalized = requested.casefold()
    logical = CONTEXT_ALIASES.get(normalized, normalized)
    if logical in mapped:
        return mapped[logical]
    exact = next((name for name in contexts if name.casefold() == normalized), None)
    if exact is not None:
        return exact
    allowed = ", ".join((*mapped.keys(), *contexts))
    raise AccessError(f"Unknown cluster/context '{requested}'. Available: {allowed}")


def github_check(timeout_seconds: int) -> None:
    result = _completed(
        [
            _tool("ssh"), "-T", "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0",
            "-o", f"ConnectTimeout={timeout_seconds}", "git@github.com",
        ],
        timeout=timeout_seconds + 5,
    )
    text = _error_text(result)
    if "successfully authenticated" not in text.casefold():
        raise AccessError(f"GitHub SSH authentication failed: {text}")
    print(f"GitHub SSH OK: {text}")


def print_contexts(as_json: bool) -> None:
    kubeconfig, contexts, mapped = load_cluster_access()
    if as_json:
        print(json.dumps({"kubeconfig": str(kubeconfig), "clusters": mapped, "contexts": contexts}, ensure_ascii=False, indent=2))
        return
    print(f"Kubeconfig: {kubeconfig}")
    for logical, context in mapped.items():
        print(f"{logical} -> {context}")


def cluster_check(targets: Sequence[str], timeout_seconds: int) -> None:
    kubeconfig, contexts, mapped = load_cluster_access()
    requested = list(targets) or ["all"]
    if "all" in requested:
        if len(requested) != 1:
            raise AccessError("Use 'all' alone or list individual clusters")
        requested = list(mapped)
    failures: list[str] = []
    print(f"Kubeconfig: {kubeconfig}")
    for name in requested:
        context = resolve_context(name, contexts, mapped)
        result = _completed(
            [
                _tool("kubectl"), "--kubeconfig", str(kubeconfig), "--context", context,
                f"--request-timeout={timeout_seconds}s", "get", "namespaces", "-o", "name",
            ],
            timeout=timeout_seconds + 5,
        )
        if result.returncode == 0:
            namespace_count = sum(1 for line in result.stdout.splitlines() if line.strip())
            print(f"{name} -> {context}: OK ({namespace_count} namespaces visible)")
        else:
            message = _error_text(result)
            failures.append(f"{name} -> {context}: {message}")
            print(f"{name} -> {context}: FAILED", file=sys.stderr)
    if failures:
        raise AccessError("Cluster access failed:\n" + "\n".join(failures))


def run_kubectl(cluster: str, kubectl_args: Sequence[str]) -> int:
    kubeconfig, contexts, mapped = load_cluster_access()
    context = resolve_context(cluster, contexts, mapped)
    command_args = list(kubectl_args)
    if command_args and command_args[0] == "--":
        command_args = command_args[1:]
    if not command_args:
        raise AccessError("kubectl requires arguments after the cluster name")
    if not any(arg == "--request-timeout" or arg.startswith("--request-timeout=") for arg in command_args):
        command_args.insert(0, "--request-timeout=15s")
    result = subprocess.run(
        [_tool("kubectl"), "--kubeconfig", str(kubeconfig), "--context", context, *command_args],
        check=False,
    )
    return result.returncode


# ---- 新增：~/.ssh/config 扫描（用户说"登录某个集群/机器"时用） ----


def read_ssh_hosts() -> list[str]:
    """解析 ~/.ssh/config 的 Host 条目（含通配 Host 展开成字面量列在这里，标注 *）。"""
    if not SSH_CONFIG.is_file():
        raise AccessError(f"SSH config not found: {SSH_CONFIG}")
    hosts: list[str] = []
    for raw in SSH_CONFIG.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if line.startswith("#") or not line:
            continue
        if line.casefold().startswith("host "):
            for token in line.split()[1:]:
                hosts.append(token)
    return hosts


def ssh_check(host: str, timeout_seconds: int) -> None:
    result = _completed(
        [
            _tool("ssh"), "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0",
            "-o", f"ConnectTimeout={timeout_seconds}", host, "echo OK",
        ],
        timeout=timeout_seconds + 5,
    )
    if result.returncode != 0:
        raise AccessError(f"SSH to '{host}' failed: {_error_text(result)}")
    print(f"SSH {host}: OK")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    github = subparsers.add_parser("github-check", help="verify github.com SSH authentication")
    github.add_argument("--timeout-seconds", type=int, default=10)

    subparsers.add_parser("kubeconfig", help="print the fixed kubeconfig path")

    contexts = subparsers.add_parser("contexts", help="show the four logical cluster mappings")
    contexts.add_argument("--json", action="store_true")

    context = subparsers.add_parser("context", help="resolve one logical cluster to a context")
    context.add_argument("name")

    check = subparsers.add_parser("cluster-check", help="check read-only access to one or all clusters")
    check.add_argument("targets", nargs="*", help="logical cluster names or 'all'")
    check.add_argument("--timeout-seconds", type=int, default=10)

    kubectl = subparsers.add_parser("kubectl", help="run kubectl with the fixed config and explicit context")
    kubectl.add_argument("cluster")
    kubectl.add_argument("kubectl_args", nargs=argparse.REMAINDER)

    subparsers.add_parser("ssh-hosts", help="list Host entries from ~/.ssh/config")

    ssh = subparsers.add_parser("ssh-check", help="test BatchMode SSH reachability of a config Host alias")
    ssh.add_argument("host")
    ssh.add_argument("--timeout-seconds", type=int, default=8)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "github-check":
            github_check(args.timeout_seconds)
            return 0
        if args.command == "kubeconfig":
            print(load_kubeconfig())
            return 0
        if args.command == "contexts":
            print_contexts(args.json)
            return 0
        if args.command == "context":
            _, contexts, mapped = load_cluster_access()
            print(resolve_context(args.name, contexts, mapped))
            return 0
        if args.command == "cluster-check":
            cluster_check(args.targets, args.timeout_seconds)
            return 0
        if args.command == "kubectl":
            return run_kubectl(args.cluster, args.kubectl_args)
        if args.command == "ssh-hosts":
            print("\n".join(read_ssh_hosts()))
            return 0
        if args.command == "ssh-check":
            ssh_check(args.host, args.timeout_seconds)
            return 0
        raise AccessError(f"Unhandled command: {args.command}")
    except AccessError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
