# dsh-alignment

English | [中文](README.zh.md)

An alignment page is a web board hosted by DSH (DeepSeek Harness) for one way of working: a main session hands work out to several worker sessions. Package name `dsh-alignment`, version `0.1.0`, plain JavaScript (ES modules), no build step.

An alignment page collects each session's progress, blockers and open decisions on one board:

- **Rounds (`round`)**: every round of work, grouped by project, with its title, linked session, status (in progress `doing` / paused `paused` / done, awaiting acceptance `done` / closed `accepted` / dropped `dropped`), estimated and elapsed time, and, on rounds in progress, that session's latest todolist.
- **Decisions (`decide`)**: things the user has to settle, each with options and the consequence of every option, a risk level, a recommended option and a deadline.
- **Side questions (`btw`) and notes (`note`)**: a side question about one round, forwarded to that session to answer, or a notice pinned to the board.
- **Personal todos and goals (`todo` / `goal`)**: the user's own tasks and goals.

The user picks options and writes a note on the page, then clicks 「发送」 (Send); the plugin steers the decision into the worker session as a user message. In the browser it adds a 「对齐页」 (alignment page) tab to the right sidebar of the DSH web UI (a same-origin iframe, so the DSH login carries over) and an entry button in the conversation header with a badge counting what is waiting.

Each page's data is embedded in its `.html` file. Users and agents both change a page through the command line tool `cli/align.mjs`, never by editing the HTML: every write validates the fields, re-checks the file hash, writes a temporary file and renames it atomically; on error it prints one line to `stderr`, exits with `1` and leaves the file unchanged.

## Install

Requirements:

- **DSH `0.2.2` series** (tested on `0.2.2-rc.1`)
- **Node.js `22` or later** (session logs are read with the zstd support in `node:zlib`)

Install the plugin into the DSH `web` profile in three steps:

1. **Add the plugin**

   ```bash
   dsh plugin --profile web add <repo path>/contrib/dsh-alignment
   ```

   The first time the `web` profile is used, DSH initializes it, writes `"dsh-alignment": "link:<repo path>/contrib/dsh-alignment"` into the profile's `package.json` and appends `"dsh-alignment"` to `dsh.profile.bundles` (after the default `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`). Because it is a local `link:` install, the plugin directory is the checkout itself: after `git pull`, restart DSH to pick up the change.

2. **Check that the layer is mounted**

   ```bash
   dsh --profile web --dump-config
   ```

   The output contains a `# == dsh-alignment` layer with `- id: alignment` and `name: dsh-alignment`.

3. **Start DSH and check health**

   ```bash
   dsh --profile web
   ```

   Add `--port <port> --no-open` to pick the port or skip opening a browser. Then request the health check, which needs no login:

   ```bash
   curl http://127.0.0.1:<port>/alignment/health
   ```

   A reply of `{"ok":true,"app":"alignment-page","api":19,...}` means the plugin is mounted.

To uninstall, run the command below; it removes both the dependency and its layer:

```bash
dsh plugin --profile web remove dsh-alignment
```

## Create your first alignment page

The `init` subcommand of `cli/align.mjs` creates the page file and registers it:

```bash
node <plugin dir>/cli/align.mjs init <page path.html> --name team --title 团队对齐 --version 3
```

On success it prints `建了 team → <page path.html>`. The arguments:

- `<page path.html>`: where the page file goes; the path must end in `.html` and the file must not exist yet.
- `--name <registered name>`: lowercase letters, digits and hyphens only. After registration, every `<page>` argument below accepts either this name or the full path of the `.html` file.
- `--version 3`: the current "project → round" data format. Without it the old format (version 2) is created; always pass `--version 3` for new pages.
- `--owner <session id>` (optional): the main session responsible for the page; notes left on the page and decision-deadline reminders go to it.

To open the page:

1. In a browser logged in to DSH, click the 「对齐页」 button in the conversation header, or open the 「对齐页」 tab in the right sidebar.
2. In the same browser, visit `http://127.0.0.1:<port>/alignment/p/team`. This command prints the full address:

   ```bash
   node <plugin dir>/cli/align.mjs url team
   ```

