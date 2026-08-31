# Agent Note: 证明上游同步没有丢失 fork 自有内容

Status: implemented

[English](2026-08-31-upstream-sync-fork-content-loss-checks.md) | 中文

## Problem

把 0.1.1-rc.2 同步到 0.1.2-alpha.2 涉及 1313 个上游提交、6868 个文件。[上一次同步定下的规则](2026-08-24-upstream-sync-regenerates-generated-conflicts.zh.md)——生成类冲突一律取上游侧并重跑生成器，再把合并后的目录与上游 tag 对比以证明没有删除*上游*内容——依然成立。它没有覆盖的是反方向：有些产物英文侧是生成器输出，中文侧却是人工维护的经评审对侧。重跑生成器只会改写英文文件，于是冲突中上游的那一侧在中文文件上悄悄取胜，fork 自有的段落随之消失。

这类丢失对目录类 gate 是不可见的，因为缺了一段的中文文件本身是自洽的。它最终只表现为 `verify-md-links` 报出两个失效锚点，距成因已隔了三层；而在此之前同一类问题已经在三处造成内容丢失：`docs/config-catalog.zh.md` 中的 `tokenrouter-rollout` 段落与 `client-ui-rollout` 无配置条目、该文件 `web-search-deepseek` 代码块里 fork 自有的 `stream` 字段，以及 `docs/event-producer-consumer.zh.md` 中的三行表格。

这次同步还继承了另一类上游删除：它们不是以冲突、而是以「缺失」的方式弄坏 fork。上游删除了 `packages/client/runtime` 与 `packages/host/apiproxy`，而一个 fork 独有的 `tsconfig.json` 仍以相对路径引用前者。

## Decision

合并涉及的每一对双语文件都做结构比对，而不是通读判断是否合理。对于英文侧由生成器产出的配对，中文侧要与英文侧在两边必然共享的抽取式不变量上逐项比对：锚点列表、标题列表、围栏代码块正文、`../` 相对链接目标、以及表格行键。这些量按构造都与语言无关，因此任何差异要么是有意的本地化（指向 `.zh.md` 的链接目标、翻译过的表头），要么就是内容丢失。只有这项比对干净之后，才重新记录配对——先记录等于把丢失状态盖章为「已确认一致」，而这恰是配对记录本该排除的情况。

悬空的 TypeScript project reference 要按引用语法去找，而不是按被删路径去找。`scripts/clean.ts` 会遍历根引用图，并对每个 `projectReferences` 条目调用 `parseConfig()`，遇到第一个读不到的条目就抛错，因此单个失效的相对 `"path"` 就会让整次 clean 中止，且报错点名的是缺失的文件、而非引用它的文件。`packages/client/ui-rollout/tsconfig.json` 里写着 `{ "path": "../runtime" }`；用 `client/runtime` 去 grep 找不到它，用 `\.\./runtime` 一次就能命中。

上游两个新增 gate 被当作针对 fork 内容的 gate，而不是上游自己的事。`verify-client-ui-i18n` 拒绝 Client 源码中写死的 UI 文案，而 fork 的 `RolloutButton` 既有字面量 `Rollout` 标签，也有一处字面量失败标签，并附带一条声称失败文案不受约束的注释。它并不豁免：该按钮现在渲染 `button.label`、早已声明但一直未使用的 `button.running`，以及新增的 `button.error`；provider 返回的失败详情仍原样留在 `title` 中，因为那是诊断信息而非文案。`doc-standard.spec.ts` 要求每个包的 README 具备 `description`/`kind` frontmatter 以及「概述 / 目录 / 开发备注」骨架，因此四个 fork README 全部按其重构；同一轮里还修正了 `ui-rollout` README 中两处过时事实：details 页脚的座位现由 `client-ui-chat` 声明，设置命名空间通过 `settings.installSection` 注册。

`publint` 与 `verify-built-package-invariants` 消费构建产物 `lib/`。两者在干净树上都会失败，且在原始上游树上以完全相同的方式失败，因此在 `clean` 之后、`build` 之前跑 `hygiene`，对这两项而言不能说明任何问题。这个先后关系属于产物面的性质，不是 fork 的缺陷。

## Alternatives considered

**通读合并后的中文文件，判断是否缺了东西。** 3600 行目录、117 个段落，恰好是人工审阅最不擅长的输入。抽取式不变量比对是机械的，一次就找出全部四处丢失，且输出的是位置清单而不是「我看过了」这一断言。

**中文目录也用生成器产出。** 没有生成器产出它。文件头注释写明英文侧由 `scripts/gen-config-catalog.ts` 生成，中文侧是通过双语配对维护的经评审对侧——这正是设计意图：生成出来的译文等于没人评审过的译文。

**冲突的中文文件一律取 fork 侧。** 这样保住 fork 的段落却丢掉上游的，只是把静默丢失换了个方向。取上游侧、再从合并前的 blob 恢复 fork 段落，是唯一让两边都留存的解法。

**rollout 按钮的失败标签只本地化 `title`，可见文本保持英文。** 那个可见 span 本身*就是*标签；让它保持英文会使 gate 通过、而 UI 与其他所有已本地化界面不一致。真正成立的区分是：界面自己选择的文案要本地化，provider 返回的详情原样保留。

**先重新记录配对，之后再修内容。** 配对记录的全部含义就是「两侧在该哈希上已确认一致」。先记录一个已知有损的状态、事后再补，会留下一段时间窗口，其间 gate 正在主动断言一件假事。

## Consequences

- 构建之后，`doc-sync` 32/32、`hygiene` 15/15 通过。`typecheck` 与 `lint` 干净，`verify-md-links` 在 2209 个文件中解析出全部交叉链接。
- 这套结构不变量比对同样能捕获上一次同步中该问题的形态，且成本低到可以对合并触及的每一对文件都跑一遍。它不适用于纯散文配对——那里被删掉的一段与对侧不共享任何可抽取的不变量；这类文件仍依赖配对记录加人工评审。
- 手工恢复 `docs/config-catalog.zh.md` 中 fork 段落意味着中文目录现在带有一个需要刻意选择标签约定的段落：合并前 fork 的该段使用 `依赖：`，而上游其余 95 个段落对同一英文 `Requires:` 使用 `需要：`。恢复后的段落跟随上游。
- `verify-client-ui-i18n` 关掉了这样一类缺陷：某个 fork 界面在英文下读起来正常，在其他语言下则完全未翻译。它无法检查某条 locale 取值是否为正确译文，只能检查文案归 locale 所有。
- 两个上游包删除把「引用这些包」的责任留给了 fork，而上游看不到这些引用。fork 独有的 `tsconfig.json` 不被任何上游 gate 覆盖，因此下一次同步若再删除 fork 引用的包，同样的失败会重现——不过一旦知道删了什么，一条命令（`grep -rn '\.\./<name>' --include='tsconfig*.json'`）即可查出。
