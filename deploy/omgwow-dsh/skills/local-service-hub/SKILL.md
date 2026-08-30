---
name: local-service-hub
description: 本地服务台 v2：把所有为用户启动的本地 HTML 服务（dev server、静态页、报告预览、Web UI）与远端集群任务登记到常驻面板（http://127.0.0.1:6692，含 PID/状态/一键打开），支持按 dsh 实例筛选对话 Session、按 Session 筛选集群 Pod 任务与本地网页，并提供按会话的"对话输入统计"（只统计真实用户输入，subagent 注入不计入）。dsh 新会话界面上的「服务台」按钮一键打开。Use whenever starting, stopping, previewing, or reporting a localhost HTML service or a cluster job.
---

# DSH 本地服务台 v2

所有为用户开启的本地 HTML 页面、静态站点、开发服务器、报告预览和 Web UI，都必须登记到常驻服务台：

```text
http://127.0.0.1:6692          面板（实例 → 会话 → 本地页面 / 集群任务 / 输入统计）
http://127.0.0.1:6692/usage    对话输入统计（只统计真实用户输入）
```

服务台由常驻进程托管（启动脚本：`/Users/lbc/Documents/dsh-v2/service-hub/start-hub.sh`，端口 `DSH_SERVICE_HUB_PORT` 可覆盖，默认 6692）。记录实例、会话、服务名称、URL、端口、工作目录、PID、启动命令、状态与错误；并后台轮询 K8s 集群 / SSH 主机，把登记任务与实际负载做 regex 匹配展示。

dsh 新会话界面上有「服务台」按钮，一键在新标签页打开 `http://127.0.0.1:6692/?instance=<实例id>&session=<当前会话id>`。

## CLI

```bash
HUB=/Users/lbc/Documents/dsh-v2/service-hub/scripts/service_hub.py

python3 $HUB health
python3 $HUB list --check
python3 $HUB open
```

### 登记本地网页（绑定当前会话）

启动 HTML 服务前先登记，再由服务台启动。`--start-command` 必须能从 `--cwd` 执行；服务默认监听 `127.0.0.1`。

```bash
python3 $HUB register \
  --id my-report \
  --name "My report" \
  --url http://127.0.0.1:8765 \
  --cwd "$PWD" \
  --description "Performance report" \
  --start-command "python3 -m http.server 8765 --bind 127.0.0.1 --directory report" \
  --instance 8890 --session <当前会话id> \
  --status offline
python3 $HUB start my-report
```

### 登记集群任务（绑定当前会话，见 cluster-task-monitor skill）

```bash
python3 $HUB register --id my-train-run --name "DSv4 SFT 训练" \
  --kind k8s --target liaoning --pattern '^dsv4-sft' --session <SESSION_ID> --instance 8890

python3 $HUB register --id router-bench --name "Router 压测" \
  --kind ssh --target sg-compute --pattern 'bench_router\.py' --session <SESSION_ID> --instance 8890
```

`--target` 取值：K8s 为逻辑集群名 `chengdu|weihai|liaoning|jiaqi-b300`（kubeconfig 见 github-cluster-access skill）；SSH 为 `~/.ssh/config` 中的 Host 别名。任务结束后 `remove` 对应 id。

固定 `--id` 用稳定的 kebab-case；同一页面再次登记复用 ID 以更新而非重复。

## 面板功能

- **实例筛选**：顶部按 dsh 实例（如 8890）筛选对话 Session 列表。
- **会话筛选**：选中一个 Session 后，显示该会话打开的本地网页（在线状态点 + 一键打开/关闭）、登记的集群 Pod/进程任务（含实际负载匹配：Pod 名/phase/GPU/CPU/内存/重启次数）、以及该会话的输入统计。
- **输入统计**：只统计 `source.kind == 'user'` 的真实用户输入；assistant 回复、工具结果、系统注入、subagent 注入上下文（subagent-settled / subagent-report 等）一律不计入。
- **输入统计页** `/usage`：全局聚合（按天 / 按会话），与会话页数据一致。

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

## 已知限制：面板托管启动 vs macOS 保护目录

若服务的 `--cwd` 在 macOS 保护目录（~/Documents、~/Desktop、~/Downloads）下导致面板 `start` 失败（子进程 `PermissionError`），改用「外部启动」路径——自己直接拉起服务，再 `register --pid <pid> --status online` 登记；面板只记录与探测，不托管生命周期。

## 边界

- 面板只监听 `127.0.0.1`，浏览器不产生远程流量；集群轮询在服务台后台线程低频进行（默认 120s/来源，失败指数退避）。
- 不要输出 kubeconfig 原文、token、webhook 地址等敏感信息。
- 面板不可达时：先 `python3 $HUB health`；仍失败则检查常驻进程（`/Users/lbc/Documents/dsh-v2/service-hub/start-hub.sh`）是否在运行。
