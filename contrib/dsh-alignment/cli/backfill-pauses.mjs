// backfill-pauses.mjs — 给对齐页的老轮次补暂缓时段（pauses，api 15）。
//
// 2026-10-26 起 CLI 改 status 进出 paused 时自己记 pauses；之前的轮次没有记录。这里从会话日志里找当时跑过的 align 命令
// （pwsh 后台任务的 job/registered 标签 = 命令原文，job/settled 带退出码和结束时刻）推出每一轮进出暂缓的时刻：
//   round set <页> <id> … status=<s>    这一轮改成 s
//   round add <页> <新 id> … --prev <id>  上一轮被收尾成 done（离开暂缓）
// 只认退出码 0 的命令，时刻取任务结束时刻（命令写页面后才退出）。
// 推不出来的标 untimed="true"（已用标「约」、不进 task-eta 校准）：现在是暂缓、却找不到进入暂缓的命令；或者找到了进入暂缓、
// 现在不是暂缓、却找不到离开的命令。从没暂缓过的轮次不动。已经有 pauses / untimed 的轮次不动。
//
// 用法：node backfill-pauses.mjs <页> [--dry-run] [--sessions <会话日志根目录>]
//   写之前确认 3080 的对齐页插件认得 pauses（api >= 15），旧插件读到它整页报错；--dry-run 只列结果不写。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mutate, readRegistry, resolvePage, parsePage, nowIso, pauseApiReady, PAUSE_API } from './align.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const SLACK_MS = 60_000;

