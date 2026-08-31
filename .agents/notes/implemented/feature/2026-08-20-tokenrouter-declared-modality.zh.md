# Agent Note: 面向聚合网关的模态声明

Status: implemented

[English](2026-08-20-tokenrouter-declared-modality.md) | 中文

## Problem

rc8 为 pi-ai 路由和[直连 DeepSeek 适配器](2026-08-20-unified-image-request-pipeline.zh.md)加入了图像输入，两者都从精确模型的元数据读取模态。当端点由单一供应方拥有时，这份元数据是可信的。tokenrouter 网关打破了这个前提：它用一个 OpenAI 兼容 URL 复用多家供应方，因此 pi-ai 基于 URL 的识别无法认出它，会把它当作 OpenAI 本身来寻址，从而继承错误的兼容开关，也拿不到可用的模型列表。

更难的问题是网关不上报能力。用纯文本模型发送带 `image_url` 的请求会返回 HTTP 200，并给出一段仅凭文本写成的流畅回答——图像被丢弃，没有告警、没有错误，也没有可据以判断的字段。让 `deepseek-v3.2` 说出四个色块的颜色时，它凭空编出了一个「色彩和谐轮」。因此，信任端点的组合会产出与成功识图完全一样的、语气自信的幻觉。

## Decision

`apps/cli/config/examples/tokenrouter-vision/cordis.yml` 把网关组合为一个 pi-ai provider，其每一项线缆事实都是声明而非推断：`api: openai-completions`、显式的 `baseURL`、`compat.supportsDeveloperRole: false` 与 `compat.maxTokensField: max_tokens`，以及逐模型的目录。凭据以引用形式给出（`apiKeyEnv: DSH_TOKENROUTER_API_KEY`），绝不内联密钥。出厂组合已经以休眠方式挂载 `llm-pi-ai` 与 `attachment-local`，因此该覆盖层只需提供唤醒此路由的 provider 配置，并重新指向 `agent-default-model`；缺少这个持久化图像后端时，携带图像的请求会以 `UNSUPPORTED_CONTENT` 失败。调用方式由[用户指南](../../../../docs/user/guide/tokenrouter-vision.zh.md)负责说明。

每个模型的 `input` 列表记录的是**经实测验证**的模态，而非其宣称的模态。在这把密钥上，有六条路由会接受图像部分并静默丢弃；`deepseek-v3.2` 正因如此被声明为 `input: [text]`。路由级的 `defaultInput: [text]` 让未声明的模型保持「盲」，因此后续新增的模型会向安全侧失败。`maxRequestImageBytes: 12582912` 处于网关的请求体上限之下，也低于[请求图像上限](2026-08-20-unified-image-request-pipeline.zh.md)设定的 20 MiB 默认值。

2026-08-27 的一次重新探测把 `deepseek-v4-flash-vision-exp` 加入目录，并将其设为该组合的默认代理模型；它正是「按系列名推断」这一陷阱所针对的情形：网关提供三个 V4 Flash id，只有带 `-vision-exp` 后缀的那个能看见。它在 3 次尝试中 3 次答对色块顺序，在 SSE 流式下同样输出这些 token，并能返回工具调用；而裸 `deepseek-v4-flash` 与 `deepseek-v4-flash-preview` 都在推理中表示没有收到图像。因此两个同系列 id 被显式列为 `input: [text]` 而非省略，让误取较短 id 的读者得到一条点名该模型的拒绝，而不是一次路由级默认值的猜测。其 `contextWindow` 取 pi-ai 目录对该系列给出的 1,000,000，而非探测所得的上限：网关自身不施加长度限制（90 万 prompt token 被接受，再往上一档失败于 TPM 配额而非长度），因此没有探测能够确立这个上限。

声明 `[text]` 是承重的，而不是说明性的。harness 会在三个彼此独立的位置提前拒绝图像——`read_image`、MCP 工具桥接与 ACP 内容转换——报出 `model "<id>" does not declare image input`。模型根本不会收到图像块，也就无法描述它没看过的东西，于是一个静默的错误答案变成了一次可读的拒绝。

验证这类声明需要一个无法靠猜命中的探针。单色图像会让「盲」模型凭说出一个合理颜色而通过；这里的夹具是一张四象限 PNG，其颜色与顺序都难以凭运气猜对。

## Consequences

识图在该网关上可用，且 fork 原有的低成本默认路由保持不变，组合本身也记录了其中哪些模型真的能看见。代价是 `input` 成为一份手工维护的声明：网关没有任何可供推导的信息，因此在稳定的模型 id 背后更换供应方可能静默地使某条记录失效，只有重新探测才能发现。向安全侧失败的默认值限制了损害范围——过时的 `[image]` 声明会退化为幻觉，所以该列表是验证得来而非假定得来的；而过时的 `[text]` 声明只损失一项能力。

这一组合同时带上了 rc8 合并所需的唯一行为修复：rc8 将图像列表变为远端 `commands/execute` 信封的必填参数，fork 的 rollout 按钮现在显式传入它。

## Alternatives considered

- **信任网关，把所有模型都声明为 `[text, image]`。** 失败模式本身就是不这么做的理由。被丢弃的图像会返回 HTTP 200 和一段自信的回答，因此 harness 无法察觉；读到一段对模型从未收到的图像的合理描述的用户，同样无法察觉。
- **在加载时探测能力。** 为每个模型在启动时发一次图像请求可以让声明自我验证，但这会在每次启动时花费 token 与延迟，需要一个网关无法用缓存回答的夹具，而且最终仍与声明一样向安全侧失败。模态因此仍是对端点的声明，与 rc8 在其他各处对待精确模型元数据的方式一致。
- **改为扩展直连的 `deepseek-official` 适配器。** 它只讲一家供应方的协议、只认一套模型 id 命名空间。该网关的价值恰在于一个 URL 背后有多家供应方，而这正是可配置的 pi-ai 路由已经建模的东西。
- **省掉那条刻意保留的纯文本条目。** 去掉 `deepseek-v3.2` 会让列出的每个模型都是识图模型，并藏起这里最有意思的事实。诚实地保留并声明它，才是这道护栏得以被演示的原因。
- **把 fork 的提交逐个重放到 rc8 上，而不是合并。** 在 1604 个文件的上游差异之上做 rebase，会让同样的冲突按提交数重复解决一遍。fork 的 rc7 同步已经确立了合并这一做法，而合并会记录双亲，使下一次同步有基点可依。
