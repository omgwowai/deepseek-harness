// usage.mjs — 对齐页使用日志：页面攒批发来的事件落盘、旧日志压缩 / 清理；align log / align usage 的读取、过滤与统计。
//
// 存放：<ALIGN_STORE>/usage/YYYY-MM-DD.jsonl（按事件发生的本机日期分文件，每行一个事件，只追加）。
//   今天和昨天保持明文；更早的压成 YYYY-MM-DD.jsonl.gz、超过 KEEP_DAYS（90 天）的删掉——由写入顺带触发（每个进程每小时一次），
//   回复请求之后异步做（不卡 3080）；3080 和 3390 可能同时轮转，每天用 <日>.jsonl.lock 独占认领（见 maintainUsage）。
// 隐私：服务端按 FIELD_KINDS 白名单收字段，其余丢掉（页面也不发）——输入框只记长度 len，不记内容；没有 cookie、密钥类字段。
// 事件的含义见 CATALOG。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
const fsp = fs.promises, gzip = promisify(zlib.gzip);

export const KEEP_DAYS = 90;
export const PLAIN_DAYS = 2;
export const MAX_EVENTS = 500;
export const MAX_DAY_BYTES = 32 * 1024 * 1024;
const DAY = 86400000;
const MAINTAIN_EVERY = 3600000;

/** 事件类型 → 含义。src = 服务端判定的来源，见 sourceOf。 */
export const CATALOG = {
  'page.open': '打开页面（每次加载一次；vw/vh 窗口尺寸，embed=1 在 DSH 侧栏里，h=lo 本机回环地址 / net 经网络）',
  'page.show': '页面重新被看到（kind = browser 浏览器标签回到前台 | sidebar DSH 侧栏展开、切回这个标签或会话）',
  'page.hide': '页面看不到了（kind = browser 浏览器标签切走、窗口最小化 | sidebar DSH 侧栏收起、切到别的标签或没有对齐页的会话；dur = 这一段可见时长）',
  'page.close': '页面关闭或刷新（dur = 最后一段可见时长）',
  'view.tab': '切换左上角「会话 / 决定」页签（v = sess | dec）',
  'view.filter': '决定页签的状态筛选（v）',
  'view.hist': '展开 / 收起更早的轮次（id = 会话 key）',
  'view.chain': '展开 / 收起前序轮次链（id = 会话 key）',
  'view.shut': '收起 / 展开泳道',
  'board.pick': '点泳道里的会话卡，切到该会话（id = 会话 key，proj = 项目）',
  'detail.open': '打开轮次或决定详情（k = r | d，id，from = click | board | hash | queue | restore，proj，st = 状态）',
  'detail.leave': '离开上一个详情（k，id，dur = 停留毫秒）',
  'decide.pick': '点决定的选项（id，opt = 第几个选项，rec = 是不是推荐项，change = new 新选 | change 改选 | unpick 取消）',
  'decide.scope': '选作用范围（id，v）',
  'decide.note': '点「补一句 / 写回复」打开输入框（id）',
  'decide.redo': '已发送的决定点「修改」（id）',
  'input.write': '输入框改完失焦（field = note 补充 | like 同类 | rnote 修改意见 | memo 留言，id，len = 字数；不记内容）',
  'round.act': '轮次按钮（id，v = accept 确认 | revise 修改 | paused 暂缓 | dropped 放弃 | resume 继续，change = on | off | switch）',
  'memo.open': '打开 / 收起留言框（open）',
  'queue.open': '展开 / 收起待发送列表（open）',
  'queue.go': '从待发送列表跳到某项（k = d | r | m）',
  'queue.del': '从待发送列表删一项（k）',
  'queue.clear': '待发送全部清空（n = 项数）',
  'queue.undo': '撤销清空',
  'send.click': '点「发送」（n = 项数）',
  'send.done': '发送结果（ok，status，ms，n，items = [{k, id, choice 有无选项, opt, rec, scope, action, len}]）',
  'order.save': '拖动项目排序后保存（n = 项目数，ok，ms）',
  'split.drag': '拖分隔条（kind = h 上下 | w 左右，dur）',
  'split.reset': '双击分隔条复位（kind）',
  'expand.toggle': '展开 / 收起详情里的折叠块（what = anomaly 工具异常 | tool 工具调用 | 其他，open）',
  'attach.open': '打开附件（kind = img 截图 | link 链接或文档 | handoff 交接文件，ext）',
  'sess.jump': '点「打开会话」跳到会话（id = 会话 id）',
  'copy': '复制（what = path | hash | sid | other）',
  'ref.copy': '详情区条目前面的复制图标：复制这一条的引用（k = r | d，id，what = item 条目本身 | 待办 | 工具调用 | 附件 | 会话 | 现状 | 结果 | 下一步 | 起因 | 待办原因 | 说明 | 下文（事实行下文里的一句））',
  'ref.go': '点了留言框 / 正文里的条目引用标签，跳到那一条（k = r | d，id）',
  'fm.ask': 'First Mate 刷新：打开确认框', 'fm.go': 'First Mate 刷新：确认刷新', 'fm.cancel': 'First Mate 刷新：取消', 'fm.fail': 'First Mate 刷新：查看失败原因', 'fm.close': 'First Mate 刷新：关掉弹框', 'fm.dismiss': 'First Mate 刷新：失败记录标为已处理',
  'ui.other': '其余按钮（act = 按钮名，见 template.html 的 data-act）',
  'error.js': '页面脚本报错（msg 截 200 字，at = 行:列）',
  'error.api': '接口失败（path，status，0 = 没拿到响应时 kind = timeout 超时 | abort 取消 | network 网络不通；ms；同一接口同一状态 60 秒内只记一条，n = 合并的次数）',
  'api.slow': '接口慢（path，ms ≥ 2000）',
  'log.drop': '页面里攒的事件超过上限被丢掉（n）',
  'app.open': '手机 App 拉对齐页数据（服务端记，同一页 10 分钟内只记一次；App 目前只记拉数据和发送）',
  'app.answer': '手机 App 发送决定（n，ok）',
};
/** 「从不用的功能」只看这些人操作类事件（不含页面生命周期、报错、服务端记的）。 */
export const FEATURE_TYPES = Object.keys(CATALOG).filter((t) => !/^(page\.|error\.|api\.|log\.|app\.|detail\.leave|ui\.other)/.test(t));

