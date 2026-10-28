// Skills shared by every code agent in DSH: `~/.agents/skills` is the one shared root.
// DSH (user-agents root), Codex and Oh My Pi read it natively; Claude Code reads only
// `<CLAUDE_CONFIG_DIR>/skills`, so every shared skill is linked there. A name Claude already
// has (a real directory or a link elsewhere) is the user's own and is left alone; links this
// module made are removed when their shared skill disappears.
import { watch } from "node:fs";
import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const RESYNC_DELAY_MS = 300;

/** Skill entries in a root, in the shape skill loaders discover: `<name>/` bundles and flat `<name>.md`. */
async function sharedEntries(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink() || entry.name.endsWith(".md")))
      .map(entry => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Where an existing link at `path` points, absolute; null when `path` is absent or not a link. */
async function linkTarget(path) {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return undefined;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return resolve(dirname(path), await readlink(path));
}

/** One pass: link every shared skill into Claude's skill root and drop links whose skill is gone. */
export async function syncSharedSkills(shared, claudeSkills) {
  const result = { linked: [], kept: [], skipped: [], removed: [] };
  const names = await sharedEntries(shared);
  await mkdir(claudeSkills, { recursive: true });
  for (const name of names) {
    const source = join(shared, name), target = join(claudeSkills, name);
    const current = await linkTarget(target);
    if (current === null) { await symlink(source, target); result.linked.push(name); }
    else if (current === source) result.kept.push(name);
    else result.skipped.push(name);
  }
  const present = new Set(names);
  for (const name of await sharedEntries(claudeSkills)) {
    if (present.has(name)) continue;
    const path = join(claudeSkills, name);
    if (await linkTarget(path) === join(shared, name)) { await unlink(path); result.removed.push(name); }
  }
  return result;
}

export function startSharedSkills(ctx, config) {
  const shared = config.sharedSkillsDir ?? join(homedir(), ".agents", "skills");
  const claudeSkills = join(config.nativeHomes?.claude ?? join(homedir(), ".claude"), "skills");
  const log = (level, message) => ctx.logger?.[level]?.(`agent-dag: ${message}`);
  let timer, running = Promise.resolve();
  const sync = () => {
    running = running.then(() => syncSharedSkills(shared, claudeSkills)).then(result => {
      if (result.linked.length || result.removed.length || result.skipped.length) log("info", `共享技能 → ${claudeSkills}：新链接 ${result.linked.join(", ") || "无"}；移除 ${result.removed.join(", ") || "无"}；同名已有、保留用户自己的 ${result.skipped.join(", ") || "无"}`);
    }, error => log("warn", `共享技能同步失败：${error.message}`));
    return running;
  };
  ctx.effect(() => {
    let watcher, disposed = false;
    mkdir(shared, { recursive: true }).then(() => {
      if (disposed) return;
      sync();
      watcher = watch(shared, () => { clearTimeout(timer); timer = setTimeout(sync, RESYNC_DELAY_MS); });
      watcher.on("error", error => log("warn", `共享技能目录监视失败：${error.message}`));
    }, error => log("warn", `共享技能目录不可用：${error.message}`));
    return () => { disposed = true; clearTimeout(timer); watcher?.close(); };
  }, "agent-dag:shared-skills");
  return { sync, shared, claudeSkills };
}
