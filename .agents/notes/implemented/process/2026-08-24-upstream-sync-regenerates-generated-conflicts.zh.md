# Agent Note：上游同步冲突用重新生成解决，而非手工合并

Status: implemented

[English](2026-08-24-upstream-sync-regenerates-generated-conflicts.md) | 中文

## Problem

本 fork 跟踪 `deepseek-ai/deepseek-harness`，同时自带若干包（`tokenrouter-rollout`、`client-ui-rollout`）以及适配层修复。把 0.1.0-rc.8 同步到 0.1.1-rc.2 带来 207 个上游提交、2416 个文件变更，而全部合并冲突都落在生成产物上：客户端 slot catalog、config 与 persistence catalog、模块依赖图，以及四份双语配对记录。手工合并这些文件错在两处——文件本身不是事实来源，而手工合并出的 catalog 通过自身 `--check` 门禁只是巧合。

同步也不能假定门禁变红就意味着合并破坏了什么。在本机上，直接检出上游 rc.2 这个 tag 本身，就已经有八个 snapshot 测试和两条 `rescope-vendor` 精确编辑失败。不把它们分离出来，同步要么去追上游的失败，要么让真正的回归藏在这些失败背后。

## Decision

生成文件的冲突一律取上游一侧并重跑生成器，绝不编辑产物。随后由七条 `verify-*-catalog`／`verify-*-graph` 门禁证明结果，并把合并后的 catalog 与上游 tag 相比，确认上游内容零删除——正是这一检查区分了「已重新生成」与「在损坏的源码树上重新生成」。双语配对记录走 `resolve-translation-pairing-conflicts`，它会暂存两侧一致的每一份记录，并点名需要人来决定的那些。

每一条失败的门禁，在被当作我们的问题之前，都先在上游 tag 的干净 worktree 上复现一次。本次同步由此分出三类：fork 自身的缺陷、合并继承来的上游缺陷、以及本机环境噪声。前两类在同步中修掉；第三类记录下来并原样保留。

- **合并暴露出的 fork 缺陷。** `examples/headless-agent/README.zh.md` 链到了英文 Agent Note；`docs/module-graph.zh.md` 仍写着 `client-ui-slots`，而 rc.2 已把该依赖改名为 `client-ui-layout`。两处都是 fork 自己写的行，只有包含 rc.2 改名的树才能发现。
- **合并继承的上游缺陷。** 两条 `rescope-vendor` 精确编辑在干净的 rc.2 上就失败。`knip-logger-console` 锚定在 rc.2 已删除的 `packages/util/home`，且再无 manifest 声明 `@cordisjs/plugin-logger-console`，因此该编辑被退役而非修补。`vendoring-cookbook-name-invariant-zh` 期望中文 cookbook 里是 `../rescope.md`，而上游的中文链接本地化把它改成了 `../rescope.zh.md`，却没有同步更新这条规格。
- **本机噪声。** 三个 pwsh 测试和五处 snapshot 的 stderr 断言在干净的 rc.2 上以同样方式失败：本机 PowerShell 7.6.5，以及 Node 25 的 SQLite 实验特性警告。CI 固定 Node 24 并在 Linux 上跑 pwsh，两者都碰不到。

rc.2 把投影表拆成 `SessionProjectionStateMap`（宿主折叠状态）与 `SessionProjectionMap`（客户端线上值），把 `schema` 改名为 `stateSchema`，并把 `view` 移到可选的 `wire` 之下。fork 的 `rolloutStats` 单元跟随这次拆分：其状态 schema 由 view schema 加上它一直携带的 `winnerScores` 轨迹派生，并在已有的线上键旁合并状态键。该单元从类型标注改为 `satisfies`——这既是上游自身单元的写法，也使双表约束在定义处而非注册调用处报错。

## Alternatives considered

**把 fork 的提交 rebase 到上游 tag 上。** fork 已发布的历史是 squash 合并的，上游因此不是 `master` 的祖先；rebase 会把六个被压扁的提交——其中包含两次以往的同步合并——重放到一棵相差 2416 个文件的树上。合并保留上游 tag 作为真正的父提交，而正是这一点让下一次同步能算出正确的三方合并基。

**手工合并冲突的 catalog。** 它们是生成器输出。手工合并恰好满足 `--check`，只证明产物自身一致，而下一次无关的重新生成就会静默改写它。

**配对记录取 fork 一侧。** 这些记录是「已确认一致」状态下两侧的 blob 哈希，因此保留合并前的哈希，等于为已不存在的内容断言一致性。唯一有意义的解决方式，是在两侧真正一致之后重新记录。

**先在上游修掉 `rescope-vendor` 的两处缺陷。** 合并一落地，两者立刻卡住本次同步的 `hygiene` 门禁，而两处修改都不触碰上游行为——一处退役死掉的编辑，一处修正规格字符串里的链接。放在这里能让 fork 保持全绿；它们仍然值得回送上游。

**重新录制 pwsh 与 snapshot 基线，让本机测试全绿。** 这些基线是正确的，CI 已经证明。按本机 PowerShell 与 Node 25 重录，会把本机的特殊性写进仓库的期望输出，而测试策略明确禁止这样做：修基线，别修归一化器——而这里根本没有需要修的东西。

## Consequences

- 本次同步自身的门禁全绿：`doc-sync` 28/28、`hygiene` 13/13、`typecheck`、`lint`，以及 fork 自有四个包的 470 个测试。`test` 失败 3 项、`test:snapshot` 失败 5 项，全部在干净的 rc.2 上复现，而同一套件在那里失败 8 项。
- 退役 `knip-logger-console` 意味着：若未来上游重新引入 `@cordisjs/plugin-logger-console` 依赖条目，将没有对应的 rescope 覆盖。`rescope-vendor --check` 会对未生效的编辑大声失败，却无法察觉缺失的编辑，因此这种重新引入会以 knip 失败的形式浮现。
- 生成产物规则使同步的冲突数取决于 fork 自有包喂给多少个生成器，而非上游改了多少。本次五处冲突来自两个 fork 包所贡献的 slot、config、persistence 事件与依赖图节点。
- 在上游 tag 上复现失败，每类要付一次安装与一次套件运行的代价，而它是区分「合并回归」与「继承回归」的唯一证据。两个 worktree 用完即删，不留给下一次同步重新发现。