const STR = 's', NUM = 'n', BOOL = 'b';
/** 收的字段（其余丢掉）。字符串截 80 字，msg / at 截 200。 */
export const FIELD_KINDS = {
  type: STR, id: STR, k: STR, v: STR, act: STR, from: STR, proj: STR, st: STR, kind: STR, field: STR, path: STR, what: STR, change: STR, scope: STR, ext: STR, w: STR,
  msg: STR, at: STR,
  t: NUM, dur: NUM, ms: NUM, len: NUM, n: NUM, status: NUM, opt: NUM, vw: NUM, vh: NUM, seq: NUM,
  ok: BOOL, rec: BOOL, open: BOOL, choice: BOOL,
  items: 'items',
};
const ITEM_KINDS = { k: STR, id: STR, choice: BOOL, opt: NUM, rec: BOOL, scope: STR, action: STR, len: NUM };
const META_KINDS = { pid: STR, dev: STR, embed: NUM, h: STR };
const TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+){0,3}$/;

/** 报错文字里引号括起来的片段（JSON.parse 等会带上被解析的文本）换成 "…"，再截 200 字。 */
export const scrubMsg = (s) => s.replace(/"[^"]*"|'[^']*'|“[^”]*”|「[^」]*」/g, '"…"').slice(0, 200);
function pick(obj, kinds, dropped) {
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    const kind = kinds[key];
    if (!kind) { dropped.add(key); continue; }
    if (kind === STR) { if (typeof val === 'string') out[key] = key === 'msg' ? scrubMsg(val) : val.slice(0, key === 'at' ? 200 : 80); else dropped.add(key); }
    else if (kind === NUM) { if (typeof val === 'number' && Number.isFinite(val)) out[key] = Math.round(val); else dropped.add(key); }
    else if (kind === BOOL) { if (typeof val === 'boolean') out[key] = val; else dropped.add(key); }
    else if (kind === 'items') { if (Array.isArray(val)) out[key] = val.slice(0, 50).filter((x) => x && typeof x === 'object').map((x) => pick(x, ITEM_KINDS, dropped)); else dropped.add(key); }
  }
  return out;
}

