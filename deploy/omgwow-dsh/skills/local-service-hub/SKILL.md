---
name: local-service-hub
description: 本地服务面板：把所有为用户启动的本地 HTML 服务（dev server、静态页、报告预览、Web UI）登记到常驻面板（本机回环地址 + 部署时选定端口，含 PID/状态/一键打开），并提供按会话的"对话输入统计"页（http://127.0.0.1:面板端口，只统计真实用户输入）。Use whenever starting, stopping, previewing, or reporting a localhost HTML service.
---

# DSH 本地服务台

所有为用户开启的本地 HTML 页面、静态站点、开发服务器、报告预览和 Web UI，都必须登记到常驻服务台：

```text
http://127.0.0.1:面板端口   面板（服务列表 + 一键打开/关闭）
http://127.0.0.1:面板端口/usage 对话输入统计（只统计真实对话输入）
```

服务台由 macOS LaunchAgent（`com.dsh.local-service-hub`）常驻，端口 6689（OMP 的 6688 保持不动）。记录服务名称、URL、端口、工作目录、PID、启动命令、状态与错误。

## CLI

```bash
HUB=$HOME/.dsh/skills/local-service-hub/scripts/service_hub.py

python3 $HUB health
python3 $HUB list --check
python3 $HUB open
```

### 登记并由平台管理

启动 HTML 服务前先登记，再由服务台启动。`--start-command` 必须能从 `--cwd` 执行；服务默认监听 `127.0.0.1`。

```bash
python3 $HUB register \
  --id my-report \
  --name "My report" \
  --url http://127.0.0.1:8765 \
  --cwd "$PWD" \
  --description "Performance report" \
  --start-command "python3 -m http.server 8765 --bind 127.0.0.1 --directory report" \
  --status offline
python3 $HUB start my-report
```

固定 `--id` 用稳定的 kebab-case；同一页面再次登记复用 ID 以更新而非重复。

### 登记已由外部工具启动的服务

```bash
python3 $HUB register --id existing-ui --name "Existing UI" --url http://127.0.0.1:9000 \
  --cwd "$PWD" --pid 12345 --status online
```

## 已知限制：面板托管启动 vs macOS 保护目录

面板守护进程（launchd）无法进入 macOS 保护目录（~/Documents、~/Desktop、~/Downloads，TCC 限制）。若服务的 `--cwd` 在这些目录下，`start` 会返回 `error`（子进程日志为 `os.getcwd() PermissionError`）。
**处理方式**：改用「外部启动」路径——自己直接拉起服务（`subprocess.Popen(..., start_new_session=True)`），再 `register --pid <pid> --status online` 登记；面板只记录与探测，不托管生命周期。

## 生命周期

```bash
python3 $HUB start SERVICE_ID
python3 $HUB heartbeat SERVICE_ID
python3 $HUB standby SERVICE_ID
python3 $HUB check SERVICE_ID
python3 $HUB stop SERVICE_ID
python3 $HUB remove SERVICE_ID
```

状态：`online` / `starting` / `standby` / `offline` / `error`。`remove` 只删登记，不删项目文件。

## 强制工作流

1. 启动前先 `health`；面板不可用时检查 LaunchAgent `com.dsh.local-service-hub`（状态文件在 `$HOME/.dsh/service-hub/state/`），不要另起第二个面板端口。
2. 端口 6689 仅供面板；为页面选未占用的业务端口。
3. 交付本地 HTML URL 前完成登记。
4. 用户要求关闭时 `stop`；暂时不用时 `standby`。
5. 不登记外部网站、纯 CLI 后台任务或无 Web UI 的服务。
6. 默认只绑 `127.0.0.1`；启动命令不得含 token/密码；不登记带敏感 query 的 URL。

## 对话输入统计（/usage）

- 数据源：`$DSH_HOME/sessions/` 下各会话的 `session.jsonl.zstd`。
- 口径（已校验）：只统计 `type=user/message` 且 `source.kind=user` 的事件；assistant 回复、reasoning、tool/call、tool/result、session/title、request/context、steering 等一律不计。
- 过滤：忽略累计输入 ≤ 10 字符或仅 1 次输入的会话（`summary.excluded_sessions` 显示被排除数）。
- 用户在对话中要求看输入统计时，打开 `/usage` 或调 `/api/usage`。
