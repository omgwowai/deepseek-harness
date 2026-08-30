# 凭证配置与 Skills 生效对照（8892 实例 / omgwow-dsh 适配层）

> 所有凭证统一放在本地固定目录（默认 `/Users/lbc/Documents/dsh-credentials/`，目录本身不入库，
> 各 skill 与启动器只引用该目录路径）。本文档说明：**配置哪一个凭证，会让哪些 skills / 功能生效**。
> 凭证文件权限建议 `0400`，任何 key 都不得提交到仓库。

## 一、凭证总览

| 凭证文件 | 环境变量 / 使用方式 | 用途 |
|---|---|---|
| `tokenrouter.key` | `OWTR_DSH_KEY` / `TOKENROUTER_API_KEY` | Token Router 模型路由（7 个模型）+ rollout judge 后端 |
| `deepseek.key` | `DEEPSEEK_API_KEY` | DeepSeek 官方 API（视觉模型 / 官方备路 / 官方 e2e） |
| `kubeconfig.yaml` | 固定路径读取 | 四个 K8s 集群（chengdu/weihai/liaoning/jiaqi-b300）访问 |
| `feishu-webhook.conf` | feishu-notify 脚本读取 | 飞书群机器人消息推送 |
| `~/.ssh/config` + SSH 私钥 | ssh 别名 | SSH 机器访问、会话云端同步 |
| lark-cli 鉴权（device-flow） | 交互式登录（无文件） | 飞书知识库 wiki/docs 操作 |
| `gh` 登录态（`~/.config/gh`） | gh CLI | GitHub PR 审查 / Stacked PR 合并 |

## 二、凭证 → Skills 生效对照

### 1. `tokenrouter.key`（Token Router API Key）

| 生效对象 | 说明 |
|---|---|
| **所有对话的模型路由** | profile 的 llm-pi-ai `tokenrouter` provider（claude-fable-5 / gpt-5.6-sol / kimi-k3 / claude-opus-5 / glm-5.3 / deepseek-v4-pro / deepseek-v4-flash，deepseek 系 1M 上下文） |
| **rollout-transparent 插件** | fanout N 条轨迹 + judge（默认后端 tokenrouter，模型 deepseek-v4-flash）+ criteria 生成，全部走此 key |
| **dsh-tokenrouter-cost 插件** | 计费账本按 Token Router 页面价格四档计价（key 本身不用于计费查询，仅模型调用） |

未配置后果：Token Router 路由不可用，`agent-default-model`（provider=tokenrouter）会报 `NO_ADAPTER`，rollout judge/criteria 同样失败。

### 2. `deepseek.key`（DeepSeek 官方 API Key）

| 生效对象 | 说明 |
|---|---|
| DeepSeek 官方路由 | llm-deepseek（DeepSeek-V4-Flash-Vision-Exp 等官方视觉模型） |
| 官方备路 | 官方 API 不可用时的切换目标；官方仓库 e2e 测试自测 |

未配置后果：仅官方路由不可用；Token Router 路由不受影响。

### 3. `kubeconfig.yaml`（四集群 kubeconfig）

| 生效对象 | 说明 |
|---|---|
| **github-cluster-access skill** | `access.py contexts` / `kubectl <cluster> -- ...` 的全部集群操作 |
| **local-service-hub / 服务台 v2 集群总览** | 后台每 120s 轮询四个集群的 pod/GPU/CPU/内存快照（`/clusters` 视图） |
| **cluster-task-monitor skill** | 登记集群任务的 `--target <cluster>` 与后续匹配监控 |

未配置后果：以上 skill 的集群操作全部如实报 `kubeconfig not found`；服务台集群总览为空。

### 4. `feishu-webhook.conf`（飞书群机器人 webhook）

| 生效对象 | 说明 |
|---|---|
| **feishu skill 的群消息推送** | `feishu-notify.py` 读取该文件发送（消息必须含配置的关键词，如「日报」） |
| session-cloud-sync 的完成通知 | 同步结果推送到飞书日报群（同一 webhook） |

未配置后果：推送类操作报错；feishu 的 lark-cli 知识库功能不受影响（那是另一套鉴权）。

### 5. `~/.ssh/config` + SSH 私钥

| 生效对象 | 说明 |
|---|---|
| **github-cluster-access skill** | `ssh <别名>` 访问 sg-compute 等主机（负载/显存/进程） |
| **session-cloud-sync skill** | rsync 到 oracle-sg-bastion01 等备份主机 |

未配置后果：SSH 相关操作如实报认证失败；集群 k8s 操作不受影响。

### 6. lark-cli 鉴权（device-flow，交互式）

| 生效对象 | 说明 |
|---|---|
| **feishu skill 的知识库操作** | wiki/docs 节点创建/更新/读取（space-id 7624384248404773820 等） |

说明：无文件凭证；首次使用按 skill 流程执行 `lark auth login`，把授权链接发给使用者完成。
未配置后果：知识库操作报鉴权失败（skill 会如实给出授权链接）。

### 7. `gh` 登录态

| 生效对象 | 说明 |
|---|---|
| **dsh-code-review skill** | 读取 PR / diff / 评论 |
| **dsh-merging-stacked-prs skill** | 查询与合并 stacked PR（gh stack） |

未配置后果：以上两个 skill 的 GitHub 操作报未登录；本地 git 操作不受影响。

## 三、配置检查清单

```bash
# 1. Token Router
test -s "$CRED_DIR/tokenrouter.key" && echo "tokenrouter ✓" || echo "tokenrouter ✗"

# 2. DeepSeek 官方
test -s "$CRED_DIR/deepseek.key" && echo "deepseek ✓" || echo "deepseek ✗"

# 3. 四集群 kubeconfig（access.py contexts 应列出 4 个集群）
python3 <skills>/github-cluster-access/scripts/access.py contexts

# 4. 飞书 webhook（发一条含关键词的测试消息）
/usr/bin/python3 <skills>/feishu/scripts/feishu-notify.py "DSH 日报｜凭证自检"

# 5. SSH 别名（应能无密码登录）
ssh -o BatchMode=yes -o ConnectTimeout=10 <别名> 'echo ok'

# 6. lark 鉴权
<lark-cli 路径>/lark-cli auth status

# 7. gh
gh auth status
```

## 四、安全约定

- 凭证目录与文件不入库；启动器/脚本只读文件、不内嵌值。
- 提交前自查：`git diff origin/master...HEAD | grep -E "sk-|owtr_|BEGIN.*PRIVATE|webhook.*hook/"` 应为空。
