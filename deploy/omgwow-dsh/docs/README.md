# omgwow × DeepSeek Harness 适配层

> 📖 **凭证配置**：需要哪些凭证、每个凭证让哪些 skills 生效，见
> [CREDENTIALS-INDEX.md](./CREDENTIALS-INDEX.md)。

本目录是 omgwow 团队在 deepseek-harness `dsh-v0.1.1-rc.1` 基础上的**适配层**：
自研插件、profile 补丁、启动器、自研 skills 与测试报告。核心 harness 本体
（`packages/`、`apps/` 等）即本仓库根目录内容，除 `packages/llm/llm-pi-ai` 的一处
本地修改外不做改动。

## 目录结构

```
deploy/omgwow-dsh/
├── instance-8892/                 8892 实例完整部署包（profile/服务台 v2/启动器/Docker，见其 README）
├── docs/
│   ├── README.md                  本说明
│   └── CREDENTIALS-INDEX.md       凭证配置 → skills 生效对照
├── plugins/
│   └── dsh-tokenrouter-cost/       自研 Token Router 计费插件
├── profile/
│   └── cordis.patch.yml            适配 profile 补丁（模型路由/插件挂载）
├── launcher/
│   └── start.sh                    通用启动器（密钥从本地文件注入，端口可配置）
├── skills/
│   ├── feishu/                     飞书集成 skill
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── github-cluster-access/      GitHub SSH + Kubernetes 集群 + SSH 机器访问 skill
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── local-service-hub/          本地服务面板 skill
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── session-cloud-sync/         会话记录云端同步 skill
│   │   └── SKILL.md
│   └── record-browser-gif/         浏览器交互 GIF 录制 skill
│       ├── SKILL.md
│       └── scripts/
└── docs/
    ├── README.md                   本文档
    ├── PLUGINS-AND-SKILLS-TEST-REPORT.md   插件与 skills 测试报告（最终结论）
    └── CREDENTIALS.md              凭证清单（同事需自备）
```

## 相对 v0.1.1-rc.1 的本地代码修改

| 修改 | 说明 |
|---|---|
| `packages/llm/llm-pi-ai`（4 文件，+88/-3） | 新增 provider 级 `mergeUserMessages`：修复 Token Router 腾讯链路在合并连续 user 消息时丢弃图片导致的 gpt-5.6-sol / kimi-k3 读图失败；附单元测试 |

## 自研组件清单（并列）

### 1. 插件：dsh-tokenrouter-cost

**作用**：按 Token Router 页面价格（Input / Cached / CachedWrite / Output 四档，
CNY/1M tokens）对每次模型调用计费；账本落盘
`$DSH_HOME/storages/tokenrouter-cost/ledger.json`；经 Typert RPC 在界面展示
「今日 / in·cache·out」与侧边栏「今日费用」。

**合规**：`./invariant` 伴生（账本一致性校验：每天合计 = byModel 各行之和）；官方
invariants 服务存在时按契约注册，否则内置自检兜底（每次流结束落盘后复核）。

**凭证**：无网络凭证。**余额暂不展示**：本地没有准确的余额来源，等 Token Router
官方计费 API 开放后，本插件再接入余额查询。

**价格数据（暂时方案）**：模型价格以 `prices.json` 快照注入（当前覆盖适配层启用的
模型）。这是**过渡方案**：Token Router 暂未开放价格 API，等价格接口可用后本插件将
改为自动拉取全量价格，届时不再需要手工维护 JSON。

**安装**：`dsh plugin add file:<本目录>/plugins/dsh-tokenrouter-cost`（file: 安装为
自有副本，`dsh plugin update` 不会覆盖）。

### 2. Skill：feishu

**作用**：飞书集成——lark-cli 知识库 wiki/docs 操作与 device-flow 鉴权；群机器人
消息推送（feishu-notify）；流程化飞书通告创建。

**凭证**：① 群机器人 webhook：使用者**先行在飞书群注册自定义机器人**获取，配置到
本地 `$HOME/.dsh/feishu/webhook.conf`（测试环境用过的 webhook 上线前必须替换为
自注册的）；② lark-cli 登录态（device-flow 鉴权）。知识库操作时由使用者指定目标
知识库名称或 space-id。

### 3. Skill：github-cluster-access

