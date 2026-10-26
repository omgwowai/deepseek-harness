# @tokenrouter/dsh-telemetry

DeepSeek Harness（DSH）插件。它把 DSH 会话的结构上报给 TokenRouter，TokenRouter 据此在控制台「请求详情 → 会话树」里重建整棵代理树，并把每次模型调用对到它在 Router 上的那条请求记录。

覆盖范围：

- 主代理、子代理（`subagent` 和 `subagent_fork`），以及 Web 端分叉出的会话
- 每次模型调用（含失败的尝试和重试）、工具调用、MCP 调用
- 上下文压缩和错误

DSH 0.2.0-rc.2 自带的遥测只在用户提交反馈时才上传，而且上传的是事件全文。所以 TokenRouter 用这个插件做持续、只含结构信息的上报。

## 安装

> 在本插件包里，它是 `dsh-agent-dag` 的子插件：在包根目录运行 `node install.mjs --plugins agent-dag`（或不带 `--plugins` 全装）就会一并安装，不需要下面的 `dsh plugin add`。下面的 tgz 安装方式用于单独安装。

DSH 的 `dsh plugin` 命令用 pnpm 安装插件，PATH 上没有 pnpm 时要先装一个：

```bash
npm install -g pnpm
```

只在一个 profile 里用，直接按地址安装：

```bash
dsh plugin --profile tui add https://tokenrouterv2.omgwow.tech/docs/dsh-telemetry-0.3.2.tgz
```

在多个 profile 里用（比如 `tui` 和 `headless`），就先下载一次，再按绝对路径给每个 profile 安装：

```bash
curl -fsSLo ~/.dsh/dsh-telemetry-0.3.2.tgz https://tokenrouterv2.omgwow.tech/docs/dsh-telemetry-0.3.2.tgz
dsh plugin --profile tui add ~/.dsh/dsh-telemetry-0.3.2.tgz
dsh plugin --profile headless add ~/.dsh/dsh-telemetry-0.3.2.tgz
```

- 多个 profile 不能都按地址装。pnpm 10 会把第一次下载的远程 tarball 存进共享 store，第二个 profile 复用它时没有校验值，会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`。按本地路径安装不受影响。下载的文件要保留，`dsh plugin install` 修复依赖时还会用到它。
- 常用的 profile 有 `tui`、`web`、`headless`、`sdk`。
- 包里声明了 `dsh.bundle`，装好就自动启用，不用改 `cordis.patch.yml`。
- 包没有发布到 npm 仓库，用的就是上面这个 TokenRouter 提供的 tarball，不需要配置 registry。
- 包没有运行时依赖，要求 Node ≥ 20.3（DSH 自身已满足）。
- 从旧版本（例如 0.3.1）升级：对每个 profile 重新执行上面的安装命令即可，新版本直接替换旧版本，不用先卸载；改完重启 DSH。只有一个 profile 时可以按地址装；有多个 profile 时同样要先下载 `dsh-telemetry-0.3.2.tgz`，再按路径给每个 profile 装，第二个 profile 按地址升级也会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY` 并停在旧版本。旧版本的 tarball 继续保留。
- 不用另配 Key：DSH 的模型请求发往 TokenRouter（`https://tokenrouterv2.omgwow.tech`）时，插件上报用的就是这些请求自己带的 Key（`x-api-key` 或 `Authorization: Bearer`），从第一个模型请求起生效。模型请求走别的地址时，见下面的 `TOKENROUTER_API_KEY`。

装好后照常使用 DSH。查看结果有两种方式：

- 控制台：在「请求详情」打开这次会话里任意一条请求，看「会话树」。
- 接口：直接请求下面这个地址，用同一个 Key。

```bash
curl -H "Authorization: Bearer $TOKENROUTER_API_KEY" https://tokenrouterv2.omgwow.tech/v1/otel/sessions/<DSH 会话 ID>
```

DSH 会话 ID 就是 `$DSH_HOME/sessions/<工作区>/` 下的目录名（`$DSH_HOME` 默认 `~/.dsh`）。

卸载：

```bash
dsh plugin --profile tui remove @tokenrouter/dsh-telemetry
```

## 配置

| 环境变量 | 作用 |
|---|---|
| `TOKENROUTER_API_KEY` | 可选。上报用的 TokenRouter Key，作为 `Authorization: Bearer` 发送。<br>不设置时，插件使用 DSH 发往 TokenRouter 的模型请求所带的 Key（只在接收端与模型路由是同一地址时）；第一个模型请求之前产生的记录在队列里等它。<br>模型请求不走接收端地址（例如经 `TOKENROUTER_BASE_URL` 指向内网地址）又没设置它时，插件只加请求头，不上报。 |
| `TOKENROUTER_OTEL_URL` | 可选。接收端地址，默认 `https://tokenrouterv2.omgwow.tech/v1/otel`。<br>插件会自动在后面拼上 `/v1/logs`；直接写完整的 `…/v1/logs` 地址也可以。 |
| `TOKENROUTER_BASE_URL` | 可选。DSH 模型路由使用的 TokenRouter 地址，只取其中的协议、主机和端口。<br>默认与接收端相同（`https://tokenrouterv2.omgwow.tech`）。模型请求走别的地址（例如内网 IP）时设置它，否则那些请求不会带下面的请求头。 |

