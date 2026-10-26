# DeepSeek Harness × TokenRouter 插件包

这个目录里是一组 DeepSeek Harness（DSH）插件和一个 skill。装好后，DSH 可以：

- 把 Mermaid 代码块直接渲染成图；
- 通过 ACP 或各家的原生协议接入 Claude Code、Codex、Oh My Pi，并在同一个工作区里继续它们的原生会话；
- 在每个会话旁边打开 Agent DAG 面板（整个会话家族的时间线、用量和 Context）；
- 让各个 code agent 共用同一套 skills。

所有插件都按 DSH profile 级 bundle 安装，适用于该 profile 下所有工作区的所有会话。实测环境是 DSH `0.2.1-rc.2`（Desktop 与 `dsh web` 两个 profile），macOS arm64；本分支的仓库代码基于上游 `0.2.1-rc.3`，插件不依赖仓库里的 DSH 源码。

| 目录 | 包名 | 用途 | 依赖 |
|---|---|---|---|
| `plugins/dsh-mermaid-pele` | `@local/dsh-mermaid-pele` | 在聊天里把 ` ```mermaid ` 代码块渲染成跟随主题配色的 SVG | 无 |
| `plugins/dsh-acp-adapter` | `@local/dsh-acp-adapter` | 把 Claude Code / Codex / Oh My Pi 接入 DSH，走 ACP 或各家的原生协议（基于 `@zaimokuza/dsh-acp-adapter` 的 fork） | 各 agent 的 CLI |
| `plugins/dsh-agent-dag` | `@local/dsh-agent-dag` | 原生会话导入、两级模型选择器、Agent DAG 页签、用量统计条、复制会话 ID、共享 skills、会话日志修复工具 | `dsh-acp-adapter`；Agent DAG 页签另需 Paseo `agent-dag` 面板服务 |
| `plugins/dsh-agent-dag/telemetry` | `@tokenrouter/dsh-telemetry` | Agent DAG 的子插件：把会话结构（不含内容）上报给 TokenRouter，控制台「会话树」靠它重建代理树。随 agent-dag 一起安装 | 模型请求走 TokenRouter，或设置 `TOKENROUTER_API_KEY` |
| `skills/mermaid-diagrams` | — | 结构类图（流程、时序、状态、ER、类、甘特、思维导图）优先输出 Mermaid 代码块；截图、照片、数据图表、界面草图等仍用正常图片输出 | 配合 `dsh-mermaid-pele` |
| `install.mjs` | — | 把上面的插件以 `link:` 依赖装进某个 DSH profile | Node ≥ 22、pnpm、npm |

## 快速安装

```bash
cd deploy/deepseek-harness-tokenrouter

# 1. 装进 Desktop profile（Web 用 --profile web）。--plugins 默认三个都装，agent-dag 会连同会话遥测子插件一起装；
#    --skill 同时安装 mermaid skill
node install.mjs --profile desktop --skill

# 2. 写入 ACP agent 路由和 Agent DAG 配置（只有用 acp / agent-dag 时才需要，见下文）
node plugins/dsh-agent-dag/configure.mjs --desktop \
  --panel-token-file <paseo-agent-dag>/plugins/agent-dag/.cache/web/token