**作用**：GitHub 走已注册 SSH key；Kubernetes 集群操作用固定 kubeconfig
（chengdu/weihai/liaoning/jiaqi-b300 四个逻辑集群）；「登录某集群/机器」时扫描
`~/.ssh/config` Host 别名连接。

**凭证**：① GitHub SSH 私钥（公钥注册到 GitHub 账号）；② kubeconfig（集群
token/证书，本地路径 `$HOME/Documents/cluster-access/kubeconfig.yaml`，可用
`KUBECONFIG_PATH` 覆盖）。

### 4. Skill：local-service-hub

**作用**：本地服务面板——把为用户启动的本地 Web 服务（dev server、静态页、报告
预览、Web UI）登记到常驻面板（含 PID/状态/一键打开），并提供按会话的对话输入
统计页。

**端口策略**：面板绑定本机回环地址；端口由部署配置（环境变量 `DSH_SERVICE_HUB_PORT`
或参数指定），**未指定时自动绑定一个系统分配的可用端口**并打印实际地址；客户端与
面板通过 `DSH_SERVICE_HUB_URL` 对接。不写死任何固定端口。

### 5. Skill：session-cloud-sync

**作用**：会话记录云端同步——新会话开始时在远端备份主机建立同名目录；每日定时
rsync 增量同步本地会话与工作目录到远端（本地保留）；结果推送到飞书日报群。

**凭证**：远端备份主机的 SSH 免密登录（`~/.ssh/config` Host 别名 + 已注册公钥）与
远端目录写权限；远端主机名与目录由使用者按实际配置（SKILL.md 内为占位符）。

### 6. Skill：record-browser-gif

**作用**：用内置浏览器录制 Web UI 交互演示 GIF（状态帧捕获 + 确定性编码），PR
需要时发布到 assets 分支。

**凭证**：无（本地浏览器；录制需要会话沙箱可写 Chromium 缓存目录）。

## 社区插件（新安装，同为适配层的一部分）

以下插件不在本目录内（从 npm 或 GitHub 安装进 profile），但它们是本适配层
**新增安装**的插件，同事部署时需一并安装（版本见 profile 补丁与安装命令）。

