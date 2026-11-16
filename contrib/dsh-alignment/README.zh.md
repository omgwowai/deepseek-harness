# dsh-alignment

[English](README.md) | 中文

对齐页是一张挂在 DSH（DeepSeek Harness）上的网页看板，给「一个主会话派活给多个工作会话」的协作方式用。插件包名 `dsh-alignment`，版本 `0.1.0`，纯 JavaScript（ES module）实现，无需构建。

对齐页把各会话的进度、卡点和待拍板事项收拢到同一张看板：

- **工作轮次（`round`）**：按项目分组列出每一轮任务，包含标题、关联会话、当前状态（进行中 `doing` / 暂缓 `paused` / 完成待验收 `done` / 已结束 `accepted` / 放弃 `dropped`）、预计时长与已用时长，并在进行中的轮次上实时显示该会话的最新 todolist。
- **待拍板决定（`decide`）**：列出需要用户拿主意的事项，包含备选项及每个选项的后果、风险等级、推荐项与超时时间。
- **顺便问（`btw`）与须知（`note`）**：支持针对某一轮提旁支问题并转发给对应会话回答，或张贴提醒事项。
- **个人待办与目标（`todo` / `goal`）**：记录用户自己的待办事项与阶段目标。

用户在网页上点选方案、写下留言后点击「发送」，插件会把决定作为一条用户消息直接 steer 进对应的工作会话。浏览器端会在 DSH 网页右侧栏增加一个「对齐页」标签页（通过同源 iframe 打开，直接沿用 DSH 登录态），并在会话顶栏提供带待处理数量角标的入口按钮。

单张对齐页的数据直接嵌在对应的 `.html` 文件里。无论用户还是 agent，都通过命令行工具 `cli/align.mjs` 修改页面，不直接编辑 HTML 文件：CLI 每次写入前会校验字段并复核 hash，先写临时文件再做原子 rename；一旦出错则向 `stderr` 输出一行原因并以退出码 `1` 退出，原文件保持不变。

## 安装

前置要求：

- **DSH `0.2.2` 系列**（已在 `0.2.2-rc.1` 上实测通过）
- **Node.js `22` 及以上**（读取会话日志时用到了 `node:zlib` 的 zstd 解压）

按以下三步把插件装进 DSH 的 `web` profile：

1. **添加插件**

   ```bash
   dsh plugin --profile web add <repo path>/contrib/dsh-alignment
   ```

   首次使用 `web` profile 时，DSH 会自动完成初始化，在 profile 的 `package.json` 里写入 `"dsh-alignment": "link:<仓库路径>/contrib/dsh-alignment"`，并把 `"dsh-alignment"` 追加进 `dsh.profile.bundles`（排在默认的 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` 之后）。由于是本地 `link:` 安装，插件目录就是仓库里那份代码，后续 `git pull` 更新后重启 DSH 即生效。

2. **验证配置层已挂载**

   ```bash
   dsh --profile web --dump-config
   ```

   确认输出中包含 `# == dsh-alignment` 配置层，以及 `- id: alignment` 和 `name: dsh-alignment`。

3. **启动 DSH 并检查健康状态**

   ```bash
   dsh --profile web
   ```

   需要指定端口或不自动弹浏览器时，可附加 `--port <端口> --no-open`。启动后请求免登录的健康检查接口：

   ```bash
   curl http://127.0.0.1:<port>/alignment/health
   ```

   返回 `{"ok":true,"app":"alignment-page","api":19,...}` 即表示插件已正常挂载。

卸载插件时执行以下命令，会同时移除依赖项和对应的配置层：

```bash
dsh plugin --profile web remove dsh-alignment
```

## 建第一张对齐页

用 `cli/align.mjs` 的 `init` 子命令创建页面文件并写入登记表：

```bash
node <plugin dir>/cli/align.mjs init <page path.html> --name team --title 团队对齐 --version 3
```

命令成功后会输出 `建了 team → <页面路径.html>`。各参数含义如下：

