---
name: cluster-task-monitor
description: Register long-running cluster tasks (Kubernetes pods on chengdu/weihai/liaoning/jiaqi-b300 and SSH-host processes) in the local service hub and enforce progress-reporting cadence. Use whenever you start, monitor, or finish a remote download/job/experiment, or when the user asks what is running on the clusters. Download tasks report progress at most every 30 minutes with bandwidth-based ETA; experiment tasks are checked at most every 5 minutes before the 5-minute stability confirmation (never sleep longer than 5 minutes), and after stabilization report at most every 20 minutes.
---

# 集群任务监控与进度汇报（dsh）

所有在远端集群（K8s 或 SSH 主机）启动的长期任务，都必须登记到本地服务台（service-hub v2）：

```text
http://127.0.0.1:6692
```

服务台由常驻后台进程托管（`DSH_SERVICE_HUB_URL` 环境变量覆盖，默认 6692）。页面展示：

1. **实例视角**：多个 dsh 实例（如 8890）→ 各自对话 Session 的列表筛选。
2. **会话视角**：单个 Session 打开的本地 HTTP 网页（含在线状态）。
3. **集群资源视角**：Session 登记的 K8s Pod 任务 / SSH 进程任务 ⇄ 实际集群负载的 regex 匹配（GPU/CPU/内存/重启次数）。
4. **输入统计视角**：per-session 人工输入统计（字符数/次数/活跃天数；subagent 注入内容不计入）。

## 凭证目录（固定，不得改路径）

所有集群/服务凭证统一存放在：

```text
/Users/lbc/Documents/dsh-credentials/
```

- Token Router：`tokenrouter.key`、DeepSeek 官方：`deepseek.key`
- 集群访问（kubeconfig 等）按 `github-cluster-access` skill 的约定在该目录下维护。
新实例/新 skill 一律从该目录读取凭证，禁止把 key 复制到项目目录。

## 任务登记 CLI

```bash
HUB="/Users/lbc/Documents/dsh-v2/service-hub/scripts/service_hub.py"
python3 "$HUB" list
python3 "$HUB" health
```

启动长期任务后立即登记（`--session <当前会话id>` 必填，把任务与当前对话绑定）：

```bash
# 本地网页（agent 在本会话里打开的 http 服务）
python3 "$HUB" register --id my-dashboard --name "实验报告" \
  --url http://127.0.0.1:6688 --session <SESSION_ID> --instance 8890

# 集群任务（pattern 是匹配 Pod 名 / 进程命令行的 regex）
python3 "$HUB" register --id my-train-run --name "DSv4 SFT 训练" \
  --kind k8s --target liaoning --pattern '^dsv4-sft' --session <SESSION_ID>

python3 "$HUB" register --id router-bench --name "Router 压测" \
  --kind ssh --target sg-compute --pattern 'bench_router\.py' --session <SESSION_ID>
```

`--target` 取值：K8s 为逻辑集群名 `chengdu|weihai|liaoning|jiaqi-b300`；SSH 为 `~/.ssh/config` 中的 Host 别名。任务结束后 `remove` 对应 id。kubeconfig 变更后按 `github-cluster-access` skill 的说明同步缓存。

## 进度汇报节奏（强制，不得违反）

### 下载任务（download / 拉取数据 / 同步文件）
1. 启动时立即估算：已知带宽 `B`（缺省按 20MB/s）与总大小 `S`，预计时长 `T = S / B`，并登记任务、记录 ETA。
2. **最多每 30 分钟**汇报一次下载进度（已下/总量/百分比/瞬时速度/预计剩余时间）。30 分钟内不得重复汇报，除非用户主动询问。
3. 下载完成后立即汇报一次最终结果（大小、耗时、校验状态）。汇报写入对话并在任务 note 里更新。

### 实验/训练/推理任务（experiment / 长稳运行）
1. **稳定确认期（启动后前 5 分钟）**：最多每 5 分钟检查一次任务状态（进程存活、日志尾部、Pod phase、GPU 利用率），**绝对不允许单次 sleep/等待超过 5 分钟**——用 ≤5 分钟的短轮询循环代替长 sleep，防止任务卡死（OOM、cuda error、挂起）时白白消耗大量时间。发现异常立即汇报并处置。
2. 连续 5 分钟稳定运行（无报错、无重启、资源占用正常）后，才可确认为「长稳运行」。
3. **长稳运行期**：最多每 20 分钟汇报一次运行进展（step/epoch 进度、loss、吞吐、显存/内存、任何警告）。20 分钟内不得重复汇报，除非用户主动询问或出现异常。
4. 任务结束（成功/失败/被杀）后立即汇报最终结果并 `remove` 登记。

### 通用约束
- 所有检查走短命令（`kubectl get pods` 单 namespace、`tail -n` 日志尾部、SSH 单条聚合命令），不得为监控引入高带宽操作。
- 不可达/失败必须如实汇报，不得伪造进度。
- 用户主动询问进度时，立即做一次检查并汇报，不受上述间隔限制。

## 查看

- 网页：`http://127.0.0.1:6692/?instance=8890&session=<SESSION_ID>`（dsh 新会话界面上的「服务台」按钮一键打开）。
- 命令行：`python3 "$HUB" health` / `list`。