/** 页面发来的一批 → 能落盘的事件。body = {pid, dev, embed, h, events: [{t, type, …}]}；不认识的字段丢掉并列在 dropped。 */
export function cleanBatch(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) throw new TypeError('使用日志要 {events: [...]}');
  if (body.events.length > MAX_EVENTS) throw new RangeError('一批最多 ' + MAX_EVENTS + ' 条');
  const dropped = new Set();
  const meta = pick(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'events')), META_KINDS, dropped);
  const events = [];
  for (const raw of body.events) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string' || !TYPE_RE.test(raw.type)) { dropped.add('(bad event)'); continue; }
    const e = pick(raw, FIELD_KINDS, dropped);
    // 页面时钟偏太多（或缺 t）就用收到的时间：日期决定落到哪个文件
    if (typeof e.t !== 'number' || e.t > now + 300000 || e.t < now - DAY) e.t = now;
    events.push(e);
  }
  return { meta, events, dropped: [...dropped] };
}

const pad = (n) => String(n).padStart(2, '0');
/** 本机日期 YYYY-MM-DD（文件名）。 */
export function dayOf(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
// 明文 YYYY-MM-DD.jsonl；压缩 YYYY-MM-DD.jsonl.gz，同一天已有 .gz 时另起 YYYY-MM-DD.jsonl.<认领号>.gz（不改已有文件，没有读改写竞争）
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.(?:\d+-[a-z0-9]+\.)?gz)?$/;
const dayStart = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

let maintainedAt = new Map();
/** 写入：按事件日期分组，每个文件一次 appendFileSync。每个目录每小时顺带做一次 maintainUsage。 */
export function appendUsage(dir, { page, src, body, now = Date.now() }) {
  if (!/^[a-z0-9-]+$/.test(page || '')) throw new TypeError('页面名不对: ' + page);
  const { meta, events, dropped } = cleanBatch(body, now);
  fs.mkdirSync(dir, { recursive: true });
  const groups = new Map();
  for (const e of events) {
    const line = JSON.stringify({ t: e.t, page, src, ...meta, ...e, rt: now }) + '\n';
    const day = dayOf(e.t);
    groups.set(day, (groups.get(day) || '') + line);
  }
  let written = 0;
  for (const [day, text] of groups) {
    const file = path.join(dir, day + '.jsonl');
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (size + Buffer.byteLength(text) > MAX_DAY_BYTES) { dropped.push('(day full ' + day + ')'); continue; }
    fs.appendFileSync(file, text);
    written += text.split('\n').length - 1;
  }
  if (!(now - (maintainedAt.get(dir) || 0) < MAINTAIN_EVERY)) {
    maintainedAt.set(dir, now);
    setImmediate(() => maintainUsage(dir, now).catch(onMaintainError));
  }
  return { n: written, dropped };
}
let onMaintainError = (e) => console.error('[alignment usage] 轮转失败', e);
/** 测试用：轮转失败时的处理（默认打到 stderr；轮转失败不影响写入，下一小时再试）。 */
export function setMaintainErrorHandler(f) { onMaintainError = f; }
export function resetMaintainClock() { maintainedAt = new Map(); }

const LOCK_STALE_MS = 3600000;
let claimSeq = 0;
/** 轮转（异步，不卡事件循环）：今天、昨天保持明文；更早的明文压成 .jsonl.gz（已有就另起 .<号>.gz，不改已有文件）；早于 keepDays 天的删掉。
 *  3080 和 3390 可能同时轮转：每天的明文先用 <日>.jsonl.lock（wx 独占创建）认领，拿不到就跳过；超过 1 小时的锁是崩溃留下的，删掉重来。
 *  （Windows 上并发 rename 同一个文件会都报成功，不能拿 rename 认领。）压缩写完才删明文：中途崩溃最多留下重复行，不丢数据。 */
