# 发布与回退

本指南记录需要人工判断的发布与恢复步骤。兼容边界见[原生复用说明](native-reuse.md)，验证范围见 [E2E 指南](../test/e2e/README.md)。版本摘要维护在 [CHANGELOG](../CHANGELOG.md)，实际验证证据归对应 PR 和 CI；本地日志、配置与候选包留在 gitignored `.local/`。

仅修改文档时，通过 PR 和分支要求的检查合并即可；不改版本、不创建标签或运行发布工作流。

## 发布适配器

1. 在 PR 中审阅代码、精确版本和必要文档，分别说明 Web、桌面协议夹具与真实 Agent 的验证范围。通过受保护分支的必需检查后合并。
2. 从合并后的目标提交创建与 `package.json` 版本完全一致的 `v<version>` 标签并推送。不要复用已发布版本或移动标签。
3. 标签触发 [publish 工作流](../.github/workflows/publish.yml)：它冻结本次 Registry 输入，执行测试、构建、打包及独立安装检查，再经现有 `npm-publish` 环境保护发布 CI tarball。手动运行也必须选择对应标签。
4. npm 发布成功后，独立的 `github-release` job 核对精确版本和 tarball 校验值，创建或复用 GitHub Release，并附加**同一份**包；它不重新打包，也不覆盖内容不同的同名资产。alpha、RC、稳定版分别使用 npm `alpha`、`next`、`latest` 通道。

发布后核对 npm 上的实际版本、integrity 和下载地址，再核对 GitHub Release 资产。下游清单应使用已发布包的校验值；本地 pnpm 打包与 CI npm 包可能因 manifest 元数据而不同。GitHub 自动生成的 Source code ZIP/TAR 是源码归档，不是预构建插件包。

```sh
npm view '@local/dsh-acp-adapter@<version>' version dist.integrity dist.tarball
```

## 失败恢复与历史补录

npm 已接受版本而 GitHub Release 创建失败时，npm 包不会回滚。先核对 npm 版本和原 CI tarball，再在 Actions 中使用 **Re-run failed jobs** 只重试失败的 Release job；不要重跑整个发布流程，以免再次发布不可覆盖的版本。Release 生成脚本会复用已有内容，不覆盖人工编辑。普通发布的中英文摘要读取对应版本的 CHANGELOG 条目。

旧 CI 资产已不可用时，可在当前分支为**已有且已发布**的标签补录 Release metadata。先不带 `--write` 生成 `.local/releases/<tag>.md` 供检查，确认后才写入（将示例标签换成目标标签）：

```sh
node scripts/github-release.ts --tag v0.1.6-alpha.2.0 --backfill --changelog CHANGELOG.md
node scripts/github-release.ts --tag v0.1.6-alpha.2.0 --backfill --changelog CHANGELOG.md --write
```

`--backfill` 仍检查标签、包身份与 npm 发布时间，但无法证明旧 CI tarball 的字节一致性；没有 tarball 时不附加安装包。脚本不会创建或移动标签，也不会调用 `npm publish`。普通发布必须提供工作流已验证的 tarball，不能借补录跳过产物核对。

## Agent 目录快照

目录快照随插件包发布，运行时不联网刷新。发布前的 Registry 同步只有完整验证通过才替换本次构建输入；网络或校验失败时沿用该标签中的已验证快照。实际使用的 JSON、哈希和报告保存在 `release-registry-snapshot` CI artifact，工作流重试应复用它。同步成功可能改变包内容却不回写 Git tag，因此复现发行须使用归档快照或实际发布 tarball，不能只 checkout 标签。

要更新仓库里的回退基线，手动运行 [registry sync 工作流](../.github/workflows/registry-sync.yml)，检查 `registry-snapshot-for-review` 的报告，只将成功验证的两个 JSON 通过普通 PR 放回 `assets/registry/`。`fallback` 结果不代表新目录。目录快照校验也不等于逐个 Agent 的运行验收。

## 桌面版本与回退

更新桌面安装包时，先确认精确适配器版本已能从 npm 获取，再更新桌面项目的版本与 Registry integrity 清单，并用其锁定工具链打包、验收。只发布适配器不会更新已有桌面 ZIP；一个平台的结果不覆盖其他平台。

回退时通过 DSH 原生插件管理安装此前已验证的精确版本，保留会话数据，并按 README 重启宿主、刷新页面。先核对目标版本的数据兼容边界，不通过删除数据库修复加载问题。桌面回退还需同步恢复版本和 integrity 清单，重新生成并验收安装产物。