If you work in a terminal a lot, add an executable shim or shell alias named `align` for `node <plugin dir>/cli/align.mjs`. The commands below are written as `align`.

## Common commands

### Dispatching work and following rounds

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

### Decisions, side questions and everyday records

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

### Queries, maintenance and the fallback server

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

Key arguments and checks:

- **Durations**: `eta` (median estimate) and `eta75` (P75 estimate) are written like `40m`, `1h15m`, `2h`.
- **Screenshot acceptance**: with `visual=true` on `align round done` (the deliverable is accepted by looking at screenshots), at least one `img=` must be attached.
- **Risk and deadline rules**: when `decide add` uses `cat` `不可逆` (irreversible), `对外发消息` (sends external messages) or `线上配置` (production config), `risk` cannot be `低` (low). When `timeout` passes with no answer, a decision with `rec=` and a risk other than `高` (high) is settled by the recommendation; otherwise the page's owner session gets a reminder.
- **Attachments and links**: the `add` and `set` commands of `round`, `decide` and `note` accept repeated `img=<path or link>[::caption]` and `link=<path, link or session id>[::title]`.
- **Session id check**: `sid=` takes the full form `session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. When `round add` / `set` writes `sid=`, it asks `dsh-threads` whether the session exists; where that is not possible, add `--no-check-sid` to check the format only.
- **Fallback server at logon on Windows**: to start the local fallback server at logon, run `cli/autostart.ps1 -Action install` in PowerShell to register a scheduled task.

For every subcommand and argument run `align help [<command> [<subcommand>]]`, or append `--help` to any command.

## Dependencies

### Required

| Dependency | Used for | Without it |
| --- | --- | --- |
| `@deepseek-ai/dsh-web-app` (DSH `0.2.2` series) | Host services `webServer`, `connection`, `sessionController`, `workspaceRegistry`, `agents`, `jobs`, `schedule`, `sessionProjections` (included when `dsh plugin` initializes the `web` profile) | The plugin fails at load time |
| Node.js `22+` | Runs the plugin server and the CLI; reads session logs with the zstd support built into `node:zlib` | Does not start, or fails when reading session logs |

### Optional

Without these, only the matching feature is affected; everything else works:

| Dependency | Used for | Without it |
| --- | --- | --- |
| `dsh-threads` CLI and the `dsh-threads-remote` plugin | `align dispatch`, `align round show`, `align btw forward`, the existence check when writing `sid=`, and decision forwarding from the `3390` fallback server. Looked up at `$DSH_HOME/scripts/threads-cli/dsh-threads.mjs`; set `ALIGN_THREADS_CLI` to its full path to use another location (not in this repository; ask the plugin author for it) | Those commands fail saying the script was not found; for `sid=`, `--no-check-sid` skips the check. Clicking 「发送」 in the DSH web UI goes through the DSH web route (port 3080 by default) and steers into the session directly, without it |
| `dsh-sidebar` CLI | `align open <page>` opens the page in the DSH web sidebar. Looked up at `$DSH_HOME/scripts/sidebar-cli/dsh-sidebar.mjs`; set `ALIGN_SIDEBAR_CLI` to its full path to use another location (not in this repository; ask the plugin author for it) | `align open` is unavailable; use `align url <page>` and open the address in a browser |
| `dsh-workspace-effort` plugin | The 「派出强度」 (dispatch effort) button of the First Mate controls | That button shows as unavailable; other controls and the board are unaffected |
| `dsh-plugin-mobile-gateway` plugin | Lets the phone app read alignment pages | The phone app cannot read alignment pages; the web UI and the CLI are unaffected |
| `playwright-core` (`1.63.0`) and the matching Chromium | Runs the real-browser tests | Browser tests cannot run; daily use and unit tests are unaffected |

## First Mate controls (optional)

First Mate is a way of working around one long-running main session in a fixed directory: that session owns an alignment page and dispatches work to other sessions, registers rounds and forwards decisions.

The controls are off by default (`GET /alignment/fm` returns `{"ok":true,"enabled":false}` and the page draws no buttons). Turned on, two buttons appear at the top right of the page:

- **First Mate**: opens the current main session.
- **刷新 First Mate (Refresh First Mate)**: once the current main session finishes its turn, creates a new session to take over, sends it the handover prompt, makes it the page's owner, moves the old session's scheduled reminders to it and archives the old session.

To turn them on:

1. Add this to `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: alignment
     config:
       firstMate:
         root: <main session working directory>   # e.g. D:/work/first-mate
         page: <alignment page registered name>   # e.g. team; default first-mate
   ```

2. Restart DSH.
3. Register the page's current main session:

   ```bash
   align meta <alignment page registered name> owner=<session id>
   ```

Notes and troubleshooting:

- If the configured `page` is not registered, `GET /alignment/fm` returns `500` (「没有登记名为 … 的页面」, no page registered under that name).
- If the page exists but has no owner yet, the route returns `fmError: no current First Mate: none registered`; click the refresh button on the page once, or run the `align meta` command above.
- "The current First Mate" is only the page's registered `owner`; the plugin never guesses by working directory. A session also counts as a First Mate session only when it runs under `root` and was not started by another session under `root`.
- The handover prompt template is `fm-boot-prompt.md` in the plugin directory, with placeholders `{{oldSid}}`, `{{root}}` and `{{page}}`; adapt it to your team.

## Where data is stored

`$DSH_HOME` defaults to `~/.dsh`. Data locations and read boundaries:

- **Plugin storage**: `$DSH_HOME/storages/alignment-page/` (move it with the `ALIGN_STORE` environment variable). It holds the page registry `pages.json`, daily usage logs `usage/YYYY-MM-DD.jsonl` (deleted after 90 days), images pasted on the page, and First Mate refresh records.
- **Page files and attachment boundary**: the page `.html` file can live at any path given to `init`. When the page serves attachments read-only through `/p/<page>/file`, it serves only attachments registered on the page, and only when the file is under `$DSH_HOME/tmp`, the page's directory, a project directory registered on the page, a Git repository that the linked session read or wrote, or is itself a real image.
- **DSH web routes**: the plugin mounts these routes on the DSH web server (all except `/alignment/health` need the browser to be logged in to DSH):
  - `GET /alignment/health`: health check, no login
  - `GET /alignment/pages`: registered pages
  - `GET /alignment/p/<page name>`: the page itself
  - `GET /alignment/p/<page name>/data`: the data the page polls
  - `POST /alignment/p/<page name>/answer`: the page's Send; forwards decisions to their sessions
  - `GET /alignment/todos`: each session's latest todolist (shown on rounds in progress)
  - `GET /alignment/fm`: state of the First Mate controls

## Development and tests

In `contrib/dsh-alignment`, install dependencies and run the unit and CLI tests:

```bash
npm install
npm run test:unit
```


Before the full run with a real browser, install the matching Chromium, then run `npm test`:

```bash
npx playwright-core install chromium-headless-shell
npm test
```

To keep the screenshots that screenshot tests take, pass an environment variable such as `ALIGN_MINE_SHOTS=<screenshot dir>`.

## Directory layout

```text
contrib/dsh-alignment/
  index.js            server: routes, forwarding, deadlines, change watcher
  client.js           browser: the 「对齐页」 entry in the right sidebar
  cordis.patch.yml    plugin mount declaration
  cli/align.mjs       command line (create and edit pages, local fallback server)
  cli/template.html   page template (version 3); template-v2.html is the old version 2
  fm/  fm-*.js        First Mate controls (optional)
  internal/           internal helpers
  assets/stamp-fx/    stamp animation and its licenses
  test/               tests
```

This plugin is MIT licensed. The stamp animation shown after a successful Send lives in `assets/stamp-fx/` and is inlined into the page template; it consists of MIT-licensed code and a subset of the Noto Serif SC font (SIL OFL 1.1). Full sources and licenses: `assets/stamp-fx/NOTICE.md` and `assets/stamp-fx/OFL.txt`.
