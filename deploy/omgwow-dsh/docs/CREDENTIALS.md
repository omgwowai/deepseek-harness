# 凭证配置

本仓库**不含任何凭证**：没有 API key、token、webhook 地址、kubeconfig 内容或私钥。
所有凭证由使用者在本地固定目录自备，运行时经环境变量注入。本文说明需要哪些、放哪里、
怎么注入。

## 约定

- 凭证统一放一个**不入库的固定目录**，推荐 `~/Documents/dsh-credentials/`，权限 `700`，
  文件 `600`。
- 启动器只做「读取 → 导出为环境变量」，不复制、不写入、不回显。
- skills 与插件里出现的都是**路径引用**，不是凭证内容。

## 清单

| 变量 | 来源文件（示例） | 用途 |
|---|---|---|
| `OWTR_DSH_KEY` | `<凭证目录>/tokenrouter.key` | Token Router provider 的 API key（`apiKeyEnv` 指向它） |
| `DEEPSEEK_API_KEY` | `<凭证目录>/deepseek.key` | 官方 DeepSeek provider（含视觉模型目录） |

`cordis.patch.yml` 里 Token Router 路由只写 `apiKeyEnv: OWTR_DSH_KEY`，
真实值永远来自环境变量。

## 按需凭证（只有用到对应 skill 才需要）

| 凭证 | 放哪 | 让什么生效 |
|---|---|---|
| GitHub SSH 私钥 | `~/.ssh/`（公钥注册到 GitHub 账号） | `github-cluster-access` 的 clone/fetch/push |
| Kubernetes kubeconfig | `<凭证目录>/kubeconfig.yaml` | `github-cluster-access`、`cluster-task-monitor`、`local-service-hub` 的集群部分 |
| SSH 主机别名与免密登录 | `~/.ssh/config` + `~/.ssh/` | `github-cluster-access` 的机器登录、`session-cloud-sync` 的远端同步 |
| 飞书群机器人 webhook | `<凭证目录>/feishu-webhook.conf`（`600`） | `feishu` 的群消息推送 |
| lark-cli 登录态 | 本机 lark-cli 的 device-flow 登录 | `feishu` 的知识库 wiki/docs 操作 |

**注意**：群机器人 webhook 需要使用者**自行在目标飞书群注册自定义机器人**获得；
测试环境用过的 webhook 上线前必须替换为自己的。机器人若开启关键词校验，
消息必须包含约定关键词，否则会被服务端拒绝（本项目实测见过要求 `日报` 的情况）。

## 注入方式

```bash
CRED_DIR="${CRED_DIR:-$HOME/Documents/dsh-credentials}"
export OWTR_DSH_KEY="$(tr -d '[:space:]' < "$CRED_DIR/tokenrouter.key")"
export TOKENROUTER_API_KEY="$OWTR_DSH_KEY"
[ -r "$CRED_DIR/deepseek.key" ] && export DEEPSEEK_API_KEY="$(tr -d '[:space:]' < "$CRED_DIR/deepseek.key")"
```

`launcher/start.sh` 与 `launcher/docker-entry.sh` 已按上面的方式实现。

## 容器内使用

容器用 `--network host` 运行时，凭证目录以**只读**方式挂载即可：

```bash
docker run -d --network host \
  -v "$CRED_DIR":/Users/lbc/Documents/dsh-credentials:ro \
  ...
```

两个已知坑：

1. **colima 的 `--network host` 不共享宿主回环**：容器里的 `127.0.0.1:6692`
   打不到宿主服务台，必须走 `host.docker.internal`（用 `DSH_SERVICE_HUB_URL` 指定），
   否则 skill 登记的服务只会落进容器内的孤立 hub。
2. 需要 SSH 的 skill 还要把宿主 `~/.ssh` 只读挂进容器
   （`-v "$HOME/.ssh":/root/.ssh:ro`）；否则 `session-cloud-sync`、
   `github-cluster-access` 的 SSH 部分不可用。

## 不要提交的东西

`.gitignore` 之外，请确认以下内容永远不进仓库：`*.key`、`*webhook*`、`kubeconfig*`、
`*.pem`、`.env`、以及任何 `credentials/` 目录。本仓库的 `deploy/` 目录只放脚本与文档，
实测扫描（私钥头 / webhook URL / kubeconfig 字段 / Bearer / sk- 前缀）为空。
