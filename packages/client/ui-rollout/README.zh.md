# dsh-client-ui-rollout

[English](README.md) | 中文

TokenRouter rollout 功能的 Web 界面（host 侧逻辑位于 `@deepseek-ai/dsh-tokenrouter-rollout`）：composer 的 rollout 按钮、设置页，以及会话详情底部的统计栏。

## Slots

| Slot | 贡献内容 | 说明 |
|---|---|---|
| `conversation.input.right` | rollout 按钮（`id: rollout`） | 经命令通道执行 `/rollout`；当设置 namespace 为 `enabled: false` 时禁用。 |
| `settings.section` | rollout 设置页（`id: rollout`） | 总开关（默认关闭）、judge 端点、每轮规模、judge 模型、worker 模型池、milestone 自动触发。 |
| `conversation.details.footer` | rollout 统计（`id: rollout-stats`） | 读取 `rolloutStats` 投影；首次 rollout 之前不渲染任何内容。 |

`conversation.details.footer` 座位由 `@deepseek-ai/dsh-client-ui-conversation` 的 DetailsPanel 声明（本包的依赖）——位于所选调用正文下方的按会话读数区。

## 设置 namespace

`tokenrouter-rollout` —— 与 host 插件 `installSettingsSection` 注册的是同一个 namespace。按钮读取 `enabled`；设置页写入 `enabled`、`rolloutCount`、`judgeModel`、`judgeBaseURL`、`workerModels` 和 `autoMilestone`。

`judgeBaseURL` 是部署在启用 rollout 之前唯一不能省略的字段：随包发布的组合不携带 judge 端点，因此这个页面就是用户填入自有 OpenAI 兼容 URL 的地方。namespace 已启用但端点为空时，host 会以一条消息拒绝该轮，而不是派发 worker。

## 模型体验

间接生效：通过本页派发的 `/rollout` 命令和写入的 `tokenrouter-rollout` 设置 namespace；`@deepseek-ai/dsh-tokenrouter-rollout` 拥有该轮次、其会话事件，以及被 steering（中途引导）送入的获胜方案。

#### KV Cache 影响

独立无影响：本包不发起任何模型请求，也不追加任何会话事件。host 送入的获胜方案是一条普通的追加 user 消息，因此模型已缓存的前缀仍可复用。

## 已知限制与暂缓事项

- **按钮状态是注入时读取的快照** —— 另一个标签页里的设置变更会经 ledger 重新注册贡献，但设置页里的实时开关在贡献重新注入之前不会让 composer 按钮重新渲染；设置页自身始终显示当前状态。
- **按钮不提示 judge 端点缺失** —— 只要 `enabled` 为 true 按钮就可用，拒绝消息要等用户按下之后才出现；以 `judgeBaseURL` 为依据的预检禁用态是暂缓事项。
- **统计栏是整会话读数** —— 单轮明细（每轮的分数与获胜方）暂缓实现；投影目前只暴露聚合值。