/** 一条命令（可能是 ; 连起来的几条）里改轮次状态的部分：[{page, id, status}]。page 是命令里写的页面参数（名字或路径，去掉引号）。 */
export function statusCommands(cmd) {
  const out = [];
  const unq = (s) => s.replace(/^['"]|['"]$/g, '');
  for (const part of String(cmd).split(/[;\n]|&&/)) {
    const set = part.match(/\bround\s+set\s+(\S+)\s+([a-z0-9][a-z0-9-]*)\b(.*)$/);
    if (set) { const st = set[3].match(/(?:^|\s)['"]?status=([a-z]+)/); if (st) out.push({ page: unq(set[1]), id: set[2], status: st[1] }); continue; }
    const add = part.match(/\bround\s+add\s+(\S+)\s+\S+.*?--prev\s+['"]?([a-z0-9][a-z0-9-]*)/);
    if (add) out.push({ page: unq(add[1]), id: add[2], status: 'done' });
  }
  return out;
}

/**
 * 一个会话日志（解压后的 jsonl 文本）里成功跑完的状态命令：[{t, page, id, status}]，t = 任务结束时刻（毫秒）。
 * 只看 pwsh 后台任务：align 命令都经 pwsh 跑，标签是命令原文。
 */
export function commandsInLog(text) {
  const reg = new Map(), out = [];
  for (const line of text.split('\n')) {
    const reg1 = line.includes('"job/registered"');
    if (reg1 ? !line.includes('round ') : !line.includes('"job/settled"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (e.type === 'job/registered' && d.kind === 'pwsh') reg.set(d.jobId, d.label);
    else if (e.type === 'job/settled' && reg.has(d.jobId)) {
      if (d.status !== 'completed' || !/\bexit code: 0\b/.test(d.detail || '')) continue;
      for (const c of statusCommands(reg.get(d.jobId))) out.push({ t: d.finishedAt ?? e.time, ...c });
    }
  }
  return out;
}

const ms = (s) => Date.parse(s);
const iso = (t) => nowIso(new Date(t));

/**
 * 一轮的暂缓时段：events = 这一轮的状态命令（任意顺序）。返回 {pauses} | {untimed:true} | null（没暂缓过，不动）。
 * 只看这一轮 [started, ended] 里的命令（前后各放 1 分钟）；从 doing 起按顺序走状态机。
 */
export function inferPauses(round, events) {
  const lo = ms(round.started) - SLACK_MS, hi = round.ended ? ms(round.ended) + SLACK_MS : Infinity;
  const evs = events.filter((e) => e.t >= lo && e.t <= hi).sort((a, b) => a.t - b.t);
  const pauses = [];
  let cur = 'doing';
  for (const e of evs) {
    if (e.status === 'paused' && cur !== 'paused') pauses.push({ from: iso(e.t) });
    else if (e.status !== 'paused' && cur === 'paused') pauses[pauses.length - 1].to = iso(e.t);
    cur = e.status;
  }
  if (round.status === 'paused') return cur === 'paused' ? { pauses } : { untimed: true };
  if (cur === 'paused') {
    // 进了暂缓，离开的命令没找到：结束的轮次按 ended 收尾也会把暂缓之后的活算漏，不猜
    return { untimed: true };
  }
  return pauses.length ? { pauses } : null;
}

/** 会话日志根目录下所有 session.v4.jsonl(.zstd)，只取修改时间不早于 since 的。 */
export function sessionLogs(root, since) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
      else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(d.name) && fs.statSync(p).mtimeMs >= since) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
const readLog = (p) => (p.endsWith('.zstd') ? zlib.zstdDecompressSync(fs.readFileSync(p)) : fs.readFileSync(p)).toString('utf8');

/** 页面里要补的轮次 → 推断结果。matchPage(arg) 判断命令里的页面参数是不是这一页。 */
export function plan(data, commands, matchPage) {
  const out = [];
  for (const r of data.rounds) {
    if (!r.started || r.pauses || r.untimed) continue;
    const res = inferPauses(r, commands.filter((c) => c.id === r.id && matchPage(c.page)));
    if (res) out.push({ id: r.id, title: r.title, status: r.status, ...res });
  }
  return out;
}

async function main(argv) {
  const ref = argv.find((a) => !a.startsWith('--'));
  const dry = argv.includes('--dry-run');
  const si = argv.indexOf('--sessions');
  const root = si >= 0 ? argv[si + 1] : path.join(DSH_HOME, 'sessions');
  if (!ref) throw new Error('用法: node backfill-pauses.mjs <页> [--dry-run] [--sessions <会话日志根目录>]');
  const file = resolvePage(ref);
  const data = parsePage(fs.readFileSync(file, 'utf8'));
  if (data.version !== 3) throw new Error('页面「' + data.title + '」不是版本 3，没有轮次');
  const since = Math.min(...data.rounds.filter((r) => r.started).map((r) => ms(r.started))) - SLACK_MS;
  const names = new Set([data.name, ref]);
  for (const [n, p] of Object.entries(readRegistry())) if (path.resolve(p) === path.resolve(file)) names.add(n);
  const matchPage = (a) => names.has(a) || (path.isAbsolute(a) && path.resolve(a) === path.resolve(file));
  const commands = [];
  for (const p of sessionLogs(root, since)) commands.push(...commandsInLog(readLog(p)));
  const todo = plan(data, commands, matchPage);
  const lines = todo.map((x) => 'round/' + x.id + '（' + x.status + '）' + (x.untimed ? ' 推不出暂缓时刻，标用时不准' : ' 暂缓 ' + x.pauses.map((p) => p.from + ' → ' + (p.to || '现在')).join('，')));
  if (!todo.length) return '没有要补的轮次（' + commands.length + ' 条状态命令）';
  if (dry) return ['预演（没写入）：' + todo.length + ' 轮', ...lines].join('\n');
  if (!(await pauseApiReady())) throw new Error('3080 里的对齐页插件还是旧版（api < ' + PAUSE_API + '），读到 pauses 会整页报错；重启 3080 后再跑');
  mutate(file, (d) => {
    for (const x of todo) {
      const r = d.rounds.find((y) => y.id === x.id);
      if (!r || r.pauses || r.untimed) continue;
      if (x.untimed) r.untimed = 'true'; else r.pauses = x.pauses;
    }
  }, nowIso(), { touch: false });
  return ['补了 ' + todo.length + ' 轮 → ' + file, ...lines].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((out) => console.log(out), (e) => { console.error('backfill-pauses: ' + e.message); process.exit(1); });
}
