# 通过聚合网关路由图像

[English](tokenrouter-vision.md) | 中文

这个 overlay 让单个 `dsh` 进程改走一个把多家厂商复用到同一个 OpenAI 兼容端点上的网关，使图像输入抵达视觉模型，而不是直连的 DeepSeek 适配器：

```sh
DSH_TOKENROUTER_API_KEY=… dsh --profile headless \
  --patch apps/cli/config/examples/tokenrouter-vision/cordis.yml \
  "read_image ./shot.png and describe it"
```

出货组合已经以休眠方式挂载了 pi-ai 适配器和持久化图像后端，因此这个 overlay 只需提供唤醒该路由的 provider 配置，并把默认模型指过去。API key 始终是一个按请求解析的引用；overlay 本身不携带密钥。

由于该网关把每家厂商都藏在同一个 URL 之后，pi-ai 基于 URL 的识别无法认出它，会把它当成 OpenAI 本身来对话。因此它本来会去推断的每一项传输事实都在此显式声明：端点、completions API、`supportsDeveloperRole: false`、`maxTokensField: max_tokens`，以及一份逐模型的目录。

每个模型的 `input` 列表记录的是**经实测验证**的行为，而非其宣称的能力。该网关上有若干路由会接受图像部分、返回 HTTP 200，然后仅凭文本作答。把这些声明为 `[text]` 是承重的：harness 会提前拒绝该图像并报出 `model "<id>" does not declare image input`，从而把一个自信的错误答案变成一次可读的拒绝。`defaultInput: [text]` 让未声明的模型保持「盲」，因此后续新增的模型会向安全侧失败。

在这里，模型 id 比模型系列更重要。该网关提供三个 DeepSeek V4 Flash id，只有 `deepseek-v4-flash-vision-exp` 能看见；裸 `deepseek-v4-flash` 与 `deepseek-v4-flash-preview` 都会丢弃图像。两个同系列 id 被列为 `[text]` 而非省略，这样误取较短 id 时会得到一条点名该模型的拒绝，而不是一次路由级默认值的猜测。

[Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-tokenrouter-declared-modality.zh.md) 记录了相应的理由与探测方法。
