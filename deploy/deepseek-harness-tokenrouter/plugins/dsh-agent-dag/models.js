// Server half of the "code agent models" panel (DSH settings → Models, and the
// plugin's own page under Plugins). It reads and writes the default main model
// and the subagent model of every code agent DSH drives: DSH itself plus the
// ACP agents (Claude Code, Codex, Oh My Pi).
//
// Where each value lives and when a write takes effect — verified against
// DSH 0.2.1-rc.2, @zaimokuza/dsh-acp-adapter 0.2.1-rc.2.3,
// @agentclientprotocol/claude-agent-acp 0.93.0, codex-acp 2.2.2, omp:
//   dsh.main      agentDefaultModel service (writes the active profile patch)  live
//   dsh.subagent  `tool-subagent` entry config.agentOptions (configEditor)     live
//   claude.main   <claude home>/settings.json env.ANTHROPIC_MODEL              next CLI start
//   claude.sub    <claude home>/settings.json env.CLAUDE_CODE_SUBAGENT_MODEL   next CLI start
//   codex.main    <codex home>/config.toml model                              next app-server
//   codex.sub     <codex home>/config.toml [agents].default_subagent_model     next app-server
//   omp.main      <omp home>/config.yml modelRoles.default                     next omp process
//   omp.sub       <omp home>/config.yml modelRoles.task                        live (next subagent)
// The ACP adapter spawns one agent process per DSH session, so "next session"
// is what a file write buys: no DSH restart, no restart of a running session.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

const AGENTS = ["dsh", "claude", "codex", "omp"];
const LABELS = { dsh: "DeepSeek Harness", claude: "Claude Code", codex: "Codex", omp: "Oh My Pi" };
const ROLES = ["main", "subagent"];
/** Agents whose config files this plugin edits, with what the panel must say about the timing. */
const RESTART = {
  dsh: "默认走 DSH 配置编辑器：立即应用、无需重启；若 home patch（~/.dsh/cordis.patch.yml）覆盖了该条目，面板改 home patch 并提示重启。",
  claude: "新的 DSH 会话（= 新启动一次 Claude Code 进程）生效；已在运行/已存在的会话继续用旧值。不需要重启 DSH。",
  codex: "新的 DSH 会话（= 新启动一次 codex app-server）生效；已存在的会话继续用旧值。不需要重启 DSH。",
  omp: "新的 DSH 会话（= 新启动一次 omp 进程）生效；已在运行/已存在的会话继续用旧值。不需要重启 DSH。",
};
const SS = stamp => new Date(stamp).toISOString().replace(/[:.]/g, "-");

/** The Paseo-side catalog that regenerates ~/.paseo/agents/omp/config.yml: `config/models.json` of the
 *  paseo-agent-dag checkout named by $PASEO_AGENT_DAG_ROOT. Without it, writes are not mirrored back (and say so). */
const modelsJsonPath = () => process.env.PASEO_AGENT_DAG_ROOT ? join(resolve(process.env.PASEO_AGENT_DAG_ROOT), "config", "models.json") : null;

async function readText(path) { return await readFile(path, "utf8"); }
async function readJson(path) { return JSON.parse(await readText(path)); }