- `<页面路径.html>`：页面文件的存放位置，路径需以 `.html` 结尾且文件尚未存在。
- `--name <登记名>`：登记名仅限小写字母、数字和连字符。登记完成后，后续所有命令里的 `<页>` 参数写这个登记名或写 `.html` 文件全路径都可以。
- `--version 3`：使用当前的「项目 → 轮次」数据格式。不传该参数会生成旧版格式（版本 2），新建页面统一加上 `--version 3`。
- `--owner <会话id>`（可选）：指定负责这张页面的主会话，页面上的留言和决定超时提醒都会发给它。

打开页面的方式：

1. 在已登录 DSH 的浏览器里，点击会话顶栏的「对齐页」按钮，或点开右侧栏的「对齐页」标签页。
2. 在同一浏览器直接访问 `http://127.0.0.1:<端口>/alignment/p/team`。可以通过以下命令打印完整访问地址：

   ```bash
   node <plugin dir>/cli/align.mjs url team
   ```

如果日常频繁在终端操作，建议给 `node <插件目录>/cli/align.mjs` 建一个名为 `align` 的可执行 shim 或 shell alias。下文命令统一简写为 `align`。

## 常用命令

### 派活与轮次跟进

```bash
# Register a project (bind a working directory or a workspace id)
align project add <page> (--cwd <dir> | --ws <workspace id>)

# Dispatch and register in one step: open a new session or continue the previous round's session, then record the round (needs dsh-threads)
align dispatch <page> <round id> --prompt-file <prompt file> --mode new|continue [--cwd <dir>] title=<title> why=<reason> eta=<median> eta75=<P75> etaconf=高|中|低

# Register a round by hand (the session already exists)
align round add <page> <round id> --mode continue|new [--prev <previous round id>] [--proj <project>] title=<title> sid=<session id> why=<reason> eta=<median> eta75=<P75> etaconf=高|中|低

# Change round fields or status
align round set <page> <round id> status=doing|paused|done|accepted|dropped

# Hand in a result for the user to accept
align round done <page> <round id> visual=true|false [result=<result>] [img=<screenshot path or link>]

# Show one round and its session's current state (needs dsh-threads)
align round show <page> <round id>
```

### 拍板决定、顺便问与日常记录

```bash
# Register a decision (repeat opt for each option)
align decide add <page> <decision id> title=<title> why=<reason> opt=<option>::<consequence> opt=<option>::<consequence> risk=高|中|低 cat=花钱|不可逆|对外发消息|线上配置|方向取舍|其他 [rec=<recommended>] [timeout=8h] [--round <round id>]

# Mark a decision handled
align decide done <page> <decision id> [choice=<chosen option>] [result=<result>]

# Register a side question and forward it to the round's session (forward needs dsh-threads)
align btw add <page> --round <round id> 'q=<question>'
align btw forward <page> <btw id>

# Add a note, a personal todo, a goal
align note add <page> <note id> title=<title> [body=<body>] [level=info|warn]
align todo add <page> 'title=<title>' [p=P0|P1|P2|P3 eta=45m due=YYYY-MM-DD] [--today]
align goal add <page> 'title=<title>' [metric=<metric> target=<target> due=YYYY-MM-DD]
```

### 查询、维护与后备服务

```bash
# List entries by section, one per line
align ls <page> [round|decide|note|project] [--proj <project>]

# One day's rounds and finished todos (read only) / recent usage summary
align day <page> [--date YYYY-MM-DD]
align usage <page> [--since 7d]

# After a plugin upgrade or template change, regenerate the HTML from the new template (data kept)
align refresh <page>

# Unregister a page (the HTML file is not deleted)
align forget <registered name>

# Start the local fallback server that does not go through DSH (listens on 127.0.0.1:3390 only; ALIGN_PORT changes the port)
align serve [--port 3390]
```

关键参数与校验规则：