如果需要覆盖默认配置，可以在 profile 的 `cordis.patch.yml` 里改这一行：

```yaml
- id: tokenrouter-telemetry
  config:
    url: https://tokenrouterv2.omgwow.tech/v1/otel
    exporter: { delayMs: 2000, maxQueue: 8192, shutdownMs: 3000 }
```

## 上报什么

上报格式是 OTLP/HTTP JSON 日志，gzip 压缩，发到 `…/v1/otel/v1/logs`。每条记录只带下面这些字段：

| 记录 | 何时产生 | 字段 |
|---|---|---|
| `tokenrouter.session.start` | 会话创建（时间取会话头的 `createdAt`） | `session.id`、`agent.id`（等于会话 ID）、`agent.name`（preset 名，或 `main` / `subagent` / `fork`）、`session.origin`（`main` / `subagent` / `fork`）<br>子代理和分叉另带 `parent.session.id`；用父会话内容做种子的会话（`subagent_fork`、Web / 桌面端“从这里分支”）再带 `forked_from_session_id`、`fork.kind=fork` 和 `fork.point`（种子长度 n：复制了父会话第 0…n−1 条事件，Web 端 `atSeq` = n−1）<br>`dsh.delegation_depth` |
| `tokenrouter.subagent.start` | 子会话在父会话的 `subagent` / `subagent_fork` 工具调用里创建时（只在运行中产生，会话日志里没有这条关系） | 子会话的 `session.id`、`parent.session.id`、`parent.agent.id`、`spawn.tool_call.id`（派生它的那次工具调用）、`dsh.subagent.tool`；分叉另带分叉来源和分叉点 |
| `tokenrouter.resume` | 会话被恢复（`--session-id`、Web / 桌面端重新打开）后 DSH 写下的不带标记的 `session/end-seed` | `fork.kind=resume`、`fork.point`（这条 `end-seed` 的 seq） |
| `dsh.chat` | 每条 `assistant/message`；失败的 `assistant/attempt` 也算一条，带 `error.type` | `gen_ai.operation.name=chat`、`gen_ai.response.id`（上游响应 ID，与 Router 记录对齐用）<br>请求模型、响应模型、提供方、各类 token 数<br>`duration_ms`：从 `step/start` 或重试开始算起<br>首 token 时间、`dsh.stop_reason` |
| `dsh.tool_result` | `tool/result`，与对应的 `tool/call` 配对 | 工具名、调用 ID、`dsh.tool.success`、`duration_ms`、`error.type`<br>MCP 工具（`mcp__<server>__<tool>`）另带 `mcp.server.name` 和 `mcp.tool.name` |
| `dsh.subagent.spawn` | 父会话的 `subagent/catalog` | `child.session.id`。会话日志不记录是哪次工具调用启动了它，这条记录也不带调用 ID；调用 ID 见 `tokenrouter.subagent.start` |
| `dsh.compaction.chat` / `dsh.compaction` / `dsh.compaction.prune` | 压缩 | 摘要请求的模型、提供方和 token 数；压缩耗时；是否失败 |
| `dsh.llm.retry`、`dsh.turn`、`dsh.agent.error` | 重试、回合结束、`agent/error` | 错误码（`error.type`）、HTTP 状态码、重试次数和等待时长、回合结束原因、错误类名 |

以下内容一律不读取、不发送：

- 消息内容、思考内容、工具参数和结果、文件路径、命令
- 提示词、系统提示、子代理任务标签、压缩摘要
- 错误消息原文、工作目录

TokenRouter 接收端还有一层按字段名剔除内容的保护。

同一条事件每次生成的记录完全相同。恢复会话（`--resume`、`--session-id`）时插件会重放该会话自己的历史，以便接上没结束的调用；重放出的记录与之前发过的记录一致，接收端按记录哈希去重，不会重复入库。分叉会话继承来的父会话前缀不会算到分叉头上。

## 模型请求头

插件在 DSH 发往 TokenRouter 的每个模型请求上加这些头（0.2.0 起前三个，0.3.0 起全部）：

| 请求头 | 值 |
|---|---|
| `x-tokenrouter-dsh-telemetry` | 插件版本，例如 `0.3.2`。TokenRouter 据此判断插件已安装。 |
| `x-session-id` | 发起这次调用的 DSH 会话 ID。子代理的请求带子代理自己的会话 ID。 |
| `x-tokenrouter-parent-session-id` | 父会话 ID，只有子代理和分叉会话的请求才有。 |
| `x-tokenrouter-forked-from-session-id`、`x-tokenrouter-fork-point`、`x-tokenrouter-fork-kind` | 用父会话做种子的会话：分叉来源、种子长度、`fork`。 |
| `x-tokenrouter-session-origin` | `main` / `subagent` / `fork`；标题生成请求为 `title`，压缩摘要请求为 `compaction`（按 DSH 自己的请求用途）。 |
| `x-tokenrouter-spawn-tool-call-id` | 子代理在本进程中被派生时，派生它的工具调用 ID。 |