export async function maintainUsage(dir, now = Date.now(), { keepDays = KEEP_DAYS, plainDays = PLAIN_DAYS } = {}) {
  const out = { gzipped: [], removed: [] };
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  const today = dayStart(dayOf(now));
  for (const name of names) {
    const m = name.match(FILE_RE);
    if (!m) continue;
    const day = m[1], age = Math.round((today - dayStart(day)) / DAY), file = path.join(dir, name);
    if (age >= keepDays) { await fsp.rm(file, { force: true }); out.removed.push(name); continue; }
    if (m[2] || age < plainDays) continue;
    const lock = path.join(dir, day + '.jsonl.lock');
    let fh;
    // Windows：另一个进程刚删掉锁、文件还在「删除中」时 open 报 EPERM，同样当作别人正在做
    const busy = (e) => e.code === 'EEXIST' || (e.code === 'EPERM' && process.platform === 'win32');
    try { fh = await fsp.open(lock, 'wx'); } catch (e) {
      if (!busy(e)) throw e;
      if (e.code === 'EPERM') continue;
      let st; try { st = await fsp.stat(lock); } catch (e2) { if (e2.code === 'ENOENT') continue; throw e2; }
      if (now - st.mtimeMs < LOCK_STALE_MS && Date.now() - st.mtimeMs < LOCK_STALE_MS) continue; // 别的进程正在做
      await fsp.rm(lock, { force: true });
      try { fh = await fsp.open(lock, 'wx'); } catch (e3) { if (busy(e3)) continue; throw e3; }
    }
    try {
      await fh.close();
      let body;
      try { body = await fsp.readFile(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } // 别的进程刚做完
      const tag = process.pid + '-' + (++claimSeq).toString(36) + Math.random().toString(36).slice(2, 6);
      const gz = path.join(dir, day + '.jsonl.gz'), tmp = path.join(dir, day + '.jsonl.' + tag + '.gz.tmp');
      await fsp.writeFile(tmp, await gzip(body));
      try { await fsp.copyFile(tmp, gz, fs.constants.COPYFILE_EXCL); await fsp.rm(tmp); }
      catch (e) { if (e.code !== 'EEXIST') throw e; await fsp.rename(tmp, path.join(dir, day + '.jsonl.' + tag + '.gz')); }
      await fsp.rm(file);
      out.gzipped.push(name);
    } finally { await fsp.rm(lock, { force: true }); }
  }
  return out;
}

/** 读 [since, until) 内的事件（按 t 排序）；page 不给就是所有页面。
 *  坏行不中断读取，记进 bad（[{file, line, nul, why}]，调用方负责报告）：2026-10-27 机器意外断电后，日志尾部留下一段 NUL（文件长度已落盘、内容没落盘），
 *  重启后的下一次追加接在它后面，那一行成了「NUL… + 完整 JSON」。JSON.stringify 不会写出裸 NUL，所以先去掉 NUL 再解析：
 *  解得出就照常读（nul = 去掉的字节数，那段里本来的事件已经丢了），解不出就跳过（why = 解析报错）。 */
export function readUsage(dir, { page, since = 0, until = Infinity, bad = [] } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const name of names.sort()) {
    const m = name.match(FILE_RE);
    if (!m) continue;
    const start = dayStart(m[1]);
    if (start + 2 * DAY <= since || start - DAY >= until) continue; // 留一天余量：事件按页面时钟分文件
    const buf = fs.readFileSync(path.join(dir, name));
    const text = (name.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
    text.split('\n').forEach((line, i) => {
      if (!line) return;
      const clean = line.includes('\0') ? line.replace(/\0+/g, '') : line;
      const nul = line.length - clean.length;
      let e;
      try { e = JSON.parse(clean); } catch (err) { bad.push({ file: name, line: i + 1, nul, why: err.message.slice(0, 120) }); return; }
      if (!e || typeof e !== 'object' || typeof e.t !== 'number') { bad.push({ file: name, line: i + 1, nul, why: '没有时间 t' }); return; }
      if (nul) bad.push({ file: name, line: i + 1, nul, why: null });
      if (e.t >= since && e.t < until && (!page || e.page === page)) out.push(e);
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** readUsage 收集的坏行 → 给人看的一段（stderr）：读不出跳过的、去掉 NUL 后读出的分开说，各列前 5 处。 */
export function badLinesText(bad) {
  const where = (xs) => xs.slice(0, 5).map((b) => b.file + ' 第 ' + b.line + ' 行' + (b.nul ? '（' + b.nul + ' 个 NUL）' : '') + (b.why ? '：' + b.why : '')).join('；') + (xs.length > 5 ? ' 等 ' + xs.length + ' 处' : '');
  const skip = bad.filter((b) => b.why), fixed = bad.filter((b) => !b.why);
  return ['使用日志有坏行：' + (skip.length ? '跳过 ' + skip.length + ' 行（' + where(skip) + '）' : '') + (skip.length && fixed.length ? '；' : '') +
    (fixed.length ? fixed.length + ' 行开头有 NUL，去掉后照常读（' + where(fixed) + '；NUL 那段原有的事件已丢失，多半是断电时没写进磁盘）' : '')].join('');
}

/** --since / --until：2d、36h、90m、1w，或日期 / ISO 时刻。 */
export function parseWhen(s, now = Date.now()) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/);
  if (m) return now - Number(m[1]) * { m: 60000, h: 3600000, d: DAY, w: 7 * DAY }[m[2]];
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? dayStart(s) : Date.parse(s);
  if (!Number.isFinite(t)) throw new TypeError('时间写成 2d / 36h / 90m / 1w，或 2026-10-24 / ISO 时刻: ' + s);
  return t;
}

/** --type a,b：精确类型，或前缀（decide 或 decide.* 都匹配 decide.pick 等）。 */
export function filterEvents(events, { types, id, src } = {}) {
  const ts = types ? String(types).split(',').map((x) => x.trim().replace(/\.?\*$/, '')).filter(Boolean) : null;
  return events.filter((e) => (!ts || ts.some((x) => e.type === x || e.type.startsWith(x + '.'))) &&
    (!id || e.id === id || (e.items || []).some((x) => x.id === id)) && (!src || e.src === src));
}

const SKIP = new Set(['t', 'type', 'page', 'src', 'pid', 'dev', 'embed', 'h', 'w', 'rt', 'seq']);
const stamp = (t) => { const d = new Date(t); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const fmtVal = (v) => (Array.isArray(v) ? '[' + v.map((x) => (x && typeof x === 'object' ? Object.entries(x).map(([k, y]) => k + ':' + y).join(' ') : x)).join('; ') + ']' : String(v));
/** 一行一个事件：时刻 类型 字段… · 来源 设备 宽窄 #页面加载 id。projNames = {项目 id: 名字}（proj 字段换成名字）。 */
export function formatEvent(e, projNames = {}) {
  const kv = Object.entries(e).filter(([k]) => !SKIP.has(k)).map(([k, v]) => k + '=' + (k === 'proj' && projNames[v] ? projNames[v] : fmtVal(v)));
  return stamp(e.t) + ' ' + e.type + (kv.length ? ' ' + kv.join(' ') : '') + ' · ' + [e.src, e.dev, e.w].filter(Boolean).join(' ') + (e.pid ? ' #' + e.pid : '');
}

// ---- 统计 ---------------------------------------------------------------------------------
function quant(xs, q) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
const median = (xs) => quant(xs, 0.5);
/** 不算功能使用的（「最常用 / 没用过」不看）。 */
const NON_ACTION = /^(page\.|api\.|error\.|log\.|app\.|detail\.leave)/;
/** 不算人的操作的（操作时长、步数不看）：再去掉接口回执。 */
const NOT_HUMAN = /^(page\.|api\.|error\.|log\.|app\.|detail\.leave|send\.done|order\.save)/;
const ACTIVE_GAP = 120000;
const CHANGE_KINDS = {
  'decide.pick:change': '改选另一个选项', 'decide.pick:unpick': '取消已选选项', 'round.act:switch': '轮次按钮换成另一个', 'round.act:off': '取消轮次按钮',
  'decide.redo': '已发送的决定点修改', 'queue.del': '从待发送删一项', 'queue.clear': '待发送全部清空', 'queue.undo': '撤销清空',
};
const BLOCKS = [
  ['决定详情', (e) => e.type === 'detail.open' && e.k === 'd'], ['轮次详情', (e) => e.type === 'detail.open' && e.k === 'r'],
  ['会话页签', (e) => e.type === 'view.tab' && e.v === 'sess'], ['决定页签', (e) => e.type === 'view.tab' && e.v === 'dec'],
  ['泳道会话卡', (e) => e.type === 'board.pick'], ['工具调用 / 异常展开', (e) => e.type === 'expand.toggle' && e.open],
  ['附件', (e) => e.type === 'attach.open'], ['留言框', (e) => e.type === 'memo.open' && e.open !== false],
  ['待发送列表', (e) => e.type === 'queue.open' && e.open !== false], ['跳转会话', (e) => e.type === 'sess.jump'],
];
export const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? ms + 'ms' : ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's' : ms < 3600000 ? Math.round(ms / 60000) + 'm' : (ms / 3600000).toFixed(1) + 'h');
const countBy = (xs, f) => { const m = new Map(); for (const x of xs) { const k = f(x); if (k !== undefined) m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };

/** 摘要（--json 原样输出这份对象；summaryText 转成人看的几段）。 */
export function summarize(events, { since, until }) {
  const days = new Map();
  const dayRow = (t) => { const d = dayOf(t); if (!days.has(d)) days.set(d, { day: d, visits: 0, visibleMs: 0, activeMs: 0, events: 0 }); return days.get(d); };
  const byPid = new Map();
  for (const e of events) {
    const row = dayRow(e.t); row.events++;
    if (e.type === 'page.open') row.visits++;
    if ((e.type === 'page.hide' || e.type === 'page.close') && typeof e.dur === 'number') row.visibleMs += e.dur;
    const p = e.pid || '(' + e.src + ')';
    if (!byPid.has(p)) byPid.set(p, []);
    byPid.get(p).push(e);
  }
  // 操作时长：同一次页面加载里相邻两次操作间隔 ≤ 2 分钟的累加
  for (const list of byPid.values()) {
    const acts = list.filter((e) => !NOT_HUMAN.test(e.type));
    for (let i = 1; i < acts.length; i++) { const gap = acts[i].t - acts[i - 1].t; if (gap <= ACTIVE_GAP) dayRow(acts[i].t).activeMs += gap; }
  }
  // 看到 → 作答：同一次页面加载里（pid + 条目）第一次打开详情 → 第一次选（或轮次按钮）/ 第一次发送成功；
  // steps = 中间的人的操作数（含作答那一下）。跨加载作答（这次看、下次才选）不计时，只数 laterLoad。
  const flow = { d: new Map(), r: new Map() }, key = (e, id) => e.pid + '|' + id;
  const answeredIds = { d: new Set(), r: new Set() }, viewedIds = { d: new Set(), r: new Set() };
  for (const e of events) {
    if (e.type === 'detail.open' && (e.k === 'd' || e.k === 'r') && e.id && e.pid) { viewedIds[e.k].add(e.id); if (!flow[e.k].has(key(e, e.id))) flow[e.k].set(key(e, e.id), { view: e, act: null, sent: null }); }
    const kind = e.type === 'decide.pick' && e.change !== 'unpick' ? 'd' : e.type === 'round.act' && e.change !== 'off' ? 'r' : null;
    if (kind) { answeredIds[kind].add(e.id); const f = flow[kind].get(key(e, e.id)); if (f && !f.act) f.act = e; }
    if (e.type === 'send.done' && e.ok) for (const it of e.items || []) { const g = flow[it.k === 'r' ? 'r' : 'd'].get(key(e, it.id)); if (g && !g.sent) g.sent = e; }
  }
  const timing = {};
  for (const [k, label] of [['d', 'decision'], ['r', 'round']]) {
    const toAct = [], toSend = [], steps = [], sameLoad = new Set();
    for (const f of flow[k].values()) {
      if (f.act) {
        sameLoad.add(f.view.id);
        toAct.push(f.act.t - f.view.t);
        steps.push(byPid.get(f.act.pid).filter((e) => e.t > f.view.t && e.t <= f.act.t && !NOT_HUMAN.test(e.type)).length);
      }
      if (f.sent) toSend.push(f.sent.t - f.view.t);
    }
    timing[label] = { viewed: viewedIds[k].size, answered: answeredIds[k].size, laterLoad: [...answeredIds[k]].filter((id) => viewedIds[k].has(id) && !sameLoad.has(id)).length, sent: toSend.length,
      viewToActMedianMs: median(toAct), viewToActP75Ms: quant(toAct, 0.75), viewToSendMedianMs: median(toSend), stepsMedian: median(steps) };
  }
  const changes = countBy(events, (e) => (CHANGE_KINDS[e.type + ':' + e.change] ? e.type + ':' + e.change : CHANGE_KINDS[e.type] ? e.type : undefined)).map(([k, n]) => ({ kind: k, label: CHANGE_KINDS[k], n }));
  const flipIds = countBy(events.filter((e) => (e.type === 'decide.pick' && e.change !== 'new') || (e.type === 'round.act' && e.change !== 'on')), (e) => e.id).filter(([, n]) => n >= 2).slice(0, 5).map(([id, n]) => ({ id, n }));
  const feat = new Map(countBy(events.filter((e) => !NON_ACTION.test(e.type)), (e) => e.type));
  // 来源：按打开次数（网页 page.open、手机 App app.open）
  const srcKey = (e) => (e.src || '?') + '/' + (e.dev || '?');
  const sources = countBy(events.filter((e) => e.type === 'page.open' || e.type === 'app.open'), srcKey).map(([k, n]) => ({ k, visits: n, events: events.filter((e) => srcKey(e) === k).length }));
  const slow = countBy(events.filter((e) => e.type === 'api.slow'), (e) => e.path).map(([p, n]) => { const ms = events.filter((e) => e.type === 'api.slow' && e.path === p).map((e) => e.ms); return { path: p, n, medianMs: median(ms), maxMs: Math.max(...ms) }; });
  const sends = events.filter((e) => e.type === 'send.done');
  return {
    since, until, events: events.length, visits: events.filter((e) => e.type === 'page.open').length,
    days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    blocks: BLOCKS.map(([label, f]) => ({ block: label, n: events.filter(f).length })),
    timing,
    changes: { total: changes.reduce((s, x) => s + x.n, 0), kinds: changes, flipIds },
    features: { top: [...feat].slice(0, 10).map(([type, n]) => ({ type, n })), never: FEATURE_TYPES.filter((t) => !feat.has(t)), otherActs: countBy(events.filter((e) => e.type === 'ui.other'), (e) => e.act).map(([act, n]) => ({ act, n })) },
    sources,
    widths: countBy(events.filter((e) => e.w), (e) => e.w).map(([w, n]) => ({ w, n })),
    send: { ok: sends.filter((e) => e.ok).length, failed: sends.filter((e) => !e.ok).length, medianMs: median(sends.filter((e) => e.ok).map((e) => e.ms).filter((x) => typeof x === 'number')), app: events.filter((e) => e.type === 'app.answer').length },
    errors: countBy(events.filter((e) => e.type === 'error.js'), (e) => e.msg).slice(0, 5).map(([msg, n]) => ({ msg, n })),
    apiErrors: (() => { const m = new Map(); for (const e of events.filter((x) => x.type === 'error.api')) { const k = e.path + ' ' + (e.status || e.kind || 0); m.set(k, (m.get(k) || 0) + (e.n || 1)); } return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })); })(),
    slow,
  };
}

const SRC_LABEL = { local: '本机 3080', remote: '远程 4080', 'local-3390': '本机 3390', app: '手机 App' };
const srcLabel = (k) => { const [s, d] = k.split('/'); return (SRC_LABEL[s] || s) + (d && d !== '?' && d !== 'desktop' ? '·' + ({ phone: '手机', tablet: '平板' }[d] || d) : ''); };
const pct = (n, all) => (all ? Math.round((n / all) * 100) + '%' : '—');
/** 给人看的摘要：每段一行。 */
export function summaryText(s, page) {
  if (!s.events) return page + '：' + stamp(s.since) + ' 起没有使用记录';
  const L = [];
  L.push(page + ' 使用摘要（' + stamp(s.since).slice(0, 11) + ' 起）：打开 ' + s.visits + ' 次，事件 ' + s.events + ' 条');
  L.push('每天：' + s.days.map((d) => d.day.slice(5) + ' 可见 ' + fmtMs(d.visibleMs) + ' / 操作 ' + fmtMs(d.activeMs) + '（打开 ' + d.visits + ' 次）').join('；'));
  L.push('区块打开：' + (s.blocks.filter((b) => b.n).map((b) => b.block + ' ' + b.n).join('，') || '—') + (s.blocks.some((b) => !b.n) ? '；没打开过：' + s.blocks.filter((b) => !b.n).map((b) => b.block).join('、') : ''));
  const td = s.timing.decision, tr = s.timing.round;
  L.push('决定：看过 ' + td.viewed + ' 个，选了 ' + td.answered + (td.laterLoad ? '（' + td.laterLoad + ' 个是下次打开页面才选）' : '') + '，发出 ' + td.sent + '；同一次打开里看到 → 选中位 ' + fmtMs(td.viewToActMedianMs) + '（P75 ' + fmtMs(td.viewToActP75Ms) + '，中位 ' + (td.stepsMedian ?? '—') + ' 步），看到 → 发出中位 ' + fmtMs(td.viewToSendMedianMs));
  L.push('轮次：看过 ' + tr.viewed + ' 个，点了按钮 ' + tr.answered + (tr.laterLoad ? '（' + tr.laterLoad + ' 个是下次打开才点）' : '') + '，发出 ' + tr.sent + '；同一次打开里看到 → 点按钮中位 ' + fmtMs(tr.viewToActMedianMs) + '，看到 → 发出中位 ' + fmtMs(tr.viewToSendMedianMs));
  L.push('改主意 ' + s.changes.total + ' 次' + (s.changes.total ? '：' + s.changes.kinds.map((k) => k.label + ' ' + k.n).join('，') : '') + (s.changes.flipIds.length ? '；反复改的：' + s.changes.flipIds.map((x) => x.id + '×' + x.n).join('，') : ''));
  L.push('最常用：' + (s.features.top.map((f) => f.type + ' ' + f.n).join('，') || '—'));
  L.push('没用过：' + (s.features.never.join('、') || '—'));
  const allVisits = s.sources.reduce((n, x) => n + x.visits, 0), allW = s.widths.reduce((n, x) => n + x.n, 0);
  L.push('来源（按打开次数）：' + s.sources.map((x) => srcLabel(x.k) + ' ' + pct(x.visits, allVisits)).join('，') + '；宽度（按事件）：' + (s.widths.map((x) => (x.w === 'narrow' ? '窄' : '宽') + ' ' + pct(x.n, allW)).join('，') || '—'));
  L.push('发送：成功 ' + s.send.ok + '，失败 ' + s.send.failed + '，中位 ' + fmtMs(s.send.medianMs) + (s.send.app ? '；手机 App 发送 ' + s.send.app : ''));
  const bad = [...s.errors.map((e) => e.msg + ' ×' + e.n), ...s.apiErrors.map((e) => '接口 ' + e.k + ' ×' + e.n)];
  L.push('报错：' + (bad.join('；') || '无'));
  L.push('慢请求（≥2s）：' + (s.slow.map((x) => x.path + ' ×' + x.n + ' 中位 ' + fmtMs(x.medianMs) + ' 最慢 ' + fmtMs(x.maxMs)).join('；') || '无'));
  return L.join('\n');
}

/** 3080 / 3390 请求的来源：经 4080 远程网关的请求带 x-forwarded-proto（网关补丁写的），本机直连没有。 */
export function sourceOf(req) { return req.headers['x-forwarded-proto'] ? 'remote' : 'local'; }