/** Copy a user config file aside before the first write of this run. */
async function backup(path, stamp) {
  const target = `${path}.bak-r19-${SS(stamp)}`;
  try { await copyFile(path, target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return target;
}

async function writeIfChanged(path, next, stamp) {
  const before = existsSync(path) ? await readText(path) : null;
  if (before === next) return { backup: null, written: false };
  const copy = before === null ? null : await backup(path, stamp);
  await writeFile(path, next, { mode: 0o600 });
  return { backup: copy, written: true };
}

const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;

//#region TOML — value-preserving edits of the two Codex keys
/** Insert or replace `key = "value"` in `[section]` (null = root) without touching anything else. */
function tomlSet(text, section, key, value) {
  const lines = text.split("\n");
  const header = section === null ? null : `[${section}]`;
  let from = null, to = lines.length;
  if (header === null) {
    from = 0;
    const first = lines.findIndex(line => /^\s*\[/.test(line));
    if (first >= 0) to = first;
  } else {
    const start = lines.findIndex(line => line.trim() === header);
    if (start >= 0) {
      from = start + 1;
      for (let i = from; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { to = i; break; }
    }
  }
  const row = `${key} = ${JSON.stringify(value)}`;
  if (from !== null) {
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    for (let i = from; i < to; i++) if (pattern.test(lines[i])) { lines[i] = row; return lines.join("\n"); }
    lines.splice(to === lines.length ? lines.length : from, 0, row);
    return lines.join("\n");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push("", header, row, "");
  return lines.join("\n");
}

/** Read a TOML scalar (`[section]` or root); returns null when absent. */
function tomlGet(text, section, key) {
  const lines = text.split("\n");
  const header = section === null ? null : `[${section}]`;
  let from = 0, to = lines.length, inside = header === null;
  for (let i = 0; i < lines.length; i++) {
    const mark = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (mark) { inside = header !== null && mark[1].trim() === section; if (inside) from = i + 1; else if (header !== null && i > from) { to = i; break; } continue; }
    if (!inside) continue;
    const value = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(lines[i]);
    if (value) { const raw = value[1]; const quoted = /^"([^"]*)"$/.exec(raw); return quoted ? quoted[1] : raw; }
  }
  return null;
}
//#endregion

//#region omp config.yml — either the user's own YAML or Paseo's managed JSON (with a comment header)
const MANAGED = /^(?:\s*#[^\n]*\n)*/;
/** The user's omp home keeps config.yml as YAML; the Paseo-managed home writes JSON into it. */
function isManagedJson(text) { return text.slice(MANAGED.exec(text)?.[0].length ?? 0).trimStart().startsWith("{"); }
function parseManagedJson(text) {
  const head = MANAGED.exec(text)?.[0] ?? "";
  const body = JSON.parse(text.slice(head.length));
  return { head, body };
}
/** One omp role (`default` / `task`) from config.yml in either format. */
function ompRole(text, key) {
  if (isManagedJson(text)) return parseManagedJson(text).body.modelRoles?.[key] ?? null;
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(`config.yml 不是有效的 YAML：${document.errors[0].message}`);
  return document.getIn(["modelRoles", key]) ?? null;
}
/** Set one omp role, keeping the file's format; YAML edits keep comments and key order. */
function setOmpRole(text, key, model) {
  if (isManagedJson(text)) {
    const { head, body } = parseManagedJson(text);
    return `${head}${jsonText({ ...body, modelRoles: { ...body.modelRoles, [key]: model } })}`;
  }
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(`config.yml 不是有效的 YAML：${document.errors[0].message}`);
  document.setIn(["modelRoles", key], model);
  return String(document);
}
const ompModel = value => String(value ?? "").replace(/^[^/]+\//, "");
//#endregion

//#region DSH-side services
function service(ctx, name) {
  const found = ctx.get(name);
  if (found === undefined) throw new Error(`DSH 服务 ${name} 不可用，无法读写模型默认值`);
  return found;
}
/** Effective config of one profile entry (inherited layers merged with the profile override). */
function entryConfig(ctx, id) {
  const editor = service(ctx, "configEditor");
  const row = editor.configuration().find(item => item.entry.options.id === id);
  return row === undefined ? {} : { ...row.inherited, ...row.override };
}
/**
 * Write one row of a cordis patch file through the `yaml` document API, so every other row,
 * line and comment survives. Used where the config editor cannot write: the home patch (never
 * a write target) and entries a nested include owns (`tool-subagent` has no editable fiber).
 * @param path - patch document to rewrite.
 * @param row - `id`, optional `name` for a row that has to be created, and the config keys to set.
 * @returns whether the file changed, plus the backup taken.
 */
async function editPatchRow(path, row, stamp) {
  if (!existsSync(path)) throw new Error(`找不到 ${path}`);
  const document = parseDocument(await readText(path), { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }] });
  if (document.errors.length) throw new Error(`${path} 不是有效的 YAML：${document.errors[0].message}`);
  if (document.contents === null) document.contents = document.createNode([]);
  if (!isSeq(document.contents)) throw new Error(`${path} 顶层必须是数组`);
  const at = document.contents.items.findIndex((item, i) => isMap(item) && document.getIn([i, "id"]) === row.id);
  if (at < 0) document.add(document.createNode({ id: row.id, ...row.name === undefined ? {} : { name: row.name }, config: row.config }));
  else for (const [key, value] of Object.entries(row.config)) document.setIn([at, "config", key], value);
  return await writeIfChanged(path, String(document), stamp);
}
/** `config/models.json` rebuilds these agent files; keep the same value in its source. */
async function mirrorSource(kind, patch, done, stamp) {
  const source = modelsJsonPath();
  if (!source || !existsSync(source)) {
    done.extra.push(`没有找到 config/models.json（Paseo apply 的源）：这个值会被下一次 apply 还原。`);
    return;
  }
  const file = await readJson(source);
  const section = file[kind];
  if (section === undefined) return;
  const written = await writeIfChanged(source, jsonText({ ...file, [kind]: patch(section) }), stamp);
  if (written.backup) done.backup.push(written.backup);
  if (written.written) done.extra.push(`同步写回 config/models.json 的 ${kind}，下次 paseo-apply 不会覆盖它。`);
}
//#endregion

//#region per-agent descriptors
/** Codex/omp/claude homes come from the ACP adapter's own configured env, so the panel follows the profile. */
function agentHomes(ctx) {
  const agents = entryConfig(ctx, "dsh-acp-adapter").agents ?? {};
  const env = id => agents[id]?.env ?? {};
  return {
    claude: env("claude").CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    codex: env("codex").CODEX_HOME ?? join(homedir(), ".codex"),
    omp: env("omp").PI_CODING_AGENT_DIR ?? join(homedir(), ".paseo", "agents", "omp"),
  };
}

function claudeState(homes) {
  const path = join(homes.claude, "settings.json");
  const env = text => JSON.parse(text).env ?? {};
  return {
    key: "claude", label: LABELS.claude, kind: "ACP", path,
    roles: {
      main: { read: text => env(text).ANTHROPIC_MODEL ?? null, source: "env.ANTHROPIC_MODEL（另有 settings.model = opus → ANTHROPIC_DEFAULT_OPUS_MODEL）" },
      subagent: { read: text => env(text).CLAUDE_CODE_SUBAGENT_MODEL ?? null, source: "env.CLAUDE_CODE_SUBAGENT_MODEL" },
    },
    notes: [
      "env 覆盖 ACP 适配器传的同一变量：settings.json 的值胜出。",
      "Claude 的 haiku 档（后台杂务与 Explore 子代理）另由 ANTHROPIC_DEFAULT_HAIKU_MODEL / ANTHROPIC_SMALL_FAST_MODEL 决定，这里不改它。",
    ],
  };
}

function codexState(homes) {
  const path = join(homes.codex, "config.toml");
  return {
    key: "codex", label: LABELS.codex, kind: "ACP", path,
    roles: {
      main: { read: text => tomlGet(text, null, "model"), source: "config.toml 顶层 model" },
      subagent: { read: text => tomlGet(text, "agents", "default_subagent_model"), source: "[agents].default_subagent_model" },
    },
    notes: [
      "运行中的 DSH 会话继续用旧值：每个 DSH 会话会新起一个 codex app-server。",
      "子代理不选模型时，Codex 才用 default_subagent_model；显式指定模型的 spawn 不受影响。",
    ],
  };
}

function ompState(homes) {
  const path = join(homes.omp, "config.yml");
  return {
    key: "omp", label: LABELS.omp, kind: "ACP", path,
    roles: {
      main: { read: text => ompRole(text, "default"), source: "config.yml modelRoles.default" },
      subagent: { read: text => ompRole(text, "task"), source: "config.yml modelRoles.task（未设置时子代理继承当前会话的模型）" },
    },
    notes: [
      "子代理模型在 omp 内部每次 spawn 时重读，保存后下一次 task 调用即生效。",
      "你自己的 ~/.omp/agent/config.yml（YAML）原地修改，保留注释和顺序；只有 Paseo 管理的 JSON 版 config.yml 会同时写回 config/models.json，避免下次 apply 被覆盖。",
    ],
  };
}
//#endregion

/** The model catalog DSH advertises, grouped by the code agent each provider belongs to. */
export async function catalog(ctx) {
  const llm = service(ctx, "llm");
  const groups = [];
  for (const provider of llm.listProviders()) {
    let models = [];
    try { models = await llm.listModels(provider.id); } catch (error) { groups.push({ id: provider.id, name: provider.name, models: [], error: String(error?.message ?? error) }); continue; }
    groups.push({ id: provider.id, name: provider.name, models: models.map(model => ({ id: model.id, name: model.name ?? model.id })) });
  }
  return groups;
}

const agentOfGroup = id => /^acp-(claude|codex|omp)$/.exec(String(id ?? ""))?.[1] ?? "dsh";

/** Every advertised option for one agent, plus the stored value when the catalog does not carry it. */
function optionsFor(groups, agent, current) {
  const models = [];
  for (const group of groups) if (agentOfGroup(group.id) === agent) for (const model of group.models) if (!models.some(seen => seen.id === model.id)) models.push(model);
  if (current !== null && !models.some(model => model.id === current)) models.push({ id: current, name: `${current}（当前值，不在模型目录中）`, offCatalog: true });
  return models;
}

/** Read both roles of every agent; nothing is written. */
export async function modelSettings(ctx, home) {
  const homes = agentHomes(ctx);
  const groups = await catalog(ctx);
  const out = [];
  const dsh = service(ctx, "agentDefaultModel");
  const selection = dsh.currentSelection();
  const dshSub = (() => {
    try { return entryConfig(ctx, "tool-subagent").agentOptions ?? null; } catch { return null; }
  })();
  out.push({
    id: "dsh", label: LABELS.dsh, kind: "DSH", path: null,
    main: { model: selection.model, provider: selection.provider, source: "agentDefaultModel（新会话默认；模型选择器改模型时也会更新它）" },
    subagent: { model: dshSub?.model ?? null, provider: dshSub?.provider ?? null, source: "tool-subagent 条目的 agentOptions（未设置时子代理沿用父代理的路由）" },
    applies: RESTART.dsh,
    notes: ["写入走 DSH 的配置编辑器：立即应用，无需重启。", "父代理路由只用 provider/model；档位（reasoningEffort）按所选模型自身的默认。"],
  });
  for (const state of [claudeState(homes), codexState(homes), ompState(homes)]) {
    let text = null, error = "";
    try { text = existsSync(state.path) ? await readText(state.path) : null; } catch (failure) { error = String(failure?.message ?? failure); }
    const roles = {};
    for (const role of ROLES) {
      let model = null;
      if (text !== null) { try { model = state.roles[role].read(text); } catch (failure) { error = String(failure?.message ?? failure); } }
      roles[role] = { model, source: state.roles[role].source };
    }
    out.push({ id: state.key, label: state.label, kind: state.kind, path: state.path, main: roles.main, subagent: roles.subagent, applies: RESTART[state.key], notes: state.notes, error });
  }
  for (const agent of out) agent.options = {
    main: optionsFor(groups, agent.id, agent.main.model),
    subagent: optionsFor(groups, agent.id, agent.subagent.model),
  };
  return { agents: out, catalog: groups.map(group => ({ id: group.id, agent: agentOfGroup(group.id), name: group.name, models: group.models })) };
}

/** Reject ids DSH is not advertising right now, so a typo never lands in a user config. */
function checked(row, role, model) {
  if (typeof model !== "string" || model.length === 0 || model.length > 200) throw new Error("模型 id 不合法");
  const known = row.options?.[role] ?? [];
  if (!known.some(entry => entry.id === model)) throw new Error(`${row.label} 当前没有在 DSH 模型目录里提供 ${model}，拒绝写入`);
  return model;
}

/** Write one role of one agent. Returns the paths touched and what the user must expect. */
export async function saveModelSetting(ctx, home, payload) {
  const agent = String(payload?.agent ?? "");
  const role = String(payload?.role ?? "");
  if (!AGENTS.includes(agent)) throw new Error("未知的 code agent");
  if (!ROLES.includes(role)) throw new Error("未知的模型角色");
  const stamp = Date.now();
  const state = await modelSettings(ctx, home);
  const row = state.agents.find(item => item.id === agent);
  const groups = state.catalog.map(group => ({ id: group.id, name: group.name, models: group.models }));
  const model = checked(row, role, payload?.model);
  const homes = agentHomes(ctx);
  const done = { agent, label: LABELS[agent], role, model, backup: [], extra: [], notice: RESTART[agent], changed: row[role].model !== model };

  if (agent === "dsh") {
    const editor = service(ctx, "configEditor");
    if (role === "main") {
      const provider = payload?.provider ?? service(ctx, "agentDefaultModel").currentSelection().provider;
      if (!groups.some(group => group.id === provider)) throw new Error(`未知的模型提供方 ${provider}`);
      if (groups.filter(group => group.id === provider).every(group => group.models.every(entry => entry.id !== model))) throw new Error(`提供方 ${provider} 不提供 ${model}`);
      done.provider = provider;
      done.extra.push("模型选择器在会话里改模型时也会更新同一个默认值。");
      try {
        await service(ctx, "agentDefaultModel").saveSelection({ provider, model });
        done.applied = "live";
        done.extra.push("写进 profile patch 的 agent-default-model 条目，立即应用。");
      } catch (error) {
        // The paseo-applied home patch pins this entry, and the config editor never writes home
        // patches: the home patch itself has to move, and DSH reads it at startup.
        if (!/overridden by a home patch/.test(String(error?.message ?? error))) throw error;
        const patch = join(home, "cordis.patch.yml");
        const written = await editPatchRow(patch, { id: "agent-default-model", config: { provider, model } }, stamp);
        if (written.backup) done.backup.push(written.backup);
        done.write = "cordis.patch.yml 的 agent-default-model 条目";
        done.applied = "restart";
        done.notice = "home patch 覆盖了 profile patch：DSH 只在启动时读 home patch，需完全退出并重开 DSH 后生效（面板已直接改 home patch）。";
        done.extra.push("home patch 覆盖了 profile patch，DSH 只在启动时读 home patch：完全退出并重开 DSH 后这个默认值才生效。");
        const bare = model.replace(/^[^/]+\//, "");
        const catalog = modelsJsonPath();
        const source = catalog && existsSync(catalog) ? await readJson(catalog) : null;
        if (source?.dsh?.routes?.some(route => route.models.some(item => item.id === bare))) await mirrorSource("dsh", dsh => ({ ...dsh, default: bare }), done, stamp);
        else done.extra.push(`模型 ${model} 不在 config/models.json 的 dsh 路由里，没有写回源文件：下一次 paseo-apply 会把 home patch 还原成那里的默认值。`);
      }
    } else {
      const provider = payload?.provider ?? "spawn";
      const entry = editor.entries().find(item => item.options.id === "tool-subagent");
      if (entry !== undefined && entry.fiber !== undefined) {
        // Addressable: the config editor writes it and the Loader applies it right away.
        await editor.edit(entry, (current, inherited) => {
          const base = { ...inherited, ...current };
          return { ...base, agentOptions: { ...base.agentOptions, provider, model } };
        });
        done.applied = "live";
        done.extra.push("写进 profile patch 的 tool-subagent 条目（agentOptions），Loader 立即热应用。");
      } else {
        // `tool-subagent` comes from the base bundle's own include, so the config editor cannot
        // address it: the profile patch itself has to carry the row, and DSH reads it at startup.
        const current = entryConfig(ctx, "tool-subagent");
        const written = await editPatchRow(editor.documentPath, {
          id: "tool-subagent", name: "@deepseek-ai/dsh-tool-subagent",
          config: { provider: current.provider ?? provider, toolName: current.toolName ?? "subagent", agentOptions: { ...current.agentOptions, provider, model } },
        }, stamp);
        if (written.backup) done.backup.push(written.backup);
        done.write = "profile patch 的 tool-subagent 条目（agentOptions）";
        done.applied = "restart";
        done.notice = "DSH 里这条 entry 不属于 profile 自己的 include，配置编辑器写不了：面板直接改 profile patch，需完全退出并重开 DSH 后生效。";
      }
      done.provider = provider;
    }
    done.written = true;
    return done;
  }

  if (agent === "claude") {
    const path = join(homes.claude, "settings.json");
    if (!existsSync(path)) throw new Error(`找不到 ${path}`);
    const settings = await readJson(path);
    settings.env = { ...settings.env, [role === "main" ? "ANTHROPIC_MODEL" : "CLAUDE_CODE_SUBAGENT_MODEL"]: model };
    const written = await writeIfChanged(path, jsonText(settings), stamp);
    if (written.backup) done.backup.push(written.backup);
    done.written = written.written;
    done.write = `settings.json env.${role === "main" ? "ANTHROPIC_MODEL" : "CLAUDE_CODE_SUBAGENT_MODEL"}`;
    done.applied = "next-session";
    return done;
  }

  if (agent === "codex") {
    const path = join(homes.codex, "config.toml");
    if (!existsSync(path)) throw new Error(`找不到 ${path}`);
    const before = await readText(path);
    const after = role === "main" ? tomlSet(before, null, "model", model) : tomlSet(before, "agents", "default_subagent_model", model);
    const written = await writeIfChanged(path, after, stamp);
    if (written.backup) done.backup.push(written.backup);
    done.written = written.written;
    done.write = role === "main" ? "config.toml model" : "config.toml [agents].default_subagent_model";
    done.applied = "next-session";
    return done;
  }

  const path = join(homes.omp, "config.yml");
  if (!existsSync(path)) throw new Error(`找不到 ${path}`);
  const before = await readText(path), key = role === "main" ? "default" : "task";
  const written = await writeIfChanged(path, setOmpRole(before, key, model), stamp);
  if (written.backup) done.backup.push(written.backup);
  done.written = written.written;
  done.write = `config.yml modelRoles.${key}`;
  done.applied = role === "main" ? "next-session" : "live";
  // Only Paseo's managed JSON copy is regenerated from config/models.json; the user's own YAML is not.
  if (isManagedJson(before)) await mirrorSource("omp", omp => ({ ...omp, roles: { ...omp.roles, [key]: ompModel(model) } }), done, stamp);
  return done;
}