# Agent Note: tokenrouter 路由接入 Grok 4.6，并改走 TLS

Status: implemented

[English](2026-09-09-tokenrouter-grok-4-6-route.md) | 中文

## Problem

tokenrouter 覆盖层此前通过 `http://tokenrouter.omgwow.tech:8081/v1` 访问网关，逐请求的 bearer 凭据以明文经过网络。该网关现已在 `https://tokenrouter.omgwow.tech/v1` 提供服务，并且供应 `xai.grok-4.6`——一条覆盖层尚未提供的视觉路由，因此携带图像的会话只能退回到 DeepSeek V4 Flash 的实验性 id。

加入这个模型不是照抄宣称能力的事情。[模态声明那篇 Note](2026-08-20-tokenrouter-declared-modality.zh.md) 已经确立了原因：该网关对被自己丢弃的图像部分同样返回 HTTP 200，因此 `input` 是一项经验证的声明，绝不能靠推断。推理能力属于同一类声明——pi-ai 的 `reasoningEfforts` 映射为每个档位写明线缆取值，而一个被后端拒绝的档位会把常规请求变成硬失败，而非降级。

## Decision

`apps/cli/config/examples/tokenrouter-vision/cordis.yml` 将 `baseURL` 改指 TLS 源站，并加入 `xai.grok-4.6`。两项事实均于 2026-09-09 对在线网关实测得出。

对本组合而言，切换源站不改变行为：TLS 端点返回的 83 个模型列表与 `:8081` 一致，且包含覆盖层声明的每一个模型。变的是端点，不是目录。

`input: [text, image]` 记录的是三次独立探测，使用无法靠猜命中的四象限 PNG——红/绿/蓝/黄、紫/黄/绿/橙、橙/蓝/红/紫——每次都按正确顺序作答，每次都计费 `image_tokens: 66`。token 计数是其中起决定作用的一半：它区分「后端读取了图像」与「后端接受后丢弃了图像」，而后者正是本组合要防的失败。单色探测做不到这一点，因为盲的模型可以猜中一种颜色。

`contextWindow: 500000` 是探测所得的上限，而非目录数字。后端在拒绝信息中直接给出——`This model's maximum prompt length is 500000 but the request contains 500213 tokens`——而 499k token 被接受，因此这条边界从两侧都被观察到。这与紧邻的 V4 Flash 条目正好相反：那条路由的网关不施加限制，其数字因而取自 pi-ai 目录。

`reasoningEfforts` 省略 `off`，因为该模型无法停止推理：后端对 `reasoning_effort` 的 `none`、`off`、`disabled` 三种取值一律以 HTTP 400 拒绝。省略才是准确的编码——`catalog.ts` 仅允许 `off` 以「无值键」的形式不带线缆取值，硬写一个反而会映射到端点拒绝的档位。`max` 同样被拒，因而一并缺席；`minimal`、`low`、`medium`、`high`、`xhigh` 均被接受，且在一道组合数学题上推理 token 数随档位上升。该模型始终输出 `reasoning_content`，所以这份映射声明的是「具备五个可达档位的推理模型」，而不是一个可开关的能力。

该模型只加入目录，不设为 `agent-default-model`。覆盖层的默认仍是低成本的 V4 Flash 视觉路由。CLI 没有模型参数，因此使用 Grok 4.6 需要再叠加一个 `--patch` 覆盖层来改指 `agent-default-model`，用户指南给出的正是这个做法。

## Consequences

在这个网关上，携带图像的会话现在多了一条经验证的视觉路由，上下文 500k，且不改变默认运行的成本。凭据也不再以明文穿越网络。

代价正是模态声明那篇 Note 已经点明的那一项，只是多了一个条目：`input`、`contextWindow` 以及每个推理档位，都是对一个不上报能力的网关所作的手工维护声明。稳定的 `xai.grok-4.6` id 背后若发生供应方替换，这些声明会静默失效，只有重新探测才能发现。其中推理映射更脆弱——后端日后若开始接受 `off`，不过是少了一个可达档位；但若不再接受 `xhigh`，一份原本可用的配置就会在每次选中该档位的请求上返回 HTTP 400。

## Alternatives considered

- **为与紧邻的 V4 Flash 条目对称，仍然声明 `reasoningEfforts.off`。** 两个模型恰恰在这一点上不同：V4 Flash 的 `thinking: {type: disabled}` 经验证能让 `reasoning_content` 归零，而 Grok 4.6 拒绝该请求的每一种写法。此处的对称只会编码一项端点拒绝的能力。
- **直接采信 xAI 公布的上下文窗口，不做探测。** 网关不是 xAI；它在一个 URL 后复用多家供应方，可能施加自己的上限。拒绝信息给出的是这条路由实际执行的上限，也是 harness 唯一能据以行动的数字。
- **把 Grok 4.6 设为默认代理模型。** 它确实是更强的路由，但覆盖层的用意是「低成本默认 + 可用视觉」，本 fork 的其他工作也依赖这一成本结构。用一个参数即可到达它，无需为每次运行重新定价。
- **保留 `:8081` 源站，另开一个改动加模型。** 两处改动落在同一个文件的同六行，且是在同一次探测中针对同一个端点验证的；拆开会让模型条目验证于一个组合已不再使用的源站。
