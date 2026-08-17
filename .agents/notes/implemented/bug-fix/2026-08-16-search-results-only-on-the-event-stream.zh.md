# Agent Note: 仅在事件流上返回的搜索结果

Status: implemented

[English](2026-08-16-search-results-only-on-the-event-stream.md) | 中文

## Problem

`dsh-web-search-deepseek` 把它的 Messages 调用当作单个 JSON 响应体来读。面对某些 Anthropic 兼容网关，这种读法是错的：网关确实执行了服务器端搜索——`usage.server_tool_use.web_search_requests` 有计数——但单次响应中的 `web_search_tool_result` 块**不带 `content`**，也没有引用；而同一个请求加上 `stream: true` 后，完整的结果条目与每一条 `citations_delta` 摘录都会返回。

提供方的严格模式确实找到了结果块，因此不会失败；它映射出零个可引用条目，搜索随之返回零来源。对话模型于是读到"网上没有内容"，而实际上结果是存在的，且失败信息中没有任何线索指向传输方式。响应中也没有任何字段能把这类网关与"确实没搜到"区分开，所以提供方无法自行探测。

## Decision

`Config.stream`（默认 `false`）决定如何读取响应。设置后，提供方发送 `stream: true` 并携带 `Accept: text/event-stream`，由 `src/stream.ts` 把帧重组为与单次响应路径完全相同的 `AnthropicResponse`，再交给未作改动的 `mapAnthropicResponse` 映射。因此严格模式、URL 去重、snippet 关联、请求日志与 `WEB_ABORTED` 取消语义在两种模式下是构造上相同，而非靠两套并行实现维持一致。

重组只保留映射器会读的内容：来自 `content_block_start` 的 `web_search_tool_result` 块，以及按到达顺序追加了 `citations_delta` 引用的 `text` 块。块按 index 顺序输出，而非到达顺序。其余事件——`message_start`、`text_delta`、`thinking`、`message_stop`——一律丢弃。

帧解码是宽松的，严格检查仍留在映射器中：无法解析或无法识别的帧会被跳过，因为网关可能夹带 Messages 事件规范未描述的帧，一个坏帧不应丢弃已重组的结果。若整个流没有任何结果块，仍会失败——由映射器抛出，沿用原有的错误信息。

SSE 分帧沿用 `eventsource-parser`，与 [`dsh-llm-deepseek/sse`](../../../../packages/llm/llm-deepseek/src/sse.ts) 一致。之所以不直接复用那个模块：它强制要求 chat-completions 的 `[DONE]` 哨兵，而 Messages 事件流并不发送该哨兵——它以 `message_stop` 结束。

默认值保持 `false`，因为 DeepSeek 官方端点在单次响应中即返回完整的块，在那里开启事件流只会平添重组开销。`stream` 与其他字段一样属于 settings 段，因此无需重新注册提供方即可作用于下一次搜索。

## Alternatives considered

**始终使用事件流。** 只有一条代码路径，无需配置项，且对两类端点都有效。之所以否决：这是对所有既有部署的一次无理由默认值变更。DeepSeek 官方端点从中得不到任何好处，却要把重组、半截帧处理以及更长的连接生命周期塞进当下本就正常的路径。`stream` 字段让这项改动保持按部署选择、可随时回退。

**探测后重试。** 发现 `web_search_tool_result` 块的 `content` 缺失或为空时，改用事件流重发一次搜索。之所以否决：这个信号是有歧义的——确实没搜到结果时响应体完全相同，于是每一次空结果都会触发重试，用一整轮 Messages 调用的代价去确认"确实为空"。传输层无从区分这两种情况，这正是该模式应当是关于端点的既定事实、而非推断的原因。

**从流式输出的正文中抓取 URL。** `text` 块里点名了找到的页面。之所以否决，与该提供方一贯不抓取正文的理由相同：这会凭空造出搜索并未返回的来源，而本包的严格模式正是为杜绝此事而存在。

**复用 `dsh-llm-deepseek` 的 `parseSse`。** 因哨兵而否决：流在没有 `[DONE]` 时结束，它会抛出 `STREAM_CLOSED`，而每一条 Messages 事件流都是如此结束的。放宽这一点会削弱 chat-completions 路径所依赖的截断检查；而搜索包依赖 LLM 适配器，也与该提供方刻意不依赖 `ctx.llm` 的设计相抵触。两个模块共用 `eventsource-parser`，因此并没有重复的分帧逻辑。

## Testing

`tests/stream.spec.ts` 覆盖重组（index 排序、多条引用 delta、不修改传入的事件对象、忽略的事件类型、夹在正常帧之间的不可解析帧、每 7 字节从 JSON 中间切开的帧、缺失响应体、以及流中途取消时同步取消 body）与流式模式下的提供方（发出的 `stream: true` 与 `Accept` 标头、关闭时该字段缺失、请求日志、严格模式失败、以及 `WEB_ABORTED`）。

`tests/settings.spec.ts` 补充了真实组合场景：存入 settings 段的 `stream` 经由 `ctx.web.search` 作用于下一次搜索，且该次搜索能从"仅以帧形式携带结果"的响应中映射出来源。本包的单文件覆盖率在语句、分支、函数、行四项上均为 100%。

## Consequences

现在，把提供方指向某个网关的运维者需要多知道关于它的一个事实。代价是：`stream` 取值错误时，表现为搜索报告零来源——与本次修复的症状方向相反、现象相同——README 的"已知限制"已点明这一点。换来的是：这类网关从完全不可用变为可用，且只需改配置而非改代码；同时两种模式不会各自漂移——事件流产出的正是既有映射器已在消费的响应体，因此其上的每一条映射规则与每一个测试对两种模式同等适用。

事件流只改变读取响应的方式。seam 仍在流结束后一次性返回完整的 `WebSearchResult`；搜索不会变为增量式，工具消费方也感知不到差异。
