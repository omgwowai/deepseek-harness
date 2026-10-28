// Refresh the ACP launch fingerprints stored in the adapter's sidecar after the agent launch
// configuration changed (e.g. the omp ACP home moved from the Paseo home to `~/.omp/agent`).
//
// The adapter blocks continuing a bound session when the binding's `launchFingerprint` no longer
// matches the current profile ("profile-changed" recovery), and its `retryOriginal` may not bypass the
// same check — so a config change that is meant to keep sessions resumable must carry the saved
// fingerprints over. This is what `configure.mjs` + the importer assume after the omp home switch.
//
// The fingerprint is computed with the adapter's own `acpLaunchFingerprint` module from the profile's
// node_modules, fed with the agent entry of the profile patch — the exact function the adapter runs at
// resume time. Nothing else in the binding payload changes.
//
// Usage:
//   node refresh-binding-fingerprints.mjs --profile <cordis.patch.yml> --sidecar <sidecar.sqlite> [--apply]
//                                        [--backup-dir <dir>] [--adapter <package dir>] [--kinds omp,codex]
// Without --apply it only reports (dry run).
import { cp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const usage = "usage: node refresh-binding-fingerprints.mjs --profile <cordis.patch.yml> --sidecar <sidecar.sqlite> [--apply] [--backup-dir <dir>] [--adapter <dir>] [--kinds omp,codex]";
const profileFile = value("--profile"), sidecarFile = value("--sidecar");
if (!profileFile || !sidecarFile) { console.error(usage); process.exit(2); }
const apply = flag("--apply");
const kindsFilter = value("--kinds")?.split(",").filter(Boolean);

const patch = parse(await readFile(profileFile, "utf8"));
if (!Array.isArray(patch)) throw new Error(`profile patch 必须是 YAML 数组：${profileFile}`);
const entry = patch.find(item => item?.id === "dsh-acp-adapter");
const agents = entry?.config?.agents;
if (!agents) throw new Error(`profile 中没有 dsh-acp-adapter.agents：${profileFile}`);
const adapterDir = value("--adapter") ?? join(dirname(resolve(profileFile)), "node_modules/@zaimokuza/dsh-acp-adapter");
const moduleFile = join(adapterDir, "lib/domain/session/launch-fingerprint.js");
if (!existsSync(moduleFile)) throw new Error(`找不到 ACP 适配器的 launch-fingerprint 模块：${moduleFile}（用 --adapter 指定 @zaimokuza/dsh-acp-adapter 目录）`);
const { acpLaunchFingerprint, acpLaunchFingerprintsCompatible } = await import(moduleFile);
const current = {};
for (const [kind, config] of Object.entries(agents)) {
  if (kindsFilter && !kindsFilter.includes(kind)) continue;
  const fingerprint = acpLaunchFingerprint({ profileId: kind, config: { command: config.command, args: config.args, env: config.env } });
  if (typeof fingerprint.command !== "string" || !Array.isArray(fingerprint.envKeys)) throw new Error(`指纹计算异常（${kind}）`);
  current[kind] = fingerprint;
  console.log(`current fingerprint · ${kind}: command=${fingerprint.command} envKeys=${fingerprint.envKeys.join(",")}`);
}

const database = new DatabaseSync(sidecarFile);
const rows = database.prepare("SELECT dsh_session_id, acp_provider_id, acp_session_id, payload FROM bindings").all();
const totals = { compatible: 0, refresh: 0, skipped: 0, refreshed: 0 };
const pending = [];
for (const row of rows) {
  const kind = String(row.acp_provider_id ?? "").replace(/^acp-/, "");
  const target = current[kind];
  if (!target) { totals.skipped += 1; continue; }
  let payload;
  try { payload = JSON.parse(row.payload); } catch { console.log(`${row.dsh_session_id} · ${kind} · payload 不可解析，跳过`); totals.skipped += 1; continue; }
  if (acpLaunchFingerprintsCompatible(payload.launchFingerprint, target)) { totals.compatible += 1; continue; }
  totals.refresh += 1;
  pending.push({ row, payload, kind });
  console.log(`${row.dsh_session_id} · ${row.acp_provider_id} · ${row.acp_session_id} · 指纹过期${apply ? "" : "（dry run）"}`);
}
if (!apply) {
  console.log(`\n[dry run] compatible=${totals.compatible} refresh=${totals.refresh} skipped=${totals.skipped}`);
  database.close();
  process.exit(0);
}
if (pending.length === 0) { console.log("\n无需刷新。"); database.close(); process.exit(0); }
// Back up the whole sidecar set (WAL/SHM included) before the first write.
const backupDir = value("--backup-dir") ?? dirname(resolve(sidecarFile));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(backupDir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  const source = `${sidecarFile}${suffix}`;
  if (existsSync(source)) await cp(source, join(backupDir, `sidecar-${stamp}.sqlite${suffix}`));
}
console.log(`sidecar 备份：${backupDir}/sidecar-${stamp}.sqlite*`);
database.exec("BEGIN IMMEDIATE");
try {
  const update = database.prepare("UPDATE bindings SET payload = ? WHERE dsh_session_id = ? AND acp_session_id = ?");
  for (const { row, payload, kind } of pending) {
    const next = { ...payload, launchFingerprint: current[kind] };
    update.run(JSON.stringify(next), row.dsh_session_id, row.acp_session_id);
  }
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
}
// Read back and verify: every refreshed row must now pass the adapter's own compatibility check.
for (const { row, kind } of pending) {
  const fresh = database.prepare("SELECT payload FROM bindings WHERE dsh_session_id = ? AND acp_session_id = ?").get(row.dsh_session_id, row.acp_session_id);
  const payload = JSON.parse(fresh.payload);
  if (!acpLaunchFingerprintsCompatible(payload.launchFingerprint, current[kind])) throw new Error(`刷新后仍不兼容：${row.dsh_session_id}`);
  totals.refreshed += 1;
}
database.close();
console.log(`已刷新 ${totals.refreshed} 条 binding 指纹（compatible=${totals.compatible} skipped=${totals.skipped}）。`);