# 3. 完全退出 DSH 再打开（dsh web 则重启进程），然后刷新一次 Web GUI
```

`install.mjs` 依次做这几件事：

1. 插件还没构建时先构建：`dsh-acp-adapter` 执行 `pnpm install --frozen-lockfile && pnpm build`，`dsh-agent-dag` 执行 `npm ci --omit=dev`。
2. 备份 `~/.dsh/profiles/<profile>/package.json`，写入 `"<包名>": "link:<绝对路径>"`，并加进 `dsh.profile.bundles`。fork 会替换掉已安装的 `@zaimokuza/dsh-acp-adapter` bundle。装 agent-dag 时同时写入会话遥测子插件 `@tokenrouter/dsh-telemetry`；之前用 tgz 装过的同名插件会被替换成这里的版本。不想上报遥测时加 `--no-telemetry`。
3. 在 profile 目录里执行 `pnpm install`。

插件是 link 进去的，所以之后改了这个目录、重新构建，重启 DSH 就会生效。先看会改什么可以加 `--dry-run`；只装其中一部分用 `--plugins mermaid` 或 `--plugins mermaid,acp`。设置了 `DSH_HOME` 时，脚本改的是那个 home 下的 profile。

卸载：在 DSH「插件」页停用，或者把对应包从 profile 的 `dsh.profile.bundles` 和 `dependencies` 里删掉，然后在 profile 目录重新执行一次 `pnpm install`。

---

## dsh-mermaid-pele：Mermaid 图渲染

**用途。** 聊天里所有 info string 是 `mermaid`（或 `mmd`）的代码块，都会用 [Pele](https://pele.run)（MIT，渲染 Mermaid 语法）原地渲染成 SVG：

- 图下方有「查看源码 / 查看图」可以来回切换，原文一直保留在 DOM 里；
- 代码块还在流式输出、或者语法有错时，照常显示代码块，不会报错弹窗；
- 不加载外部资源（`links: false, images: false`），图里只有形状和文字；
- 配色从 DSH 的 `--dsw-*` 设计变量映射到 Pele 的 `--pele-*` 变量，所以跟随亮色和暗色主题。

**使用。** 安装后不需要任何配置。模型回复里出现 ` ```mermaid ` 代码块就会显示成图。调试时在浏览器控制台执行 `window.__DSH_PELE_DEBUG = true` 再刷新页面。

**开发。** 改 `src/body.js`，然后运行 `node tools/build.mjs` 重新生成 `client.js`。不要重新缩进 `vendor/pele.global.js`，它里面多行模板字符串的缩进对解析器有意义。DOM 行为测试：`npm i jsdom` 之后运行 `node tools/dom-test.cjs`。详见 `plugins/dsh-mermaid-pele/README.md`。

## skills/mermaid-diagrams：结构类图优先用 Mermaid