| 插件 | 作用 | 安装来源 | 凭证 |
|---|---|---|---|
| dshmarket | 设置页内的可视化插件市场：浏览/搜索/一键安装社区插件、分类筛选、一键更新与停用、主题切换与配置备份。1.38.1 起已适配新版 settings/slots API，直接可用 | `dsh plugin add dshmarket`（npm，1.38.1） | 无（GitHub 只读浏览） |
| dsh-better-sidebar | 右侧完整工作台：文件树/编辑器（md/json/csv/png/源码预览）、终端、Git（SCM）、内置浏览器，支持三方插件注册新 Tab。0.17.1 已适配新版 slots/agents API；唯一断点是 `settingsNamespace` 已从 `@deepseek-ai/dsh-settings` 删除，本目录随带 pnpm 补丁（`profile/patches/dsh-better-sidebar@0.17.1.patch`，已在 `pnpm-workspace.yaml` 挂接） | `dsh plugin add dsh-better-sidebar`（npm，0.17.1）+ patches | 无；SCM 绑定工作区根目录，终端依赖本机 shell |
| dsh-outline | 会话页实时大纲面板：用户问题 + Markdown 标题（1~6 级）大纲树，流式更新，点击定位、搜索、收藏 | `dsh plugin add dsh-outline`（npm） | 无 |
| @nanmicoder/dsh-agent-teams | ~~多智能体团队协作：自然语言组建队长/成员/带依赖任务，消息互通，Web 面板树形监控，成员为可续接子代理~~ **已从 profile 移除**：依赖新版上游删除的 `ctx.subagents.registerContinuableSetup` API（npm 最新 0.1.15 仍调用旧 API），无法加载。**已由官方 `@deepseek-ai/dsh-experimental-agent-team` + `dsh-experimental-tool-agent-team` 替代**（见下「官方 Agent Teams」） | `dsh plugin add @nanmicoder/dsh-agent-teams`（npm） | 无（成员使用会话模型路由） |
| @omdsh-dev/dsh-genui | 回复内生成式 UI：```dsh-ui 围栏渲染布局/展示/图表/表单/测验/mermaid/3D 场景与动作回传，40 种组件 | `dsh plugin add github:omdsh-dev/dsh-genui` | 无 |
| @dsh-external/dsh-visualize | 对话内可视化工具 + 技能：模型渲染交互式 HTML 卡片（Codex /visualize 语义） | `dsh plugin add github:Nagi-ovo/dsh-visualize` | 无 |
| dsh-ui-hub | UI 管家：官方/插件 UI 分区折叠、逐条开关、拖拽移动/改大小、碰撞避让与一键自动排布 | `dsh plugin add github:Han-1413141/dsh-ui-hub` | 无 |

安装后在 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 中确认全部
列入（`dsh plugin add` 会自动追加 bundle 层）。

## 官方 Agent Teams（替代 @nanmicoder/dsh-agent-teams）

新版上游自带官方多智能体团队实现（`packages/experimental/agent-team` +
`tool-agent-team`，experimental 不随官方 release 发布 npm 包）。本适配层把两者
**vendor 到 `deploy/omgwow-dsh/plugins/`**（构建产物 + 依赖改写为 registry 版本），
以 `file:` 依赖进 profile 并经 `cordis.patch.yml` 挂在 host 层：

- `@deepseek-ai/dsh-experimental-agent-team`：TeamService——roster、持久化成员信箱、
  共享任务 DAG（Typert remote：view/createTask/updateTask）。
- `@deepseek-ai/dsh-experimental-tool-agent-team`：模型可见工具
  `spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent`
  / `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`；
  成员经 `spawn`（默认）/ `fork` 子代理 provider 创建，队长会话发起。
- 无浏览器面板（官方包未发布客户端 UI）；状态经工具与 `team_task_*` 查询。
- 验证：8893 实测「2 人团队 + 带依赖任务 + 成员互相校对」全流程跑通。

## 插件市场一键安装（已验证）

dshmarket（1.38.1）在设置页提供可视化市场，其安装/卸载走「重调 dsh CLI →
pnpm 落盘 → bundle 热加载」链路，已在 8893 实测通过：安装 `dsh-prompt-polish`
（github 源）→ `ok: true, hot: true`，`activation.state = live`（无需重启），
package.json 与 bundles 落盘、客户端 bundle 行进入 boot payload；卸载同链路
`ok: true` 并清回 package.json。两个部署前置条件（本适配层的启动器已内置）：

1. **实例进程 PATH 必须含 pnpm**：market 子进程继承宿主 PATH 后重调
   `node --import tsx/esm …/bin.ts plugin add`；本机 pnpm 在
   `dsh-v2/tools/pnpm`，`tooling/start-new-instance.sh` / `start-dsh-v2.sh`
   已把该目录加入 PATH。
2. **pnpm 构建脚本放行**：`profile/pnpm-workspace.yaml` 的 `allowBuilds`
   已放行 `node-pty`（侧边栏终端）；安装其他带构建脚本的第三方插件时，
   market 会提示「放行构建脚本并重试」，按其提示操作即可。

注意事项：market 路由带同源校验（浏览器正常，脚本调用需带 Origin 头）；
有 agent 正在运行时拒绝安装（409，防止改插件文件打断进行中的会话）。

## profile 补丁（profile/cordis.patch.yml）

- `llm-pi-ai` 的 Token Router 路由：7 个模型（claude-fable-5 / gpt-5.6-sol /
  kimi-k3 / claude-opus-5 / glm-5.3 / deepseek-v4-pro / deepseek-v4-flash），
  `api: openai-completions`、`mergeUserMessages: true`；4 个视觉模型声明
  `input: [text, image]`。
- 挂载 `dsh-tokenrouter-cost`。

## 部署步骤（同事版）

1. 克隆本仓库并检出适配分支；`pnpm install`；若为源码快照先 `pnpm run build`。
2. 准备密钥文件（见 `docs/CREDENTIALS.md`），不得提交到仓库。
3. 安装自研插件：
   `pnpm dsh plugin --profile web add file:$PWD/deploy/omgwow-dsh/plugins/dsh-tokenrouter-cost`
4. 将 `deploy/omgwow-dsh/profile/cordis.patch.yml` 合并到
   `$DSH_HOME/profiles/web/cordis.patch.yml`（按需替换 Token Router baseURL）。
5. 用 `deploy/omgwow-dsh/launcher/start.sh` 启动（设置 `KEY_DIR` / `CHECKOUT` /
   可选 `PORT`）。
6. 自研 skills 安装到工作区 `.dsh/skills/`（路径已参数化为 `$HOME`）。