- **时长写法**：`eta`（中位数预计时长）和 `eta75`（P75 预计时长）写成 `40m`、`1h15m`、`2h` 这类格式。
- **截图验收要求**：`align round done` 中设 `visual=true`（代表交付物需看截图验收）时，至少要挂一张 `img=`。
- **风险与超时规则**：`decide add` 的分类（`cat`）选为 `不可逆`、`对外发消息` 或 `线上配置` 时，`risk` 不能设为 `低`。到达 `timeout` 仍无人拍板时，若带有推荐项 `rec=` 且风险不为 `高`，系统按推荐项处理；否则向页面的负责会话发提醒。
- **挂附件与链接**：`round`、`decide`、`note` 的 `add` 和 `set` 命令均支持重复附加 `img=<路径或链接>[::说明]` 与 `link=<路径、链接或会话id>[::标题]`。
- **会话 ID 检查**：`sid=` 需填完整格式 `session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`。`round add` / `set` 写入 `sid=` 时默认调用 `dsh-threads` 检查会话是否存在；环境里查不了时可加 `--no-check-sid` 仅校验格式。
- **Windows 开机自启后备服务**：需要让本机后备服务随登录自启时，可在 PowerShell 中运行 `cli/autostart.ps1 -Action install` 注册计划任务。

完整子命令和参数说明可执行 `align help [<命令> [<子命令>]]` 查看，或在任意命令末尾加 `--help`。

## 依赖

### 必需依赖

| 依赖 | 用在哪 | 缺了会怎样 |
| --- | --- | --- |
| `@deepseek-ai/dsh-web-app`（DSH `0.2.2` 系列） | 提供 `webServer`、`connection`、`sessionController`、`workspaceRegistry`、`agents`、`jobs`、`schedule`、`sessionProjections` 等宿主服务（`dsh plugin` 初始化 `web` profile 时自带） | 插件加载阶段直接报错退出 |
| Node.js `22+` | 运行插件服务端与 CLI，使用 `node:zlib` 内置的 zstd 解压读取会话日志 | 无法启动，或读取会话日志时报错 |

### 可选依赖

缺了以下组件只影响对应功能，其余功能照常工作：

| 依赖 | 用在哪 | 缺了会怎样 |
| --- | --- | --- |
| `dsh-threads` CLI 与 `dsh-threads-remote` 插件 | `align dispatch`、`align round show`、`align btw forward`、写 `sid=` 时的存在性检查，以及 `3390` 后备服务转发决定。默认找 `$DSH_HOME/scripts/threads-cli/dsh-threads.mjs`，可用环境变量 `ALIGN_THREADS_CLI` 指定全路径（不在本仓库里，需要请找插件作者获取） | 调用上述命令时报错提示找不到脚本；写 `sid=` 可加 `--no-check-sid` 跳过检查。在 DSH 网页上点「发送」走 DSH Web 路由（默认 3080 端口）直接 steer 进会话，不需要它 |
| `dsh-sidebar` CLI | `align open <页>` 在 DSH 网页侧栏唤起页面。默认找 `$DSH_HOME/scripts/sidebar-cli/dsh-sidebar.mjs`，可用环境变量 `ALIGN_SIDEBAR_CLI` 指定全路径（不在本仓库里，需要请找插件作者获取） | `align open` 无法使用；改用 `align url <页>` 拿地址自行在浏览器打开即可 |
| `dsh-workspace-effort` 插件 | First Mate 控件里的「派出强度」按钮 | 该按钮显示为不可用，其他控件和看板功能不受影响 |
| `dsh-plugin-mobile-gateway` 插件 | 供手机 App 读取对齐页 | 手机 App 无法读取对齐页，网页端与 CLI 无影响 |
| `playwright-core`（`1.63.0`）及对应 Chromium | 运行真浏览器端自动化测试 | 无法跑浏览器测试，不影响日常使用与单元测试 |

## First Mate 控件（可选）

First Mate 是一种围绕固定目录长期运行主会话的用法：由这一个主会话持有一张对齐页，专门负责给其他工作会话派活、登记轮次、转发决定。

该控件默认关闭（`GET /alignment/fm` 返回 `{"ok":true,"enabled":false}`，页面不渲染按钮）。开启后，对齐页右上角会多出两个按钮：

- **First Mate**：直接打开当前主会话。
- **刷新 First Mate**：等当前主会话这一轮结束后，新建一个会话接班，自动发送交接提示、把对齐页负责人改成新会话、将旧会话的定时提醒迁移过去，并归档旧会话。

开启步骤：

1. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中添加配置：

   ```yaml
   - id: alignment
     config:
       firstMate:
         root: <main session working directory>   # e.g. D:/work/first-mate
         page: <alignment page registered name>   # e.g. team; default first-mate
   ```

2. 重启 DSH 服务。
3. 为对齐页登记当前负责的主会话：

   ```bash
   align meta <alignment page registered name> owner=<session id>
   ```

注意事项与排错：

- 若配置的 `page` 尚未登记，`GET /alignment/fm` 会返回 `500`（「没有登记名为 … 的页面」）。
- 若页面已存在但还没登记负责会话，接口会返回 `fmError: no current First Mate: none registered`，在对齐页上点一次刷新按钮或运行上面的 `align meta` 命令即可。
- 插件判定「当前 First Mate」只认页面登记的 `owner`，不会按工作目录猜测；同时，会话需位于 `root` 目录下、且并非由 `root` 下另一个会话派出，才算 First Mate 会话。
- 交接提示词模板在插件目录的 `fm-boot-prompt.md` 中，支持 `{{oldSid}}`、`{{root}}`、`{{page}}` 占位符，可按团队习惯修改。

## 数据存在哪

`$DSH_HOME` 缺省为 `~/.dsh`。插件涉及的数据位置与读取边界如下：

- **插件存储目录**：`$DSH_HOME/storages/alignment-page/`（可通过环境变量 `ALIGN_STORE` 改到别处）。里面存放页面登记表 `pages.json`、按天记录的使用日志 `usage/YYYY-MM-DD.jsonl`（保留 90 天后自动删除）、网页上粘贴的图片以及 First Mate 刷新记录。
- **页面文件与附件安全边界**：对齐页 `.html` 文件本身放在 `init` 时指定的任意路径即可。页面经 `/p/<页>/file` 只读提供附件时，只放行页面里登记过的附件，且文件需位于 `$DSH_HOME/tmp`、页面所在目录、页面登记的项目目录、所挂会话读写过的 Git 仓库内，或者文件本身是真实图片。
- **DSH Web 路由**：插件在 DSH Web 服务上挂载了以下路由（除 `/alignment/health` 外，其余均需浏览器处于 DSH 登录状态）：
  - `GET /alignment/health`：健康检查，免登录
  - `GET /alignment/pages`：已登记的页面列表
  - `GET /alignment/p/<页名>`：对齐页页面本体
  - `GET /alignment/p/<页名>/data`：页面轮询的数据接口
  - `POST /alignment/p/<页名>/answer`：接收页面「发送」请求，将决定转发进对应会话
  - `GET /alignment/todos`：各会话最新 todolist（供进行中的轮次展示）
  - `GET /alignment/fm`：First Mate 控件状态

## 开发与测试

在 `contrib/dsh-alignment` 目录下安装依赖并运行单元与 CLI 测试：

```bash
npm install
npm run test:unit
```

运行包含真浏览器的全量测试前，先安装对应版本的 Chromium，再执行 `npm test`：

```bash
npx playwright-core install chromium-headless-shell
npm test
```

需要把截图类测试生成的画面存盘备查时，传入环境变量 `ALIGN_MINE_SHOTS=<截图保存目录>`。

## 目录结构

```text
contrib/dsh-alignment/
  index.js            server: routes, forwarding, deadlines, change watcher
  client.js           browser: the 「对齐页」 entry in the right sidebar
  cordis.patch.yml    plugin mount declaration
  cli/align.mjs       command line (create and edit pages, local fallback server)
  cli/template.html   page template (version 3); template-v2.html is the old version 2
  fm/  fm-*.js        First Mate controls (optional)
  lib/                internal helpers
  assets/stamp-fx/    stamp animation and its licenses
  test/               tests
```

本插件以 MIT 协议开源。点击「发送」成功后的盖章动效位于 `assets/stamp-fx/` 并内联进页面模板，由 MIT 协议代码与 Noto Serif SC 子集字体（SIL OFL 1.1 协议）组成，完整来源与授权说明见 `assets/stamp-fx/NOTICE.md` 及 `assets/stamp-fx/OFL.txt`。