**用途。** 这是一个偏好，不是禁令。Mermaid 能画的结构类图（流程图、架构图、时序图、状态机、ER 图、类图、甘特图、思维导图），让模型直接输出 ` ```mermaid ` 代码块，由上面的插件渲染，不再用 ASCII 字符画或自己画一张同样内容的图片。Mermaid 画不了、或者本身就是「画面」的内容，照常输出图片：截图（页面、终端、测试结果等视觉证据）、照片和生成的图片、有真实坐标轴的数据图（如 matplotlib）、界面草图、版式、几何和地图，以及用户明确要图片或文件的时候。skill 里有一张「Mermaid 还是图片」的判断表，也有保证 Mermaid 能渲染的写法规则（短标签、给含特殊字符的标签加引号等）。图要放进报告、幻灯片、PR 这类不渲染 Mermaid 的地方时，既保留 Mermaid 源码，也另外生成 SVG/PNG 文件。

**使用。** `install.mjs --skill` 会把它复制到 `~/.agents/skills/mermaid-diagrams`；已有同名目录时不会覆盖。这个目录是所有 code agent 共用的 skill 根目录（见下文「共享 skills」），所以 DSH 自己的 agent 和通过 ACP 接入的 agent 都能用到。

## dsh-acp-adapter：ACP Agent 接入（fork）

**用途。** 在 DSH 的会话 UI 里，通过 Agent Client Protocol 或各家的原生协议（见下）驱动 Claude Code、Codex、Oh My Pi。原生会话、工具审批、团队协作的行为与上游 `@zaimokuza/dsh-acp-adapter` `v0.2.1-rc.2.3`（MIT）一致。这个 fork 加了下面几项（详见 `plugins/dsh-acp-adapter/FORK.md`）：

- **原生轨迹记录**：ACP 回合里的每次工具调用，都会按真实时间写进 DSH 会话日志（`tool/call` + `tool/result`）。Shell 结果里是真实输出：超长时截断到 64 000 字节，非零退出码会标出。回合的 token 用量也会记下。所以 Trajectory 页签不需要事后回填。
- **Chat 里每次工具调用只显示一张卡片**：日志里已经有原生工具行时，sidecar 里的同一次调用不再重复显示。
- **团队桥接默认关闭**：配置项 `teamBridge` 默认为 `false`，ACP agent 只能看到它自己的工具。设成 `true` 恢复上游行为（注入 `dshteam_*` MCP）。桥接关闭时，会话菜单里不再显示只管 DSH 工具的「DSH 工具审批」。
- **权限只有一个入口**：ACP 会话的输入框里，agent 自己的权限模式显示为「<Agent> permissions · <模式>」（Claude Code：Manual / Accept edits / Plan / Auto / Bypass permissions；Codex：Read-only / Workspace access / Auto review / Full access；Oh My Pi：Default / Plan），点开即可切换：新建会话时在发第一条消息之前就能选（例如 Claude Code 选 Bypass permissions、Codex 选 Full access），已有会话在 agent 未连接时也能改；所选模式保存在 sidecar，在下一条消息发出前应用到 agent 会话。DSH 自己的「Access mode」不约束 ACP agent（agent 进程不受 DSH 沙箱管理），所以选中 ACP agent 时隐藏。新会话的可选模式取自该 agent 最近一次会话报告的模式列表，所以每个 agent 至少要先用过一次。
- **分支保留谱系**：在 DSH 里对 ACP 会话「Branch into a new conversation」时，从最新一轮分出的会话走 ACP 原生 fork（继承上下文），从更早一轮分出的会话新开 agent 会话。两种情况下，新会话的模型请求都带 `x-tokenrouter-forked-from-session-id` 等请求头，网关会话树里能看到它挂在原会话下。三个 agent 分别由 `claude-launch.mjs`（`--settings` 层，不会被用户 `settings.json` 覆盖）、`codex-launch.mjs`（`http_headers`）、`omp-link-headers.js`（`omp acp -e` 扩展）把请求头加上。
- **`/compact` 走 agent 原生压缩**：ACP 会话里输入 `/compact`，会作为斜杠命令原样发给 agent（不带 DSH 上下文前缀），由 Claude Code / Codex / Oh My Pi 自己压缩上下文；DSH 自带的压缩只适用于 DSH 自己的会话。
- **去掉了 ACP Diagnostics 会话页签**。宿主侧的诊断 API 和恢复面板保持不变。
- **没有可见文字的 `end_turn` 回合**：只要本回合有一次原生工具结果成功，就按「已完成」处理，不再报 `ACP_NO_VISIBLE_RESPONSE`。
- **原生传输**：团队桥接关闭（默认）时，agent 的启动命令是 Oh My Pi（`omp`）、Codex（`codex` / `codex-acp`）或 Claude Code（`claude` / `claude-agent-acp` / `claude-launch`），适配器直接用厂商的原生协议驱动 agent 进程（`omp --mode rpc-ui` 的 JSONL、`codex app-server` 的 JSON-RPC、Claude Code 的 stream-json），再以和各家 ACP 桥相同的会话 id、配置项 id、模式 id 和工具调用字段回报给 DSH 运行时。所以已有的 sidecar 绑定、已保存的权限模式和模型选择器照常可用，同时支持会话进行中途的引导消息（steer），并上报用量和上下文占用。其余命令，以及设了 `teamBridge: true` 的 profile（原生传输不承载 DSH 的 MCP 工具），仍走 ACP。选择逻辑见 `src/runtime/native/transports/contract.ts` 的 `selectNativeTransportKind` 和 `src/host/composition/installed-profile-registry.ts`，用例在 `test/native/`。

**使用。** 用 `install.mjs` 安装后，要在 profile 的 `cordis.patch.yml` 里给 `dsh-acp-adapter` 配置 `agents`，包括每个 agent 的启动命令、参数和 env。用 TokenRouter 时由 `configure.mjs` 生成（见下一节）。也可以按上游 README（`plugins/dsh-acp-adapter/README.md`）手写。配好后，在输入框的模型选择器里选 Claude Code / Codex / Oh My Pi 的模型就能开会话。

**开发。** 在 `plugins/dsh-acp-adapter` 目录里运行 `pnpm install --frozen-lockfile && pnpm build`（Node `^22.19 || >=24`）。单元测试用 `pnpm test`（原生传输的用例在 `test/native/`）。跟进上游版本的步骤见 `FORK.md` 的「Rebase procedure」。

## dsh-agent-dag：多 agent 会话、模型与 Agent DAG

**用途。** 这个插件分宿主端（`index.js`）和浏览器端（`client.js`）两部分：

| 功能 | 说明 |
|---|---|
| 原生会话导入 | 扫描 Claude Code（`~/.claude/projects`）、Codex（`~/.codex/sessions`、`archived_sessions`）、Oh My Pi（`~/.omp/agent/sessions` 等）的会话，通过 DSH 自己的持久化服务导入成 DSH v4 会话，放进对应目录的工作区，并记录 ACP 绑定。在 DSH 里继续这些会话时，接着写的就是原生 transcript。导入是幂等的：每个原生会话只对应一个 DSH 会话。刚出现两分钟内的原生会话不导入，留给 ACP adapter 绑定，避免分支、新会话被重复导入。 |
| 会话归属标记 | 侧边栏每个会话行和会话标题前，用 A / C / O / D 标明它属于 Claude Code / Codex / Oh My Pi / DeepSeek Harness。 |
| 复制 ID | 会话标题右侧有「复制 ID」（DSH 会话 ID）和「复制原生 ID」（ACP 绑定的原生 agent 会话 ID）两个按钮。 |
| 两级模型选择器 | 输入框的模型选择器先选 agent（DSH 本身或某个 ACP agent），再选该 agent 的模型和推理强度。切换 agent 或模型时，推理等级只在同一 agent 内保留，否则选该模型支持的 high / medium / low，避免把一个 agent 的等级带给不支持它的另一个 agent。 |
| Code agent 模型面板 | 在「设置 → 模型」和插件页里读写每个 agent 的默认主模型和子代理模型（DSH 的 profile patch、Claude 的 `settings.json`、Codex 的 `config.toml`、Oh My Pi 的 `config.yml`）。写之前先备份原文件；新会话生效。 |
| 用量统计条 | 输入框底部显示本会话家族的 token、缓存命中率、TTFT / 解码速度和费用。经 TokenRouter 的会话还会显示当前网关通道。 |
| Agent DAG 页签 | 会话的 Chat / Trajectory 旁边多一个 Agent DAG 页签，内嵌本机 Paseo `agent-dag` 面板（`http://127.0.0.1:6795/`）。面板里有时间线、结构、计划与约定、通信、用量、速率、工具、Context 几个页签，可以在新窗口打开。 |
| 共享 skills | `~/.agents/skills` 是所有 agent 共用的 skill 根目录。DSH、Codex、Oh My Pi 原生就读这个目录。Claude Code 只读自己的 `skills` 目录，所以插件把每个共享 skill 软链接过去：同名的已有目录不动，共享 skill 删除后，插件建的链接也会删掉。`cordis.patch.yml` 还让 DSH 自己的 agent 读取 `~/.claude/skills`、`~/.codex/skills`、`~/.omp/agent/skills`。 |
| 会话日志修复工具 | `repair-imported-logs.mjs`、`rebuild-imported-logs.mjs`、`refresh-binding-fingerprints.mjs`，见下文「维护脚本」。 |

