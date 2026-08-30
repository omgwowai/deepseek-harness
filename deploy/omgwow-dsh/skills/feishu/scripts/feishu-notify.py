#!/usr/bin/env python3
"""把一条文本消息推送到飞书日报群（现有群机器人 webhook）。

用法: feishu-notify.py "<消息文本>" [--webhook-config PATH]
配置: 默认 /Users/lbc/Documents/harness-rc8/tooling/feishu/webhook.conf（chmod 600），
     内容为一行 webhook URL。
限制: 飞书 text 消息约 30KB，超长自动截断。
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

DEFAULT_CONFIG = Path("/Users/lbc/Documents/dsh-credentials/feishu-webhook.conf")
MAX_TEXT_CHARS = 20000


def load_webhook(path: Path) -> str:
    if not path.is_file():
        raise SystemExit(f"webhook 配置不存在: {path}（请先创建该文件并写入群机器人 webhook URL）")
    url = path.read_text(encoding="utf-8").strip()
    if not url.startswith("https://"):
        raise SystemExit(f"webhook 配置内容非法: {path}")
    return url


def main() -> int:
    args = [arg for arg in sys.argv[1:] if not arg.startswith("--webhook-config")]
    config_path = DEFAULT_CONFIG
    for i, arg in enumerate(sys.argv[1:]):
        if arg.startswith("--webhook-config"):
            if "=" in arg:
                config_path = Path(arg.split("=", 1)[1])
            elif i + 2 < len(sys.argv):
                config_path = Path(sys.argv[i + 2])
    if not args:
        raise SystemExit("usage: feishu-notify.py '<text>' [--webhook-config PATH]")
    text = " ".join(args)
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS] + "\n...(截断)"
    url = load_webhook(config_path.expanduser())
    payload = json.dumps({"msg_type": "text", "content": {"text": text}}).encode("utf-8")
    request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001 — 通知失败要向调用方报错
        print(f"feishu-notify failed: {exc}", file=sys.stderr)
        return 1
    print(f"feishu-notify sent: {body[:120]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
