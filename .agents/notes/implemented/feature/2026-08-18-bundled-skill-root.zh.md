# Agent Note：内置 skill 根目录

Status: implemented

[English](2026-08-18-bundled-skill-root.md) | 中文

## 问题

每个会话都应携带的 skill，在本仓库中无处安放。

`packages/skill/skill-filesystem` 早已支持以 `BUNDLED_SKILL_RANK` 挂载一个 `bundled` 根目录，并早已让它默认取自 `$DSH_BUNDLED_SKILL_DIR`，但仓库中从未有任何代码设置过该变量，因此这个最低优先级的根目录始终为空，该能力只有靠部署方手工导出变量才能用上。

真正携带了 skill 的那两个根目录回答的是不同的问题。`$DSH_HOME/skills` 是使用者自己的目录：安装过程不会往里写任何东西，换一台机器就什么都没有。`config/agent-presets/cordis/skills/` 随单个 preset 一同复制，这对它所存放的「组合编写」skill 是正确的，但对其他 preset 也应具备的内容就是错的——preset 私有的副本对 `standard` 不可见，而按 preset 逐份复制则意味着有四份副本需要同步更新。

## 决策

**`apps/cli/config/skills/` 是随发布提供的根目录，且启动器通过环境变量而非配置行 patch 来安装它。** 在 headless 与 TUI profile 下，`skill-filesystem` 在宿主平面只挂载一次；而在 web profile 下，宿主配置行被禁用、发现能力归各 preset 所有，因此它是按 preset 各挂载一次的。patch 方案必须点名启动器无法枚举的配置行——启动器并不知道自己刚刚引导的是哪套组合。而环境变量默认值无需知道其中任何一条，就能覆盖全部。

该根目录与 `config/agent-presets/` 并列，位于 `apps/cli/package.json` 已发布的 `config` 条目之下，并且在源码布局与构建产物布局中都能从 `import.meta.url` 解析——与 `SHIPPED_PRESET_ROOT` 使用同一个锚点。

**已继承的值一律优先，空字符串也不例外。** `resolveBundledSkillRoot` 只在取值为 `undefined` 时才返回内置根目录。若把 `''` 当作未设置，就会把部署方刚刚清空的根目录重新挂上；这一优先级与 `loadLayeredEnv` 一致，后者同样让进程环境高于所有文件层。

**优先级保持不变，这正是该根目录可以放心随发布提供的原因。** `BUNDLED_SKILL_RANK` 的数值最大，因此主张最弱：项目根目录、自定义根目录或 `$DSH_HOME/skills` 下的同名 skill 都会遮蔽这份内置副本。想要一份不同的 `j-space`，自己写一个即可胜出；没有人需要先卸载这一份。

**该根目录只存放目录。** `discoverRoot` 会把顶层的 `.md` 文件本身当作一个 skill 来读取，因此根目录下的 `README.md` 会被解析、因缺少 frontmatter 而被拒绝，并在每次启动时记录一条「已忽略」日志。该目录的文档因此改为放在应用 README 双语对中的一节，并由测试固定这一「不存在」的事实。

## 随之提供的内容

`config/skills/j-space` 引入自 [J-Space Cognition Suite V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6) 的 `885dc513702cc884f0b4fa07d24a27b2df5a1daf` 版本，遵循 Apache-2.0，上游 `LICENSE` 与之一同保留。其内容是 Markdown 加三个无外部依赖的 Python 脚本；ledger 脚本只在工作目录下的 `.jspace/` 目录内写入，不启动子进程、不打开套接字、不调用 `eval`。

`THIRD_PARTY_NOTICES.md` 不受影响：其生成器读取的是各 manifest（元数据清单）、`vendor/README.md` 和 `pyproject.toml` 文件，而该套件不属于其中任何一类。署名由该目录携带的 `LICENSE` 文件承担，这正是 Apache-2.0 第 4 条的要求。

## 测试

`apps/cli/tests/bundled-skill-root.spec.ts` 固定了解析函数的两个分支、内置根目录确实包含 `j-space/SKILL.md`、根目录下没有游离的 `.md` 文件、上游许可证与套件一同存在，以及 frontmatter 携带了本地提供方发布 skill 所必需的 `name` 与 `description`。

发现能力已做端到端验证：在一个 `skills/` 为空的 `DSH_HOME` 下运行，`j-space` 出现在会话 skill 目录中——它只可能来自内置根目录。

## 后果

现在，部署方可以决定每个会话 skill 目录中的一部分内容，这是此前做不到的。这既是本次改动的目的，也是它的代价：无论会话是否需要，模型读取的每份目录中都会多出一个条目，对每个 profile 都是如此。优先级排序限定了这一代价——任何人都可以用同名 skill 遮蔽内置副本——但除了导出一个空的 `DSH_BUNDLED_SKILL_DIR`（现在这已是有文档记载的做法），没有人能让该根目录本身消失。

引入的第三方 Markdown 是本仓库此前没有的维护面。它不是自动生成的，因此没有任何 gate 会保证它保持最新；更新流程记录在应用 README 双语对中，上游版本号记录在本 note 中。副本过期不会导致任何检查失败，只有当有人主动去看时才会被发现。

它换来的是：一处声明就能让某个 skill 覆盖所有表层。headless 与 TUI 下由宿主配置行读取该变量，web 下由各 preset 自己的配置行读取，因此未来任何 preset——无论是否在本仓库内——都无需额外记住什么就能继承该根目录。

## 备选方案

**在每条 `skill-filesystem` 配置行上以 `customSkillDirs` 条目挂载。** `cordis` preset 对自己的两个 skill 正是这么做的，方案就摆在眼前——但它天然是按组合逐份配置的。每个 preset 都要加这条配置，树外 preset 会悄无声息地缺失它，而 web profile 中按 preset 生成的配置行还需要逐条 patch。环境变量默认值用一处声明覆盖了全部。

**在安装时写入 `$DSH_HOME/skills`。** 往使用者目录写入的安装过程，会拥有一批日后无法在不覆盖用户修改的前提下更新的文件，而且这份副本是按机器而非按部署存在的。内置根目录是只读的、归安装所有，这才是真实成立的归属关系。

**放在仓库根目录的 `skills/`。** 那样它根本不会随包发布：`apps/cli/package.json` 只发布 `lib/*.js` 和 `config`，根目录下的文件到不了任何已安装的部署，启动器的 `import.meta.url` 锚点也无法从构建产物布局中解析到它。