**前置条件。**

- 已安装 `dsh-acp-adapter`。
- `configure.mjs` 从 Paseo 的 provider 配置 `~/.paseo/config.json` 里读取 `claude-tr` / `codex-tr` / `omp-tr` 三个 provider 的启动命令和 TokenRouter env（只读，不修改）。这三个 provider 由 [omgwowai/paseo-deploy](https://github.com/omgwowai/paseo-deploy) 的 local-mac 流程生成。
- 只有 Agent DAG 页签和网关通道显示需要 Paseo 的 `agent-dag` 插件在本机 `127.0.0.1:6795` 提供面板。它的访问 token 文件在 `<paseo-agent-dag>/plugins/agent-dag/.cache/web/token`。不装 Paseo 时，其他功能照常可用，页签里会显示不可用的原因。

**配置。**

```bash
node plugins/dsh-agent-dag/configure.mjs [--desktop] \
  [--panel-token-file <token 文件>] [--panel-url http://127.0.0.1:6795/]
```

- 不加 `--desktop` 时配置 `web` profile。
- 写入前把整个 profile 目录备份到 `$DSH_HOME/backups/`。
- 往 profile 的 `cordis.patch.yml` 写两条配置：`dsh-acp-adapter.agents`（三个 agent 的命令和 env；工具审批默认 `ask`）和 `dsh-agent-dag`（`tokenFile`、`panelUrl`、`externalRoots`、`nativeHomes`）。
- 文件权限设为 `0600`，因为 agent 的 env 里有 TokenRouter Key。
- agent 的 `PATH` 会去掉每个 shell 各不相同的临时目录，所以在哪个终端运行，结果都一样。
- token 文件也可以用 `AGENT_DAG_TOKEN_FILE` 环境变量指定；面板地址用 `AGENT_DAG_URL`。再次运行时，沿用 patch 里已有的值。
- 设置 `PASEO_AGENT_DAG_ROOT` 后，模型面板改默认模型时，会把新值同步写回 `<root>/config/models.json`（Paseo apply 的源）；不设置时，面板会提示下次 apply 可能把这个值还原。
- `--scratch` 配合一个隔离的 `DSH_HOME`，用于测试：生成隔离的 agent home，不碰真实的 `~/.claude` / `~/.codex` / `~/.omp`。

`dsh-agent-dag` 的其他配置项：

- `liveTools`：默认开启。开启时，回合结束后从原生 transcript 补写工具行。配合这个 fork 的 adapter 时应设为 `false`，因为 adapter 已经自己记录了。
- `sharedSkillsDir`：共享 skill 根目录，默认 `~/.agents/skills`。

**维护脚本。** 不加 `--apply` 时只报告，不改任何东西。加 `--apply` 时：先把原文件备份到 `--backup-dir`；再拿会话的 flock 锁，正在被 DSH 打开的会话会跳过；最后原子替换。

| 脚本 | 场景 |
|---|---|
| `repair-imported-logs.mjs [--apply --backup-dir D] [session-id…]` | 修复早期导入器写出、DSH 加载时报 `stored session … is corrupt` 的日志。两种情况：assistant 消息缺 `data.stream`，或者 `fallback` 标题的 `messageSeqs` 为空。导入后用户续写的事件原样保留。 |
| `rebuild-imported-logs.mjs [--apply --backup-dir D]` | 用当前导入器按原生 transcript 重建导入的会话日志。 |
| `refresh-binding-fingerprints.mjs --profile <patch> --sidecar <sidecar.sqlite> [--apply] [--adapter <dir>]` | agent 启动配置（命令、env、PATH）改了以后，重算 ACP 绑定里保存的启动指纹。否则继续旧会话时，adapter 会以 `profile-changed` 为由拒绝。脚本默认到 profile 的 `node_modules/@zaimokuza/dsh-acp-adapter` 里找适配器的指纹模块；装的是本目录的 fork 时加 `--adapter <profile>/node_modules/@local/dsh-acp-adapter`（需要已构建出 `lib/`）。 |

`meter.bundle.js`、`native.bundle.js` 是 Paseo `agent-dag` 插件服务端代码（会话读取、家族计算、计量）的构建产物，由那边的 `node dsh/build.mjs` 生成，不要手改。测试：`node --test tests/*.test.mjs`。

## 会话遥测：Agent DAG 的子插件

**用途。** `plugins/dsh-agent-dag/telemetry` 是 TokenRouter 的会话遥测插件 `@tokenrouter/dsh-telemetry`（0.3.2，与 TokenRouter 仓库 `clients/dsh-telemetry` 和网关文档站发布的 tgz 内容一致）。它把 DSH 会话的结构上报给 TokenRouter：主代理、子代理和分叉会话，每次模型调用（含失败和重试）、工具调用、MCP 调用、上下文压缩和错误。只上报结构和计时，不上报提示词、回复或工具输出。TokenRouter 用这些在控制台「请求详情 → 会话树」里重建整棵代理树，并把每次模型调用对到网关上的请求记录。它还会给发往 TokenRouter 的模型请求加上 `x-session-id` 请求头。

Agent DAG 在本机看会话家族，会话遥测让网关那边也能看到同一棵树，所以两者一起安装：`install.mjs` 装 agent-dag 时会把它作为单独的 DSH bundle 一并 link 进 profile，不需要再单独执行 `dsh plugin add`。

**配置。** 一般不用配：DSH 的模型请求发往 TokenRouter（`https://tokenrouterv2.omgwow.tech`）时，上报直接用这些请求自己带的 Key。其他情况用环境变量：

| 环境变量 | 作用 |
|---|---|
| `TOKENROUTER_API_KEY` | 模型请求不走 TokenRouter 默认地址时，上报用的 Key。不设置又不走 TokenRouter 时，插件只加请求头，不上报 |
| `TOKENROUTER_OTEL_URL` | 接收端地址，默认 `https://tokenrouterv2.omgwow.tech/v1/otel` |
| `TOKENROUTER_BASE_URL` | 模型请求实际使用的 TokenRouter 地址（例如内网地址），用于识别哪些请求要加请求头 |

查看结果：在 TokenRouter 控制台「请求详情」里打开这次会话的任意一条请求，看「会话树」。字段明细、接口和排障见 `plugins/dsh-agent-dag/telemetry/README.md`。

**范围。** 这个子插件只覆盖 DSH 自己的 agent。通过 ACP 接入的 Claude Code、Codex、Oh My Pi 是独立进程，它们的会话遥测由各 agent 自己的 TokenRouter 配套客户端负责（paseo-deploy 的 local-mac 流程会装好），本目录不安装那些客户端。

## 安全与隐私

- 仓库里没有任何真实的 Key、token 或个人路径（适配器的脱敏测试里有明显是假的样例值，例如 AWS 文档里的示例 Key）。TokenRouter Key 只在本机由 `configure.mjs` 从 Paseo 配置复制进 profile patch，文件权限是 `0600`。会话遥测子插件从环境变量或模型请求读取 Key，不写进任何配置文件。
- 网络访问：`dsh-agent-dag` 只访问本机（读各 agent 的会话文件，向 `127.0.0.1` 上的 Paseo `agent-dag` 服务查询网关通道）；会话遥测子插件向 TokenRouter 接收端上报不含内容的会话结构。
- Agent DAG 面板只接受 `127.0.0.1` 上的 HTTP 地址。访问 token 放在 URL fragment 里，不会进服务端日志。
- 修改用户配置文件（profile manifest、agent 配置文件）前都会先备份。

## 这些目录是怎么来的

这里的插件都是从实际运行的工作副本导出的源码，不是独立开发的代码库：

| 目录 | 来源 |
|---|---|
| `plugins/dsh-acp-adapter` | `@zaimokuza/dsh-acp-adapter` `v0.2.1-rc.2.3` 的 fork 仓库（原生工具行、权限入口、原生传输等）。导出的是 `git ls-files -co --exclude-standard` 的文件，不含 `lib/`、`node_modules/`、`.local/` 和构建日志 |
| `plugins/dsh-agent-dag` | Paseo 仓库里的 `plugins/dsh-agent-dag`。`configure.mjs`、`models.js` 在这里去掉了对 Paseo 目录结构的假设 |
| `plugins/dsh-mermaid-pele` | 本机 `~/.dsh/plugins/dsh-mermaid-pele`。不含带机器路径的 `install-desktop.sh`，README 按 `install.mjs` 的用法改写 |
| `plugins/dsh-agent-dag/telemetry` | `@tokenrouter/dsh-telemetry@0.3.2` 发布包的内容。它的 `lib/` 就是运行时源码，靠本目录 `.gitignore` 里的例外保留（仓库根的规则会忽略所有 `lib/`） |
| `skills/mermaid-diagrams` | `~/.agents/skills/mermaid-diagrams` |

本目录自己维护的文件是 `README.md`、`install.mjs`、`.gitignore`、`plugins/dsh-agent-dag/configure.mjs` 和 `models.js`，以及 mermaid 与遥测两个插件的 `README.md`；其余内容跟随上面的来源更新。本目录不在 pnpm workspace 里，仓库根的 `pnpm install`、类型检查和测试都不会碰它；`scripts/` 里 `verify-concrete-terms`、`verify-repository-references`、`verify-translation-pairing` 这三个全仓库扫描的门禁把它排除在外。

## 第三方许可

- Pele 1.7.0：MIT，© Obsidian，见 `plugins/dsh-mermaid-pele/vendor/pele.LICENSE` 和 `NOTICE.md`。
- `dsh-acp-adapter` 基于 [zaimokuza-yoshiteru/dsh-acp-adapter](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter)：MIT，见 `plugins/dsh-acp-adapter/LICENSE`。
- `dsh-agent-dag` 运行时依赖 `@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`、`yaml`，安装时从 npm 获取，不随仓库分发。
- 会话遥测子插件 `@tokenrouter/dsh-telemetry` 来自 TokenRouter 仓库 `clients/dsh-telemetry`，`package.json` 里的许可声明是 `UNLICENSED`，没有运行时依赖。
