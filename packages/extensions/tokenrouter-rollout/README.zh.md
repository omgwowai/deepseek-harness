# dsh-tokenrouter-rollout

[English](README.md) | 中文

决策点 rollout 加 SOTA judge。在决策边界（`/rollout` 命令，或某个 milestone 完成且还有下一个待办时），本插件在廉价 worker 模型——dsh 已经选定的 deepseek 路由——上并行跑 N 条多样化 trajectory，再让 SOTA judge 模型（默认 `claude-opus-5`，已验证的备选包括 `gpt-5.6-sol`）给这些方案打分并挑出胜者。获胜方案经 steering（中途引导）回到 agent（智能体）会话中作为工作决策，因此 SOTA token 只花在评审上，不花在生成上。

judge 端点不随包发布：`judgeBaseURL` 没有默认值，已启用却缺少该值的插件会在加载时失败（组合方式）或以一条消息拒绝该轮（设置方式）。把它指向任意 OpenAI 兼容网关即可。

## 服务

`ctx.tokenRouterRollout` —— 一个 `TokenRouterRollout` 服务，拥有轮次生命周期。

| 成员 | 用途 |
|---|---|
| `config` | 生效配置（已折叠 settings）。 |
| `roundSignal` | 分离轮次共享的取消信号；插件卸载时中止。 |
| `runRound(agent, trigger, decision, signal)` | 跑完一轮：并行 worker → judge → steering 送入胜者。 |

一轮的存活时间长于发起它的那个轮次，因此两种触发方式都传 `roundSignal` 而非调用方的信号——UI 请求的信号在响应关闭时就会中止，那时第一个 worker 还没给出答复。

## 事件

| 会话事件 | 载荷 | 触发时机 |
|---|---|---|
| `rollout/start` | `{ trigger, decision, count }` | 一轮已开启。 |
| `rollout/trajectory` | `{ index, provider, model, slot, summary, ok, outputTokens? }` | 一个 worker 已结算。 |
| `rollout/selected` | `{ best, judgeModel, scores[], judgeOutputTokens? }` | judge 已选出胜者。 |
| `rollout/error` | `{ trigger, reason }` | 该轮在选出胜者前失败。 |

## 投影

`rolloutStats`（组合时经会话投影 seam 注册）：全日志范围的轮数、trajectory、胜者分数，以及 worker 与 judge 的 token 数字——会话详情统计面板背后的数据。

## 扩展点

- `ctx.commands` `/rollout` —— 手动触发（UI 按钮与斜杠命令）。
- `session/event` `todo/write` —— milestone 边界检测（某个 milestone 完成且留有待办的下一项时自动触发）。该事件流是全局的，因此 watcher 会忽略 header 中记录 `origin: 'subagent'` 的会话；没有这道判断，一轮自己的 worker 会再派生出新的轮次。

## 配置

启用之后除 `judgeBaseURL` 外全部可选；`enabled: false` 期间插件不产生任何作用。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关。 |
| `rolloutCount` | `3` | 每轮并行的 trajectory 数。 |
| `judgeModel` | `claude-opus-5` | 端点上的 SOTA judge 模型 id。 |
| `judgeBaseURL` | 无（启用后必填） | OpenAI 兼容的 judge 端点。 |
| `judgeApiKeyEnv` | `DEEPSEEK_API_KEY` | judge 密钥所在的环境变量。 |
| `workerProvider` | `deepseek-official` | worker 的提供方路由。 |
| `workerSubagentProvider` | `fork` | 运行 worker 的 subagent 提供方。 |
| `workerModels` | `[]` | worker 模型池；为空则用 agent 自身的模型。 |
| `diversitySlots` | conservative / thorough / creative | 每条 trajectory 的提示词策略。 |
| `workerTimeoutMs` | `600000` | 单个 worker 的超时。 |
| `judgeTimeoutMs` | `180000` | judge 调用的超时。 |
| `maxPlanChars` | `12000` | 单个方案送入 judge 的字符上限。 |
| `autoMilestone` | `false` | milestone 完成时自动触发。 |
| `maxContextChars` | `4000` | 决策上下文的字符上限。 |
| `judgeSystemPrompt` | 内置 | 覆盖 judge 提示词。 |

多样化发生在提示词层面。子 agent 经 `AgentOptions` 路由，而它只携带提供方、模型和 token 上限，不携带采样参数，因此一个 slot 改变的是问 worker 什么，而不是采样器怎么工作。

设置分节（`tokenrouter-rollout`）拥有 `enabled`、`rolloutCount`、`judgeModel`、`judgeBaseURL`、`workerModels` 和 `autoMilestone`。分节里 `judgeBaseURL` 为空时保留组合中已有的值，因此已提供端点的部署不会被从未设置过该项的用户清空。

