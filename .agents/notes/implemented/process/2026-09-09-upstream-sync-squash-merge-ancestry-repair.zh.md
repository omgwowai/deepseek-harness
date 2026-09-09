# Agent Note: Repair squash-flattened upstream ancestry before merging a sync

Status: implemented

[English](2026-09-09-upstream-sync-squash-merge-ancestry-repair.md) | 中文

## Problem

从 0.1.2-alpha.2 同步到 0.1.5-alpha.1，跨 7570 个文件搬运 1629 个上游提交。这次 merge 报出 3275 处冲突，其中不少文件自上次同步以来两边都没有改动过。

这个数字是历史形态的症状，不是内容的症状。fork 上一次同步是以 PR #11 落到 `omgwowai/master` 的，走的 squash merge。squash merge 只写下一个提交：树是 merge 结果，唯一的父提交是 fork 自己此前的顶端——于是那次同步吃进的上游 tag（`dsh-v0.1.2-alpha.2`，在分支上即 `ef9853546f`）并不是 `master` 的祖先。git 只好越过两次同步去找公共基点，落在 2026-08-13，把工作树里早已存在的 17 天上游历史重新 merge 了一遍。这些已经生效的改动，每一条都以「与自己冲突」的形式出现。

[上一次同步定下的规则](2026-08-24-upstream-sync-regenerates-generated-conflicts.zh.md)（生成物）与[其后继的结构性检查](2026-08-31-upstream-sync-fork-content-loss-checks.zh.md)（双语对）都假定冲突集合是真的。面对 3275 处幻影冲突，两者都用不上：取上游那侧再重新生成，等于把基点版本的 fork 自有成果重放一遍。

## Decision

merge 一次同步之前，上一次同步的上游 tag 必须是 fork 分支的祖先。当 squash merge 把它抹平时，修复手段是一次只补父提交的 merge —— `git merge -s ours <上一次同步的提交>` —— 它记录缺失的血缘，不改动任何文件。fork 已发布的树本来就是那次 merge 的结果；`-s ours` 断言的恰好就是这一点，仅此而已，因此该提交在构造上就是空的，也应当照此审阅。把 `ef9853546f` 记为第二父提交之后，同样一条 `git merge dsh-v0.1.5-alpha.1` 选中了正确的基点，冲突降到 19 处，且全部为真。

这 19 处按前两篇 note 确立的三类归位，各按其规则解决：生成物取上游并重跑生成器；双语对从 merge 前的 blob 恢复 fork 自有段落，并且只在结构不变量比对干净之后才重新记录；手写文件则两侧对读。`docs/event-producer-consumer.zh.md` 果然按 2026-08-31 那篇 note 的预言丢掉了 fork 的 `tokenrouter-rollout` 监听者，被不变量比对逮到：修复后事件键 74/74、包键 268/268。

fork 携带的四项改动里有两项已不再属于 fork。上游的 `acceptIdentity` 取代了 tool-call 守卫，`stream.ts` 则自动 merge 到了上游重写后的 Messages API 之上；两者都直接放弃，不再重新施加。留下的两项是上游至今没有的 `stream` provider 字段，以及 SSE EOF 处理。

上游下线了会话详情面板，连同 `conversation.details.footer` 座位。`client-ui-rollout` 的三处注册中有一处占的正是该座位。本次同步移除这处注册，并把 `RolloutStatsPanel` 改按 `SessionStandardProps & PropsLocale<'rollout'>` 定型——任何会话级座位都会提供的标准工具包——而不是删掉组件或凭空造一个座位。它读取的 host 投影未受影响且仍在记录，因此日后改绑只是一行改动，host 侧无需配合。`tokenrouter-rollout` 扩展自身对 0.1.5-alpha.1 的适配有意不在本 PR 内。

上游的 `Session.events` 属性变成了 `snapshotEvents(fromSeq?, toSeqExclusive?)` 与 `ownEvents()`。两处读取方按语义区分跟进，而非机械改名：milestone 观察者要的是包含 fork 前缀在内的整份日志，调 `snapshotEvents()`；而 `childOutputTokens` 不能把父提交已花掉的 token 记在 fork 出来的子任务头上，调 `ownEvents()`。

## Alternatives considered

**把 fork rebase 到上游 tag 上。** `master` 自该 tag 起有 8 个提交，其中五个是被 squash 的同步 merge：重放它们意味着在一棵相差 7570 个文件的树上重新解决三次历史同步的冲突，而结果同样不带上游父提交。[rc.2 那篇同步 note](2026-08-24-upstream-sync-regenerates-generated-conflicts.zh.md) 上一次同步就以同样理由否决过它；每多一次被 squash 的同步，就多一个这样的提交。

**把 3275 处冲突逐一解决。** 其中绝大多数是基点版本的、树里已有的改动，所谓「解决」不过是在上游自身历史的两个状态之间重新选一次，与 fork 内容毫无关系。这个体量还会淹没真正要紧的那 19 处。

**不 merge，改为把上游 diff cherry-pick 到 fork 上。** 它能一次性得到正确的树，却让下一次同步原地踏步：既无上游祖先，也就没有正确基点。缺陷本身是缺一个父提交，修复也就必须是一个父提交。

**改写 `master`，把 PR #11 的 squash 还原。** 它确实恢复了真实血缘，但改写的是别的克隆手里已有的已发布历史；在共享的默认分支上动 `--force-with-lease`，代价远超那个能一劳永逸的空提交。

**连同座位一起删掉 `RolloutStatsPanel`。** 组件与 `rolloutStats` 投影都是上游删除动作没有触及的 fork 成果；删了它们，后续 PR 就得重建改定型本可保住的东西。按标准工具包定型也让下一次座位变更成为改绑而非重写。

**把面板挂到一个仍然存在的座位上。** 选哪个座位是「按会话读数应该出现在哪里」的产品决策，不是 merge 冲突的解法，而本 PR 的范围是同步。

## Consequences

- 血缘修复是一个 diff 为空的提交，其价值全在父提交列表里。审阅者在文件视图中看不到它；提交信息承载了原因，本篇 note 则持久承载它。
- 只有当下一次同步开始时 `dsh-v0.1.5-alpha.1` 是 `master` 的祖先，那次同步才能算出正确基点。若本 PR 像 #11 一样被 squash merge，缺陷就会重现，下一次同步得再付一遍修复成本。要避免复发，靠的是一个 merge 提交——或者在下一次同步开头再做一次同样的 `-s ours` 修复。
- `-s ours` 提交断言的是「fork 的树里已经包含所指的那个上游状态」。这里成立，是因为被 squash 的正是上一次同步的 merge 结果。它不是通用的血缘改写手段：若用在一个树里其实并不包含其内容的提交上，它会悄无声息地宣称 fork 取用过它从未取用的上游改动。
- `RolloutStatsPanel` 能编译、有覆盖，但不在任何地方渲染。`client-ui-rollout` 的测试现在断言座位数量，而不是那个已消失座位为空——因为退役的键已不在定型后的 slot map 里，旧断言根本写不出来。
- 上游 0.1.5-alpha.1 新增了 `verify-package-readme-summaries`，对英文包 README 的 Summary 设了 100 词上限，fork 的两个包都超了。精简时把两项事实（端点缺失时的 fail-loud 行为、退役座位）挪进了各自归属的小节；两侧中文译文都同步跟进后，才重新记录配对。
- `typecheck`、`lint`、`doc-sync`（34/34），以及四个受影响包的 460 个测试全部通过。`test:coverage` 与平台矩阵仍交给 CI。
