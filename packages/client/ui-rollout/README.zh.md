---
description: "TokenRouter rollout 的 Web 界面，面向配置 composer rollout 按钮、judge 端点设置页与会话详情统计栏的用户和维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-rollout

[English](README.md) | 中文

## 概述

本包为 Web GUI 提供三处 rollout 界面：发起一轮 rollout 的 composer 按钮、填写 judge 端点与轮次规模的设置页，以及回读该轮统计数据的会话详情底栏。当部署希望用户从 GUI 而不是手敲 `/rollout` 来驱动 TokenRouter rollout 时挂载它；轮次本身、其会话事件，以及被 steering（中途引导）送入的获胜方案，仍归 host 插件 `@deepseek-ai/dsh-tokenrouter-rollout` 所有。部署唯一不能跳过的字段是 `judgeBaseURL` —— 随包发布的组合都不携带 judge 端点，因此这个设置页就是用户填入自有 OpenAI 兼容 URL 的地方。这些界面只做读取与派发：既不追加会话事件，也不自行发起模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件与 `ui-conversation`、`ui-chat`、`ui-settings` 以及 host 侧的 `dsh-tokenrouter-rollout` 一并挂载；三处界面随即占据各自座位，用户便可在设置页里打开 rollout 并为它指定一个 judge。

### 何时选用

任何希望用户不必走命令行就能用上 rollout 的 Web 组合都可以挂载它。headless、ACP 和 SDK 组合不必挂载：它们没有 slot 宿主，而 `/rollout` 命令已经覆盖了这些场景。host 插件不依赖本包也能工作；本包离开它则毫无用处。

### Slots

| Slot | 贡献内容 | 说明 |
|---|---|---|
| `conversation.input.right` | rollout 按钮（`id: rollout`） | 经命令通道执行 `/rollout`；当设置 namespace 为 `enabled: false` 时禁用。 |
| `settings.section` | rollout 设置页（`id: rollout`） | 总开关（默认关闭）、judge 端点、每轮规模、judge 模型、worker 模型池、milestone 自动触发。 |
| `conversation.details.footer` | rollout 统计（`id: rollout-stats`） | 读取 `rolloutStats` 投影；首次 rollout 之前不渲染任何内容。 |

`conversation.details.footer` 座位由 `@deepseek-ai/dsh-client-ui-chat` 的详情面板声明——位于所选调用正文下方的按会话读数区。

### 设置 namespace

`tokenrouter-rollout` —— 与 host 插件 `settings.installSection` 注册的是同一个 namespace。按钮读取 `enabled`；设置页写入 `enabled`、`rolloutCount`、`judgeModel`、`judgeBaseURL`、`workerModels` 和 `autoMilestone`。

`judgeBaseURL` 是部署在启用 rollout 之前唯一不能省略的字段：随包发布的组合不携带 judge 端点，因此这个页面就是用户填入自有 OpenAI 兼容 URL 的地方。namespace 已启用但端点为空时，host 会以一条消息拒绝该轮，而不是派发 worker。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`tokenrouter-rollout` namespace 上的单个 `settingsScope` 绑定供给两个 store handle：因为一个 slot handle 只能钉在一个 scope 上，而按钮是会话级、设置页是根级。scope 订阅会把每份新快照镜像进已完成注入的 handle，同时每个 handle 在注入时也会采纳当前快照，因此订阅与首次注入之间不会丢失任何更新。一个 revision 守卫会丢弃重复快照。

按钮的注入面只带一个动作 `run`，它经 `ctx.remote.commands.execute` 派发 `/rollout`，并把准入失败映射为一行用户可见提示。设置页的注入面带 `set` 与 `unset`，两者都直接写穿 scope，因此 host 会实时生效。统计底栏完全不需要注入面：它经会话标准工具包的 `useProjection` 读取 `rolloutStats` 投影，在尚无 rollout 时返回 `null`。

| 文件 | 职责 |
|---|---|
| `src/client/index.ts` | 插件主体：locale 注册、scope 镜像、三处 slot 注册。 |
| `src/client/RolloutButton.tsx` | composer 按钮。 |
| `src/client/RolloutSettings.tsx` | 设置页。 |
| `src/client/RolloutStatsPanel.tsx` | 会话详情统计读数。 |
| `src/client/settings-store.ts` | 共享草稿 store 及其默认值。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当 Web 界面不足以解答问题时阅读以下页面。它们从界面走向 host 侧领域与各个 slot 宿主。

- [dsh-tokenrouter-rollout](../../extensions/tokenrouter-rollout/README.zh.md) —— 拥有轮次、judge、设置 namespace 与 `rolloutStats` 投影。
- [ui-chat](../ui-chat/README.zh.md) —— 声明本包统计面板所填的 `conversation.details.footer` 座位。
- [ui-conversation](../ui-conversation/README.zh.md) —— 声明 composer 的 `conversation.input.right` 座位。
- [ui-settings](../ui-settings/README.zh.md) —— 声明 `settings.section` 座位并拥有设置页外壳。
- [客户端包地图](../README.zh.md) —— 相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接生效：通过本页派发的 `/rollout` 命令和写入的 `tokenrouter-rollout` 设置 namespace；`@deepseek-ai/dsh-tokenrouter-rollout` 拥有该轮次、其会话事件，以及被 steering（中途引导）送入的获胜方案。

#### KV Cache 影响

独立无影响：本包不发起任何模型请求，也不追加任何会话事件。host 送入的获胜方案是一条普通的追加 user 消息，因此模型已缓存的前缀仍可复用。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>


以下限制界定了当前的 rollout 界面。它们是本包当下的约束，既不是 rollout 功能的横向对比，也不是任务待办清单。

- **按钮状态是注入时读取的快照** —— 另一个标签页里的设置变更会经 ledger 重新注册贡献，但设置页里的实时开关在贡献重新注入之前不会让 composer 按钮重新渲染；设置页自身始终显示当前状态。
- **按钮不提示 judge 端点缺失** —— 只要 `enabled` 为 true 按钮就可用，拒绝消息要等用户按下之后才出现；以 `judgeBaseURL` 为依据的预检禁用态是暂缓事项。
- **统计栏是整会话读数** —— 单轮明细（每轮的分数与获胜方）暂缓实现；投影目前只暴露聚合值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