## 模型体验

### worker 规划提示词（每条 trajectory）

#### 模型看到的内容

每个 worker subagent 收到下面这段字面文本，其中 `{context}` 替换为决策上下文，并按 `maxContextChars` 截断。带 strategy 的多样化 slot 会追加 `\n\nSTRATEGY GUIDANCE: <strategy>`。由 milestone 触发的上下文还会在 `RECENT WORK TRAIL (for context):` 标题下携带最近三条 assistant 文本输出，每条上限 600 字符。

##### worker 提示词原文

```markdown
You are one of several parallel planning agents working on the same
decision. Produce a COMPLETE, self-contained plan for the decision below, as
markdown starting with a "# " heading that names the plan. Do not ask for
clarification; make reasonable assumptions and state them. End with a short
"## Rationale" section explaining the key trade-offs you chose.

DECISION CONTEXT:
{context}
```

#### Token 影响

按条件触发且成倍增长：每条 trajectory 一次 worker 运行（`rolloutCount`，1–8），每次都是廉价 worker 路由上的一个完整 subagent 轮次。提示词本身固定；上下文按 `maxContextChars` 封顶。

#### KV Cache 影响

独立：每个 worker 都是单独的子请求。`fork` 提供方用父级已完成轮次的历史给每个子级做种，因此同一轮的 worker 之间以及它们与父级之间共享该前缀，而各不相同的 strategy 后缀位于提示词末尾。

### judge 评分请求

#### 模型看到的内容

每轮向配置的 OpenAI 兼容端点发一次请求，走在本框架自己的 LLM（大语言模型）seam 之外。系统提示词是下面这段字面文本（`judgeSystemPrompt` 可替换它），第二次尝试时再加一段重试后缀。user 消息携带决策上下文以及仅 `ok` trajectory 的方案，每个按 `maxPlanChars` 截断；失败 worker 的错误详情绝不会送到 judge。

##### judge 系统提示词原文

```markdown
You are a senior engineering evaluator. Given a task and candidate plans, score each plan 0-100 on completeness, feasibility, cost, and risk. Respond with STRICT JSON only, no markdown fences, exactly this shape: {"scores":[{"index":0,"score":85,"reasoning":"..."}],"best":0,"summary":"..."}
```

#### Token 影响

固定为每轮一次调用，响应不是合法 JSON 时最多重试一次。输入由 `rolloutCount × maxPlanChars` 封顶；输出是一份评分表。

#### KV Cache 影响

独立：judge 调用发往单独的端点，与 agent 自身的请求不共享任何前缀。

### 被送入的获胜方案

#### 模型看到的内容

一轮结算并选出方案后，agent 会收到一条带两个文本块的 user 消息：先是 `[rollout] …` 说明行，写明 trajectory 数量、触发方式、judge 模型、各条 trajectory 的分数与获胜方案摘要，随后是 `## Selected plan` 和胜者全文。投递方式是 `steer` 而非 `inject`：一轮要跑好几分钟，那时 driver 通常已空闲，而注入的上下文会一直等一个此处不会产生的唤醒。

#### Token 影响

长期保留：说明行与获胜方案全文作为一条普通 user 消息留在会话中，计入之后的每一次请求。

#### KV Cache 影响

仅追加：该消息落在对话末尾，因此已缓存的前缀仍可复用，下一次请求在其之上延长。

## 已知限制与暂缓事项

- **一轮能活过它的触发者，但活不过一次重载** —— 轮次只由插件卸载取消，因此 `/rollout` 在派发它的 UI 请求关闭之后仍继续；没有办法在不卸载插件的前提下取消单独一轮，进程退出时进行中的轮次也就丢失了。
- **worker 方案不会完整持久化** —— 只有摘要与分数落入会话日志；获胜方案全文经被送入的 user 消息投递（该消息会记录），落败方案则只存在于 worker 会话中。
- **单 judge 加一次重试，没有集成投票** —— 第二个 judge 模型或多数投票属于暂缓事项；judge 调用是每轮唯一的 SOTA token 开销，两次都失败则退化为确定性选择（在 `ok` trajectory 中取最长的完整方案）。
- **milestone 检测依据 `todo/write` 的状态差分** —— 某次写入在完成一个 milestone 的同时也把最后一项 todo 标记为完成（没有待办的下一项）时不会触发，这是有意为之；最近工作轨迹的上下文上限为最近三条 assistant 输出。
- **多样化无法改变采样** —— 每条 trajectory 各自的 temperature 需要在每个子级上走 `agent/request` waterfall（瀑布式事件）；在那之前，slot 之间只有提示词策略的差别。
