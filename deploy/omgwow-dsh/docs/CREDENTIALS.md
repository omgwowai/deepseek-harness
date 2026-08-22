# 凭证清单（CREDENTIALS）

> 原则：**本仓库（含 deploy/omgwow-dsh）不含任何真实凭证/密钥/私钥/webhook**。
> 下列每一项都需要使用者（同事）在自己的机器上自行准备，并放在仓库之外的本地
> 位置；将密钥文件路径填入对应配置后使用。切勿把任何真实值提交到 GitHub。

## 按组件归类的凭证需求

### 1. LLM 模型路由

| 组件 | 凭证 | 获取方式 | 使用位置 |
|---|---|---|---|
| Token Router 路由（llm-pi-ai） | Token Router API Key（`owtr_...`） | Token Router 仪表盘 → API Key | 本地密钥文件（如 `~/tokenrouter-access/tokenrouter.key`），启动器经 `TOKENROUTER_API_KEY` 注入；profile 补丁中 `apiKeyEnv: TOKENROUTER_API_KEY` |
| DeepSeek 官方路由（llm-deepseek） | DeepSeek 开放平台 API Key（`sk-...`） | platform.deepseek.com → API Keys | 本地密钥文件（如 `~/tokenrouter-access/deepseek.key`），启动器经 `DEEPSEEK_API_KEY` 注入；官方视觉模型 DeepSeek-V4-Flash-Vision-Exp 依赖此路由 |

### 2. 自研插件

| 插件 | 凭证 | 说明 |
|---|---|---|
| dsh-tokenrouter-cost | 无网络凭证 | 界面暂不展示余额（本地无准确余额来源）；等 Token Router 官方计费 API 开放后接入余额查询 |

### 3. 自研 skills

| Skill | 凭证 | 获取/配置方式 | 仓库中只有 |
|---|---|---|---|
| feishu | ① 飞书群机器人 webhook URL；② lark-cli 登录态（device-flow 鉴权） | ① **使用者先在自己的飞书群注册自定义机器人**获取 webhook，存到本地 `$HOME/.dsh/feishu/webhook.conf`（测试环境用过的 webhook 必须替换，不入库）；② 首次用 lark-cli 走 device-flow 登录 | SKILL.md 与参数化路径 |
| github-cluster-access | ① GitHub SSH 私钥（公钥注册到 GitHub 账号）；② kubeconfig（含集群 token/证书） | ① `ssh-keygen` 生成并把公钥加到 GitHub；② 集群管理员提供的 kubeconfig 放本地（`$HOME/Documents/cluster-access/kubeconfig.yaml`，可用 `KUBECONFIG_PATH` 覆盖） | SKILL.md + access.py（只读脚本，不含凭据） |
| local-service-hub | 无 | 面板绑定本机回环地址；端口由部署配置（`DSH_SERVICE_HUB_PORT`），未指定时自动分配可用端口 | SKILL.md + service_hub.py |
| session-cloud-sync | 远端备份主机 SSH 免密登录（`~/.ssh/config` Host 别名 + 已注册公钥）；远端目录写权限 | 自备远端主机账号与 SSH 配置；远端主机名/用户名/路径在 SKILL.md 中为占位符，按实际填写 | SKILL.md（已参数化） |
| record-browser-gif | 无（本地浏览器） | — | SKILL.md + encode_gif.py |

### 4. 其它本地资源（不入库）

| 资源 | 凭证 | 备注 |
|---|---|---|
| `$HOME/.dsh/feishu/feishu-notify.py` + `webhook.conf` | 飞书 webhook | 仅在本地，绝不入库 |
| `~/tokenrouter-access/*.key` | Token Router / DeepSeek 官方 Key | 0400 权限本地文件 |
| `$HOME/Documents/cluster-access/kubeconfig.yaml` | 集群 token/证书 | 仅在本地 |
| `~/.ssh/` | SSH 私钥 | 仅在本地 |
| `$DSH_HOME/.credentials.yaml` | DeepSeek API Key | 仅在本地 |

## 同事接入检查清单

- [ ] 本地准备两个密钥文件（Token Router + DeepSeek 官方），确认不在仓库目录内
- [ ] 本地注册自己的飞书群机器人 webhook，替换测试环境 webhook
- [ ] `git ls-files | xargs grep -l "sk-\|owtr_\|webhook"` 返回空（提交前自查）
- [ ] profile 补丁里只有环境变量名（`apiKeyEnv`），没有真实值
- [ ] skills 里所有绝对路径已替换成本机实际路径
- [ ] 首次推送前跑一次 `git diff --cached` 人工过一遍敏感项
