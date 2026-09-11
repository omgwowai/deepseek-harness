# 凭证 → skills 生效对照

一张表看清：哪个凭证让哪些 skill / 插件真正可用，以及缺了它会怎样。

## 自研 skills

| Skill | 必需凭证 / 环境 | 缺失时的表现 | 备注 |
|---|---|---|---|
| `github-cluster-access` | kubeconfig（`$CRED_DIR/kubeconfig.yaml`，可用 `KUBECONFIG_PATH` 覆盖）；GitHub SSH 私钥；`~/.ssh/config` 的 Host 别名 | kubectl 类操作报认证/连接失败；SSH 类操作找不到别名 | 集群名固定映射：`chengdu`→`chengdu-h100`、`weihai`→`weihai-h100`、`liaoning`→`liaoning-h100`、`jiaqi-b300`→`jq-b300`。不要输出 kubeconfig 原文、token、私钥 |
| `session-cloud-sync` | 远端备份主机的 SSH 免密登录 + 远端目录写权限（`SSH_HOST` / `REMOTE_ROOT` 两个变量） | `status` 立即超时/认证失败 | 默认走 `~/.ssh/config` 的别名；变量未设置时用占位默认值，需按部署填写 |
| `feishu` | 群机器人 webhook（`$CRED_DIR/feishu-webhook.conf`）；lark-cli 登录态（知识库操作时） | 推送报 19024 等错误码（含关键词校验失败）；知识库操作报未登录 | webhook 必须由使用者自行在该群注册机器人获得；机器人若开了关键词校验，消息需含约定关键词 |
| `local-service-hub` | 常驻服务台可达（`DSH_SERVICE_HUB_URL`，默认 `127.0.0.1:6692`） | CLI 报连不上面板 | 容器内需指向 `host.docker.internal:6692` |
| `cluster-task-monitor` | 同上（服务台可达）；K8s 任务还需 kubeconfig，SSH 任务还需 `~/.ssh/config` | 登记失败或任务卡在未知状态 | 任务结束后必须 `remove`，避免面板留脏数据 |

## 自研插件

| 插件 | 必需凭证 | 缺失时的表现 |
|---|---|---|
| `dsh-tokenrouter-cost` | Token Router key（`OWTR_DSH_KEY`） | 无法计价（就没有调用）。价格表为 `prices.json` 快照，与凭证无关 |
| `dsh-rollout-transparent` | 无额外凭证（跟随当前 provider） | — |
| `dsh-mem-watch` | 无 | — |
| `dsh-service-hub` | 服务台可达（`DSH_SERVICE_HUB_URL`） | 实例不上报、面板里看不到本实例；容器内需 `host.docker.internal` |

## 模型 provider

| 路由 | 凭证 | 说明 |
|---|---|---|
| `tokenrouter`（自研路由） | `OWTR_DSH_KEY` | 模型与 `input` 能力在 `profile/cordis.patch.yml` 声明；`deepseek-v4-flash`、`claude-fable-5`、`gpt-5.6-sol`、`kimi-k3`、`claude-opus-5` 声明了 `image` |
| `deepseek-official`（上游内置） | `DEEPSEEK_API_KEY` | 目录里含视觉模型 `deepseek-v4-flash-vision-exp` |

## 快速自检

```bash
# 服务台是否可达
python3 "$DSH_SERVICE_HUB_CLI" health

# 集群只读连通性（需要一个可用的 kubeconfig）
python3 "$DSH_SKILLS_DIR/github-cluster-access/scripts/access.py" contexts --json

# 飞书推送（会真的发消息）
python3 "$DSH_SKILLS_DIR/feishu/scripts/feishu-notify.py" "DSH 自检消息"
```