- 只发给 TokenRouter：请求的协议、主机和端口必须等于 `TOKENROUTER_BASE_URL`（默认接收端地址）。其他服务一律不加；插件自己的遥测上报请求也不加。
- 路由配置里已经写了同名静态头（`llm-pi-ai` provider 的 `headers:`）时，以配置为准，插件不覆盖。
- 标题生成和上下文压缩的请求也带所属会话的 ID。
- 0.3.2 起，在工具调用里发出、DSH 自己没有给会话 ID 的模型请求，也带发起这次工具调用的代理的会话 ID。例如 Auto review（实验功能）审查工具调用的请求，以及把 Web 搜索地址指向 TokenRouter 时的搜索请求。
- 实现方式：DSH 没有逐请求加头的扩展点。插件在 `llm/stream` 上把每次模型调用放进一个 `AsyncLocalStorage` 上下文（`tools/pre-execute`、`tools/execute` 也放进所属代理的会话），再订阅 Node 内置 fetch（undici）的 `undici:request:create` 诊断通道，在请求发出前加头。DSH 0.2.0-rc.2 的 `dsh` 命令运行在 Node 上，模型请求走 Node 内置 fetch。运行时没有该通道（例如 Bun）时，插件在日志里警告一次，请求不带这些头，也拿不到请求的 Key：这时要设置 `TOKENROUTER_API_KEY` 才会上报。
- 请求头与 Key 无关：没有任何 Key 时也照样加头。

## 提示词缓存键（0.3.2 起）

发往 TokenRouter 的 OpenAI 协议请求（`POST …/chat/completions` 和 `POST …/responses`），请求体里没有 `prompt_cache_key`（没有这个字段、为 `null` 或空字符串）时，插件把它设成这次请求的 `x-session-id`。上游据此按会话命中提示词缓存。

- 请求体里已有 `prompt_cache_key` 时不改。DSH 的 `openai-responses` 路由自己就会填会话 ID，这时保持原样。
- 只改 JSON 对象形式的请求体；改写后 `content-length` 随之更新，其余字段不变。
- Anthropic Messages 请求、发往其他地址的请求、插件自己的遥测上报都不改。
- 会话 ID 超过 64 个字符时（OpenAI 对 `prompt_cache_key` 的长度上限）只发 `x-session-id`，不写进请求体。DSH 的会话 ID 是 36 个字符的 UUID，正常不会超过。
- 实现方式：诊断通道改不了请求体，所以插件替换了 `globalThis.fetch`。pi-ai 每次请求都新建 OpenAI SDK 客户端，客户端取的就是这时的全局 `fetch`。插件卸载时恢复原来的 `fetch`。

## 与 DSH 自带遥测的关系

- 插件不注册 `sessionTelemetry` 服务，也不使用 DSH 共享的 `SessionTelemetryCoordinator`。那个模块级游标会让 DeepSeek 的反馈上传漏掉历史。插件对每个会话维护自己的游标。
- 插件不影响 `DSH_TELEMETRY_DISABLED` 和官方 `session-telemetry-otel` 那一行配置。
- 每条事件在转换前都会经过部署方挂载的脱敏规则 `session-telemetry/record`，记录形状与官方实现一致，所以现有规则照样生效：
  - 规则抛出异常时，这条事件被扣下，不上报（fail-closed）。
  - 规则改写了 `body` 时，插件按改写后的内容生成记录。
  - 事件对象是冻结的，规则必须返回新对象，不能就地修改。

## 发送与失败处理

- 批量发送：队列中第一条记录入队 2 秒后发出；回合结束和会话销毁时立即发送。每批最多 512 条，同一时间只有一个请求在途。
- 重试：遇到 408、429、5xx 或网络错误时指数退避重试，遵守 `Retry-After`，每批最多尝试 6 次。
- 不重试：401/403 等错误直接丢弃这一批，并提示检查 Key。
- 队列上限 8192 条，满了以后丢弃新记录。
- DSH 退出时最多再花 3 秒发完剩余记录，超时就放弃。
- 插件不会向 DSH 抛出异常。每类失败只在 DSH 日志里警告一次。

## 已知限制

- 0.1.0 不加请求头，Router 侧记录没有会话 ID，只能靠响应 ID 对齐：DSH 记下的 `responseId` 就是 Router 在上游响应体里记录的消息 ID。0.2.0 起 Router 记录直接带会话 ID，响应 ID 对齐照旧保留。
- 压缩摘要请求没有响应 ID，按相同的 token 数和时间与 Router 记录对齐。
- 失败的尝试既没有响应 ID 也没有 token 数，会显示为「未对上 Router 记录」并带错误码。
- 在插件安装之前就已结束、之后也没再恢复的会话，没有数据。
