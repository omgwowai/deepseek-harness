// Agent Fleet panel. Vanilla JS, no dependencies, no external network; every URL is relative so the page works
// at "/" and under "/fleet/". Sections: 1 pure helpers (exported to tests when there is no DOM) · 2 DOM kit ·
// 3 store · 4 transport · 5 views · 6 boot · 7 demo hub (?demo=1).
(() => {
'use strict';

/* ───────────────────────── 1. constants and pure helpers ───────────────────────── */

// Mirrors lib/protocol.mjs (the hub does not serve lib/ to the browser); tests/panel.test.mjs guards the drift.
const KINDS = ['dsh', 'claude', 'codex', 'omp'];
const KIND_LETTER = { dsh: 'D', claude: 'C', codex: 'X', omp: 'O' };
const KIND_NAME = { dsh: 'DeepSeek Harness', claude: 'Claude Code', codex: 'Codex', omp: 'Oh My Pi' };
const SITES = ['mac', 'server-bochao-01', 'sg-compute', 'chengdu', 'weihai', 'iron', 'os'];
const SITE_LABEL = { mac: '本机 Mac', 'server-bochao-01': 'server-bochao-01', 'sg-compute': 'sg-compute', chengdu: '成都 chengdu', weihai: '威海 weihai', iron: '乌兰察布 iron', os: '乌兰察布 osmium' };
const SITE_SHORT = { mac: 'Mac', 'server-bochao-01': 'server', 'sg-compute': 'sg', chengdu: 'cd', weihai: 'wh', iron: 'iron', os: 'os' };
const CATS = ['read', 'write', 'edit', 'search', 'shell', 'remote', 'k8s', 'spawn', 'web', 'coordination', 'other'];
const CAT_LABEL = { read: '读取 read', write: '写入 write', edit: '编辑 edit', search: '搜索 search', shell: 'Shell', remote: '远程 remote', k8s: 'K8s', spawn: '派生 spawn', web: 'Web', coordination: '协作 coord', other: '其他 other' };
const STATUS_LABEL = { running: '运行中', waiting: '等待用户', idle: '空闲', done: '完成', error: '错误', interrupted: '已中断', stale: '失联', unknown: '未知' };
const ROLE_LABEL = { main: '主', subagent: '子', fork: '分叉', side: '旁路', projection: '投影' };
const VIEWS = ['fleet', 'timeline', 'pods', 'files', 'feed'];
const NAMESPACE = 'mc-bochao-li';
const CLUSTER_ALIASES = {
  chengdu: 'chengdu', 'chengdu-h100': 'chengdu', cd: 'chengdu',
  weihai: 'weihai', 'weihai-h100': 'weihai', wh: 'weihai',
  'ulanqab-iron': 'iron', iron: 'iron', 'jiaqi-b300': 'iron', 'jq-b300': 'iron', ulanqab: 'iron', b300: 'iron',
  'ulanqab-osmium': 'os', osmium: 'os', os: 'os',
};
const GAP_MS = 15 * 60 * 1000;   // active axis: collapse quiet gaps longer than this
const GAP_VIRT = 90 * 1000;      // ... into this much virtual time
const RECENT_MS = 3 * 3600 * 1000;

const isActive = (a) => a.status === 'running' || a.status === 'waiting';

function siteOfCluster(name) {
  if (typeof name !== 'string') return null;
  const bare = name.trim().toLowerCase().replace(/^mixed-cloud-bochao-li-/, '').replace(/-mc-bochao-li$/, '');
  return CLUSTER_ALIASES[bare] ?? null;
}
function podKeyOfTarget(t) {
  if (!t || t.type !== 'pod' || !t.name) return null;
  const site = t.site || siteOfCluster(t.cluster);
  return site ? `${site}/${t.namespace || NAMESPACE}/${t.name}` : null;
}
function fileKeyOfTarget(t) { return t && t.type === 'file' && t.path ? `${t.host || '?'}:${t.path}` : null; }
function splitFileKey(key) { const i = key.indexOf(':'); return i < 0 ? { host: '', path: key } : { host: key.slice(0, i), path: key.slice(i + 1) }; }
/** Op class of a file touch: r = read/list/search/exec, w = write, e = edit/delete. */
function fileOpClass(op) { return op === 'write' ? 'w' : op === 'edit' || op === 'delete' ? 'e' : 'r'; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** Clip to a pixel budget at ~11 px UI text: CJK / full-width glyphs count 11.4 px, everything else 6.1 px; "…" costs 6.1. */
function clipPx(s, px) {
  s = String(s ?? '');
  const width = (c) => ((c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ? 11.4 : 6.1);
  let total = 0;
  for (let i = 0; i < s.length; i++) total += width(s.charCodeAt(i));
  if (total <= px) return s;
  let w = 0, end = 0;
  while (end < s.length && w + width(s.charCodeAt(end)) + 6.1 <= px) w += width(s.charCodeAt(end++));
  return end > 0 ? s.slice(0, end) + '…' : '';
}
const pad2 = (n) => String(n).padStart(2, '0');
function fmtClock(t, ms) { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${ms ? '.' + String(d.getMilliseconds()).padStart(3, '0') : ''}`; }
function fmtDateTime(t) { const d = new Date(t); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClock(t)}`; }
function fmtDur(ms) {
  if (!(ms >= 0)) return '–';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 9.95) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + pad2(Math.floor(s % 60)) + 's';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h' + pad2(m % 60) + 'm';
  return Math.floor(h / 24) + 'd' + pad2(h % 24) + 'h';
}
function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h < 10 && m ? `${h}h${m}m` : h + 'h'; }
  return Math.floor(s / 86400) + 'd';
}
function fmtNum(n) {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n), t = (x) => x.toFixed(1).replace(/\.0$/, '');
  if (a < 1000) return String(Math.round(n));
  if (a < 1e4) return t(n / 1e3) + 'k';
  if (a < 1e6) return Math.round(n / 1e3) + 'k';
  if (a < 1e7) return t(n / 1e6) + 'M';
  if (a < 1e9) return Math.round(n / 1e6) + 'M';
  return t(n / 1e9) + 'B';
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(1) + ' MiB';
}
const shortHost = (id) => String(id || '').replace(/^k8s\//, '');
const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || String(p || '');
const dirName = (p) => { const s = String(p || ''), i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i + 1) : ''; };
function agentTitle(a) {
  const t = (a.title || '').trim() || (a.name || a.description || '').trim();
  if (t) return t;
  const dir = String(a.cwd || '').split('/').filter(Boolean).pop();
  return (dir ? dir + ' · ' : '') + String(a.id).slice(0, 8);
}
/** Container state strings are free text ("running", "waiting: CrashLoopBackOff", "terminated: Completed (0)"). */
function containerClass(state) {
  const s = String(state || '').toLowerCase();
  if (s.startsWith('running')) return 'running';
  if (/crash|error|oomkilled|imagepull|backoff|invalid|failed/.test(s)) return 'bad';
  if (s.startsWith('waiting')) return 'waiting';
  if (s.startsWith('terminated')) return /\(0\)|completed/.test(s) ? 'terminated' : 'bad';
  return 'terminated';
}

/** Effective parent edges: hub `links` first, then the `parent.key` hint of agents the hub has not linked. An edge that would close a cycle is refused. */
function buildGraph(agents, links) {
  const parent = new Map();
  const link = (from, to, l) => {
    if (from === to || parent.has(to) || !agents.has(from) || !agents.has(to)) return;
    for (let c = from, n = 0; c !== undefined && n < 500; n++) {
      if (c === to) return;
      const p = parent.get(c);
      c = p && p.from;
    }
    parent.set(to, { from, link: l });
  };
  for (const l of links || []) link(l.from, l.to, l);
  for (const a of agents.values()) {
    const pk = a.parent && a.parent.key, p = pk && agents.get(pk);
    if (p) link(pk, a.key, { from: pk, to: a.key, via: a.parent.via, exact: !!a.parent.exact, toolCallId: a.parent.toolCallId, crossHost: p.host !== a.host, crossSite: p.site !== a.site });
  }
  const kids = new Map();
  for (const [to, { from }] of parent) { let l = kids.get(from); if (!l) kids.set(from, (l = [])); l.push(to); }
  for (const l of kids.values()) l.sort((x, y) => (agents.get(x).startedAt - agents.get(y).startedAt) || (x < y ? -1 : 1));
  return { parent, kids };
}
function rootOf(g, key) { let cur = key; for (let n = 0; n < 200 && g.parent.has(cur); n++) cur = g.parent.get(cur).from; return cur; }
/** Preorder list of key and all its descendants (children in start order). */
function subtree(g, key) {
  const out = [], seen = new Set(), stack = [key];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k); out.push(k);
    const ks = g.kids.get(k);
    if (ks) for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  }
  return out;
}
/** `#focus=<id>`: the DSH session with that id, else a native session ACP-bound to it, else any session with that id. */
function resolveFocus(agents, g, focus) {
  if (!focus) return null;
  let best = null;
  const consider = (a, score) => { if (!best || score > best.score || (score === best.score && (a.updatedAt || 0) > (best.a.updatedAt || 0))) best = { a, score }; };
  for (const a of agents.values()) {
    if (a.kind === 'dsh' && a.id === focus && a.role !== 'projection') consider(a, 4);
    else if (a.parent && a.parent.via === 'acp' && a.parent.kind === 'dsh' && a.parent.id === focus) consider(a, 3);
    else if (a.acp && a.acp.id === focus) consider(a, 2);
    else if (a.id === focus) consider(a, 1);
  }
  return best ? { key: best.a.key, root: rootOf(g, best.a.key) } : null;
}

/**
 * Interval coloring for the Gantt. `nodes` is a preorder list [{key, parent, host, start, end}] (end may be Infinity).
 * A root always opens a new lane at the bottom. A child takes the first free lane of its own host inside its parent's
 * lane block (the lanes just below the parent), otherwise a new lane is inserted at the bottom of that block, so children
 * sit next to their parent and finished siblings' lanes are reused. Returns {lane: Map(key → index), hosts[], count}.
 */
function packLanes(nodes) {
  const lanes = [], laneOf = new Map(), bottom = new Map(), parentOf = new Map();
  const idx = (L) => lanes.indexOf(L);
  for (const n of nodes) {
    const p = n.parent != null && laneOf.has(n.parent) ? n.parent : null;
    parentOf.set(n.key, p);
    let lane = null;
    if (p) for (let i = idx(laneOf.get(p)) + 1, hi = idx(bottom.get(p)); i <= hi; i++) if (lanes[i].host === n.host && lanes[i].end <= n.start) { lane = lanes[i]; break; }
    if (!lane) { lane = { host: n.host, end: -Infinity }; lanes.splice(p ? idx(bottom.get(p)) + 1 : lanes.length, 0, lane); }
    lane.end = Math.max(lane.end, n.end, n.start);
    laneOf.set(n.key, lane); bottom.set(n.key, lane);
    for (let a = p; a != null; a = parentOf.get(a)) { if (idx(bottom.get(a)) >= idx(lane)) break; bottom.set(a, lane); }
  }
  const lane = new Map();
  for (const [k, L] of laneOf) lane.set(k, idx(L));
  return { lane, hosts: lanes.map((l) => l.host), count: lanes.length };
}

/**
 * Time axis. `spans` are activity intervals [start,end]; with a finite `collapseMs`, quiet gaps longer than it shrink to
 * GAP_VIRT. D maps real time to the axis domain (monotonic, piecewise linear), T inverts it.
 */
function makeAxis(spans, collapseMs) {
  const gaps = [];
  if (Number.isFinite(collapseMs)) {
    const arr = spans.filter((s) => s[1] >= s[0]).sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    for (const [s, e] of arr) {
      if (end !== -Infinity && s - end > collapseMs) gaps.push({ s: end, e: s, len: s - end });
      if (e > end) end = e;
    }
    let cum = 0;
    for (const g of gaps) { g.cum = cum; g.d0 = g.s - cum; cum += g.len - GAP_VIRT; }
  }
  const last = (key, v) => { let lo = 0, hi = gaps.length; while (lo < hi) { const m = (lo + hi) >> 1; if (gaps[m][key] < v) lo = m + 1; else hi = m; } return lo - 1; };
  const D = (t) => {
    const i = last('s', t);
    if (i < 0) return t;
    const g = gaps[i];
    return t >= g.e ? t - g.cum - (g.len - GAP_VIRT) : g.d0 + (GAP_VIRT * (t - g.s)) / g.len;
  };
  const T = (d) => {
    const i = last('d0', d);
    if (i < 0) return d;
    const g = gaps[i];
    return d >= g.d0 + GAP_VIRT ? d + g.cum + (g.len - GAP_VIRT) : g.s + ((d - g.d0) / GAP_VIRT) * g.len;
  };
  return { gaps, D, T };
}
const TICK_STEPS = [1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3, 172800e3, 604800e3];
function pickStep(msPerPx, minPx) { const need = msPerPx * minPx; for (const s of TICK_STEPS) if (s >= need) return s; return TICK_STEPS[TICK_STEPS.length - 1]; }
function tickTimes(t0, t1, step) {
  const out = [], off = -new Date(t0).getTimezoneOffset() * 60000;
  for (let t = Math.ceil((t0 + off) / step) * step - off; t <= t1 && out.length < 400; t += step) out.push(t);
  return out;
}
/** Occupied buckets (Set of integer ids of `size` ms) → sorted, merged [start,end] spans in ms. */
function bucketSpans(buckets, size = 60000) {
  const arr = [...buckets].sort((a, b) => a - b), out = [];
  for (const b of arr) {
    const last = out[out.length - 1];
    if (last && b * size <= last[1]) last[1] = (b + 1) * size; else out.push([b * size, (b + 1) * size]);
  }
  return out;
}
/** Real-time pieces of [t0,t1] that lie outside collapsed gaps (axis labels are only placed on these). */
function visibleSegments(gaps, t0, t1) {
  const out = [];
  let cur = t0;
  for (const g of gaps) {
    if (g.e <= t0) continue;
    if (g.s >= t1) break;
    if (g.s > cur) out.push([cur, g.s]);
    cur = Math.max(cur, g.e);
  }
  if (cur < t1) out.push([cur, t1]);
  return out;
}

/** Incremental server-sent-events parser: push(text) calls onEvent({event, data, id}) for every complete frame. */
function createSseParser(onEvent) {
  let buf = '', event = '', id = '', data = [];
  return (chunk) => {
    buf += chunk;
    for (;;) {
      const m = /\r\n|\n|\r(?!$)/.exec(buf);
      if (!m) return;
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === '') {
        if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), id });
        event = ''; data = [];
      } else if (line[0] !== ':') {
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        let value = c < 0 ? '' : line.slice(c + 1);
        if (value[0] === ' ') value = value.slice(1);
        if (field === 'event') event = value; else if (field === 'data') data.push(value); else if (field === 'id') id = value;
      }
    }
  };
}

function parseHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const view = p.get('view');
  return {
    view: VIEWS.includes(view) ? view : null,
    key: p.get('key') || '', site: p.get('site') || '', q: p.get('q') || '', focus: p.get('focus') || '',
    kinds: (p.get('kind') || '').split(',').filter((k) => KINDS.includes(k)),
    pod: p.get('pod') || '', file: p.get('file') || '', token: p.get('token') || '', nonce: p.get('nonce') || '',
  };
}
function buildHash(st) {
  const p = new URLSearchParams();
  p.set('view', st.view || 'fleet');
  if (st.key) p.set('key', st.key);
  if (st.site) p.set('site', st.site);
  if (st.kinds && st.kinds.length) p.set('kind', st.kinds.join(','));
  if (st.q) p.set('q', st.q);
  if (st.focus) p.set('focus', st.focus);
  if (st.pod) p.set('pod', st.pod);
  if (st.file) p.set('file', st.file);
  return '#' + p.toString().replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%2C/g, ',');
}

/** Aggregates a Map(eventKey → touch) into counts, last touch, agents and ops. */
function summarizeTouches(map) {
  const out = { n: 0, r: 0, w: 0, e: 0, last: 0, lastTouch: null, agents: new Map(), ops: new Map() };
  for (const t of map.values()) {
    out.n++; out[fileOpClass(t.op)]++;
    if (t.t > out.last) { out.last = t.t; out.lastTouch = t; }
    const a = out.agents.get(t.agent);
    if (!a) out.agents.set(t.agent, { n: 1, last: t.t }); else { a.n++; if (t.t > a.last) a.last = t.t; }
    const op = t.op || '?';
    out.ops.set(op, (out.ops.get(op) || 0) + 1);
  }
  return out;
}

/* Pure render fragments. They live here, not in the DOM kit, because tests load this file without a document. */
const ico = (name, cls = '') => `<svg class="ico ${cls}"><use href="#i-${name}"/></svg>`;
const kindBadge = (kind, cls = '') => `<span class="kb k-${esc(kind)} ${cls}" title="${esc(KIND_NAME[kind] || kind)}">${KIND_LETTER[kind] || '?'}</span>`;
const statusDot = (status) => `<i class="sd s-${esc(status || 'unknown')}" title="${esc(STATUS_LABEL[status] || status || '')}"></i>`;

/**
 * Pure signature of one fleet-tree agent row: everything that changes its markup except clock-derived text. Age and
 * the live "since" counter live in `[data-live]` cells refreshed by refreshTimes(), so a quiet fleet costs no rebuilds.
 */
function agentRowSig(a, o) {
  return [a._v, o.depth, o.ghost ? 1 : 0, o.kids, o.open ? 1 : 0, o.sel ? 1 : 0, o.tab, o.xhost, a.status].join('|');
}

/** Markup of one fleet-tree agent row. `o` is the row context {depth, kids, open, xhost, link, rowKey, now}. */
function agentRowHtml(a, o) {
  const live = a.live || {}, us = a.usage || {}, c = a.counts || {}, t = o.now;
  const ageBase = a.updatedAt || a.startedAt || t;
  const sinceBase = isActive(a) && live.since ? live.since : 0;
  const doing = live.doing || '';
  const tok = us.input != null || us.output != null ? `${fmtNum(us.input)}/${fmtNum(us.output)}/${fmtNum(us.cacheRead)}` : '';
  const title = agentTitle(a);
  const label = a.role !== 'main' && a.name ? `${esc(a.name)}${title && title !== a.name ? `<span class="muted"> · ${esc(clip(title, 70))}</span>` : ''}` : esc(title);
  return `<div class="nm" style="--depth:${o.depth + 1}">${o.kids ? `<button type="button" class="caret" data-toggle="${esc(o.rowKey)}" tabindex="-1" aria-label="${o.open ? '折叠' : '展开'}">${ico('caret')}</button>` : '<span class="spacer"></span>'}${kindBadge(a.kind)}${statusDot(a.status)}<span class="title">${label}</span>${a.role !== 'main' ? `<span class="tag" title="${esc(a.role)}">${esc(ROLE_LABEL[a.role] || a.role)}</span>` : ''}${o.xhost ? `<span class="chip xhost xref" title="跨主机 · ${esc(o.link ? 'via ' + o.link.via + (o.link.exact ? ' (exact)' : ' (推断 inferred)') : '')}">${esc(o.xhost)}</span>` : ''}</div>
    <div class="c-model" title="${esc(a.model || '')}">${esc(a.model || '')}${a.effort ? `<span class="muted"> · ${esc(a.effort)}</span>` : ''}</div>
    <div class="c-doing${isActive(a) ? ' live' : ''}" title="${esc(doing)}">${doing ? esc(clip(doing, 100)) : '<span class="muted">—</span>'}${sinceBase ? ` <span class="muted" data-live="since" data-t="${sinceBase}">${fmtDur(t - sinceBase)}</span>` : ''}</div>
    <div class="c-tok" title="tokens in / out / cache-read${us.cost != null ? ' · cost $' + us.cost : ''}">${tok}</div>
    <div class="c-age" data-live="age" data-t="${ageBase}" title="${a.updatedAt ? esc(fmtDateTime(a.updatedAt)) : ''}">${fmtAge(t - ageBase)}</div>
    <div class="c-cnt"><span title="tool calls">⚙${c.tools || 0}</span>${c.errors ? `<span class="bad" title="errors">⚠${c.errors}</span>` : ''}${c.subagents ? `<span title="subagents">⑂${c.subagents}</span>` : ''}</div>`;
}

const agentRowModel = (a, o) => ({ sig: agentRowSig(a, o), html: agentRowHtml(a, o) });

if (typeof document === 'undefined') {   // loaded by tests: expose the pure part and stop
  globalThis.__fleetPure = {
    KINDS, SITES, CATS, NAMESPACE, SITE_LABEL, STATUS_LABEL, ROLE_LABEL, CAT_LABEL, GAP_MS, GAP_VIRT, siteOfCluster, podKeyOfTarget, fileKeyOfTarget,
    splitFileKey, fileOpClass, fmtDur, fmtAge, fmtNum, fmtBytes, agentTitle, containerClass, buildGraph, rootOf, subtree, resolveFocus,
    packLanes, makeAxis, pickStep, tickTimes, bucketSpans, visibleSegments, createSseParser, parseHash, buildHash, summarizeTouches, esc, clip, clipPx,
    ico, kindBadge, statusDot, agentRowSig, agentRowHtml, agentRowModel, isActive,
  };
  return;
}

/* ───────────────────────── 2. DOM kit ───────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

/**
 * Keyed list reconcile. items = [{key, tag?, cls, attrs?, sig, html}] where html is a string or a function called only
 * when `sig` changed. Elements are reused and moved, never rebuilt, so scroll, hover and focus survive live updates.
 */
function reconcile(parent, items) {
  const map = parent._km || (parent._km = new Map());
  const seen = new Set();
  let ref = parent.firstElementChild;
  for (const it of items) {
    let el = map.get(it.key);
    if (!el) { el = document.createElement(it.tag || 'div'); el._sig = null; map.set(it.key, el); }
    if (el._sig !== it.sig) {
      el._sig = it.sig;
      if (el.className !== (it.cls || '')) el.className = it.cls || '';
      const next = it.attrs || {};
      if (el._attrs) for (const k of el._attrs) if (!(k in next)) el.removeAttribute(k);
      for (const k in next) if (el.getAttribute(k) !== next[k]) el.setAttribute(k, next[k]);
      el._attrs = Object.keys(next);
      const html = typeof it.html === 'function' ? it.html() : it.html;
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
    }
    seen.add(it.key);
    if (el === ref) ref = ref.nextElementSibling; else parent.insertBefore(el, ref);
  }
  if (seen.size !== map.size) for (const [k, el] of map) if (!seen.has(k)) { el.remove(); map.delete(k); }
}
function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

const tipEl = byId('tip');
function showTip(html, x, y) {
  tipEl.innerHTML = html; tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  let left = x + 14, top = y + 16;
  if (left + r.width > innerWidth - 6) left = Math.max(6, x - r.width - 14);
  if (top + r.height > innerHeight - 6) top = Math.max(6, y - r.height - 14);
  tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
}
const hideTip = () => { tipEl.hidden = true; };

const catIcon = (ev) => {
  const c = ev.type === 'error' ? 'error' : ev.type === 'user' ? 'user' : ev.type === 'model' ? 'model' : ev.type === 'message' ? 'coordination' : CATS.includes(ev.category) ? ev.category : ev.type === 'spawn' ? 'spawn' : 'other';
  const cls = ev.type === 'error' ? 'ev-error' : ev.type === 'user' ? 'ev-user' : ev.type === 'model' ? 'ev-model' : 'cat-' + c;
  return `<span class="cat ${cls}" title="${esc(ev.type === 'tool' || ev.type === 'spawn' ? CAT_LABEL[ev.category] || ev.category || ev.type : ev.type)}">${ico(c)}</span>`;
};
const urlHost = (u) => { try { return new URL(u).host; } catch { return clip(u, 26); } };
const hostLabel = (id) => (S.hosts.get(id) && S.hosts.get(id).label) || shortHost(id);

function agentChip(key, max = 26) {
  const a = S.agents.get(key);
  if (!a) return `<span class="chip mono" title="${esc(key)}">${esc(clip(shortHost(key), max))}</span>`;
  return `<button type="button" class="chip" data-go="agent:${esc(key)}" title="${esc(agentTitle(a))} · ${esc(shortHost(a.host))}">${kindBadge(a.kind)}${statusDot(a.status)}<span>${esc(clip(agentTitle(a), max))}</span></button>`;
}
function podChip(key, label) {
  const name = label || key.split('/').slice(2).join('/');
  return `<button type="button" class="chip t-pod mono" data-go="pod:${esc(key)}" title="${esc(key)}">${ico('pod', 'sm')}${esc(clip(name, 30))}</button>`;
}
function fileChip(fileKey, label) {
  const { host, path } = splitFileKey(fileKey);
  return `<button type="button" class="chip t-file mono" data-go="file:${esc(fileKey)}" title="${esc(shortHost(host) + ':' + path)}">${ico('read', 'sm')}${esc(clip(label || baseName(path), 30))}</button>`;
}
function targetChip(t) {
  switch (t.type) {
    case 'file': { const k = fileKeyOfTarget(t); return k ? fileChip(k, (t.op ? t.op + '·' : '') + baseName(t.path)) : ''; }
    case 'pod': { const k = podKeyOfTarget(t); return k ? podChip(k, (t.op ? t.op + '·' : '') + t.name) : `<span class="chip t-pod mono">${esc((t.op || 'pod') + '·' + (t.name || '?'))}</span>`; }
    case 'k8s': return `<span class="chip t-k8s mono" title="${esc([t.cluster, t.namespace, t.resource, t.name].filter(Boolean).join('/'))}">${ico('k8s', 'sm')}${esc(clip([t.resource, t.name].filter(Boolean).join('/') || 'k8s', 28))}</span>`;
    case 'host': return `<span class="chip t-host mono" title="${esc((t.op || 'ssh') + ' ' + (t.host || ''))}${t.site ? ' · ' + esc(t.site) : ''}">${ico('host', 'sm')}${esc(clip(t.host || 'host', 24))}</span>`;
    case 'url': return `<span class="chip t-url mono" title="${esc(t.url)}">${ico('web', 'sm')}${esc(urlHost(t.url))}</span>`;
    case 'agent': return `<span class="chip t-agent mono" title="launch ${esc(t.kind || '')} ${esc(t.pod || t.site || '')}">${ico('spawn', 'sm')}${esc(clip(`${t.kind || 'agent'}@${t.pod || t.site || ''}`, 26))}</span>`;
    default: return '';
  }
}

/* ───────────────────────── 3. store ───────────────────────── */

const S = {
  demo: null, token: '',
  loaded: false, cursor: 0, hub: null,
  hosts: new Map(), agents: new Map(), links: [], pods: new Map(), sources: {},
  feed: [], feedIdx: new Map(),                      // feed items {agent, event}, newest first by event.t
  stores: new Map(),                                  // agentKey → {list, byId, ver, loaded, hasMore, maxDur, pend, fetchedAt, sig}
  touch: { pods: new Map(), files: new Map() },       // entity key → Map(agentKey|eventId → touch)
  ver: { agents: 0, links: 0, pods: 0, hosts: 0, feed: 0, touch: 0, events: 0 },
  recSeq: 0, clockOffset: 0, lastDeltaAt: 0, lastContactAt: 0,
  conn: { state: 'connecting', error: '', retryAt: 0 },
  graph: null, graphVer: '',
  ui: {
    view: 'fleet', key: '', ev: '', site: '', kinds: new Set(), q: '', focus: '', pod: '', file: '',
    status: 'recent', proj: false, exp: new Map(), expandMode: 'auto', drawer: null,
    podSite: '', podPhase: '', podTouched: false, podQ: '',
    fileHost: '', fileAgent: '', fileOps: new Set(), fileQ: '', fileEvent: '',
    feedKinds: new Set(), feedCat: '', feedErr: false, feedQ: '', feedPaused: false, feedFrozen: null,
    focusRow: '', evFilter: 'all', evShow: 120,
  },
};
const now = () => Date.now() + S.clockOffset;
const stamp = (o) => { o._v = ++S.recSeq; return o; };
function getGraph() {
  const v = S.ver.agents + ':' + S.ver.links;
  if (S.graphVer !== v) { S.graph = buildGraph(S.agents, S.links); S.graphVer = v; }
  return S.graph;
}

function applySnapshot(snap) {
  S.cursor = snap.cursor || 0; S.hub = snap.hub || null;
  S.clockOffset = Number.isFinite(snap.now) ? snap.now - Date.now() : 0;
  S.hosts = new Map((snap.hosts || []).map((h) => [h.id, stamp(h)]));
  S.agents = new Map((snap.agents || []).map((a) => [a.key, stamp(a)]));
  S.links = snap.links || [];
  S.pods = new Map((snap.pods || []).map((p) => [p.key, stamp(p)]));
  S.sources = snap.sources || {};
  S.feed = []; S.feedIdx = new Map();
  for (const f of snap.feed || []) addFeed(f.agent, f.event);
  for (const k in S.ver) S.ver[k]++;
  S.loaded = true; S.lastDeltaAt = S.lastContactAt = Date.now();
  scheduleRender('all');
}
function applyDelta(d) {
  if (Number.isFinite(d.now)) S.clockOffset += (d.now - Date.now() - S.clockOffset) * 0.3;
  let changed = false;
  if (d.hosts && d.hosts.length) { for (const h of d.hosts) S.hosts.set(h.id, stamp(h)); S.ver.hosts++; changed = true; }
  if (d.agents && d.agents.length) { for (const a of d.agents) S.agents.set(a.key, stamp(a)); S.ver.agents++; changed = true; }
  if (d.removed && d.removed.length) { for (const k of d.removed) { S.agents.delete(k); S.stores.delete(k); } S.ver.agents++; changed = true; }
  if (d.links) { S.links = d.links; S.ver.links++; changed = true; }
  if (d.pods && d.pods.length) { for (const p of d.pods) S.pods.set(p.key, stamp(p)); S.ver.pods++; changed = true; }
  if (d.podsRemoved && d.podsRemoved.length) { for (const k of d.podsRemoved) S.pods.delete(k); S.ver.pods++; changed = true; }
  if (d.sources) { Object.assign(S.sources, d.sources); S.ver.hosts++; changed = true; }
  if (d.feed && d.feed.length) { for (const f of d.feed) addFeed(f.agent, f.event); S.ver.feed++; changed = true; }
  if (Number.isFinite(d.cursor) && d.cursor > S.cursor) S.cursor = d.cursor;
  if (changed) S.lastDeltaAt = Date.now();
  S.lastContactAt = Date.now();
  if (changed) scheduleRender('data');
}

function storeOf(key) {
  let s = S.stores.get(key);
  if (!s) { s = { list: [], byId: new Map(), ver: 0, loaded: false, hasMore: true, maxDur: 0, pend: new Set(), fetchedAt: 0, sig: 0 }; S.stores.set(key, s); }
  return s;
}
function insertSorted(list, e) { let i = list.length; while (i > 0 && list[i - 1].t > e.t) i--; list.splice(i, 0, e); }
/** Upsert by event id (a pending tool is re-sent with status/duration). Returns the stored object. */
function upsertEvent(agentKey, e) {
  const s = storeOf(agentKey);
  const old = s.byId.get(e.id);
  if (old) {
    const moved = e.t !== old.t;
    Object.assign(old, e);
    if (moved) { s.list.splice(s.list.indexOf(old), 1); insertSorted(s.list, old); }
    e = old;
  } else { s.byId.set(e.id, e); insertSorted(s.list, e); }
  if (e.duration > s.maxDur) s.maxDur = e.duration;
  if (e.status === 'pending') s.pend.add(e.id); else s.pend.delete(e.id);
  s.ver++; S.ver.events++;
  return e;
}
function putTouch(map, key, agentKey, e, t) {
  let m = map.get(key);
  if (!m) map.set(key, (m = new Map()));
  m.set(agentKey + '|' + e.id, { agent: agentKey, id: e.id, t: e.t, op: t.op, cat: e.category, name: e.name, preview: e.preview, status: e.status });
  S.ver.touch++;
}
/** The hub defaults a file target without `host` to the host of the agent that made the call; so does the panel. */
function ingestEvent(agentKey, e) {
  if (!e || e.id == null || !Number.isFinite(e.t)) return null;
  const stored = upsertEvent(agentKey, e);
  if (stored.targets) {
    const hostId = agentKey.slice(0, Math.max(0, agentKey.indexOf('#')));
    for (const t of stored.targets) {
      if (t.type === 'pod') { const k = podKeyOfTarget(t); if (k) putTouch(S.touch.pods, k, agentKey, stored, t); }
      else if (t.type === 'file') {
        if (!t.host && hostId) t.host = hostId;
        const k = fileKeyOfTarget(t);
        if (k) putTouch(S.touch.files, k, agentKey, stored, t);
      }
    }
  }
  return stored;
}
const FEED_MAX = 800;
function addFeed(agentKey, ev) {
  const stored = ingestEvent(agentKey, ev);
  if (!stored) return;
  const id = agentKey + '|' + stored.id;
  if (S.feedIdx.has(id)) return;                        // same stored object: already shows the update
  const item = { agent: agentKey, event: stored };
  S.feedIdx.set(id, item);
  let i = 0;
  while (i < S.feed.length && S.feed[i].event.t > stored.t) i++;
  S.feed.splice(i, 0, item);
  if (S.feed.length > FEED_MAX) { const gone = S.feed.pop(); S.feedIdx.delete(gone.agent + '|' + gone.event.id); }
}

const inflight = new Map();
function once(key, fn) { if (inflight.has(key)) return inflight.get(key); const p = fn().finally(() => inflight.delete(key)); inflight.set(key, p); return p; }
const hasMoreFor = (key, s, reported) => (typeof reported === 'boolean' ? reported : ((S.agents.get(key) || {}).counts || {}).events > s.list.length);

function loadAgentTail(key, limit = 300) {
  return once('tail:' + key, async () => {
    const sig = (S.agents.get(key) || {}).updatedAt || 0;
    const r = await api('agent', { key, limit });
    for (const e of r.events || []) ingestEvent(key, e);
    const s = storeOf(key);
    s.loaded = true; s.fetchedAt = Date.now(); s.sig = sig; s.hasMore = hasMoreFor(key, s, r.hasMore);
    scheduleRender('events');
  });
}
function loadOlder(key, limit = 200) {
  return once('older:' + key, async () => {
    const s = storeOf(key), had = s.list.length;
    const r = await api('agent', { key, before: s.list.length ? s.list[0].t + 1 : undefined, limit });   // +1: ties at the page edge are re-sent and de-duplicated by id
    for (const e of r.events || []) ingestEvent(key, e);
    s.hasMore = s.list.length > had ? hasMoreFor(key, s, r.hasMore) : false;
    scheduleRender('events');
  });
}
function loadFamily(root) {
  return once('family:' + root, async () => {
    const r = await api('family', { key: root });
    const evs = r.events || {};
    for (const k of Object.keys(evs)) {
      const sig = (S.agents.get(k) || {}).updatedAt || 0;
      for (const e of evs[k]) ingestEvent(k, e);
      const s = storeOf(k);
      s.loaded = true; s.fetchedAt = Date.now(); s.sig = sig; s.hasMore = hasMoreFor(k, s, undefined);
    }
    scheduleRender('events');
  });
}
/** Keeps the event stores of `keys` fresh: load missing ones, re-fetch the tail of agents that moved on (at most every `minAge` ms). */
function refreshStores(keys, minAge = 2500) {
  let budget = 4;
  for (const k of keys) {
    const a = S.agents.get(k);
    if (!a || inflight.size >= 6) continue;
    const s = storeOf(k), age = Date.now() - s.fetchedAt;
    const stale = s.loaded ? a.updatedAt > s.sig && age > minAge : age > 6000;
    if (stale && budget-- > 0) loadAgentTail(k, s.loaded ? 120 : 400).catch(() => { s.fetchedAt = Date.now(); });
  }
}

/* ───────────────────────── 4. transport ───────────────────────── */

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
// Root-relative base of the page so "api/…" resolves under "/" and "/fleet/" alike, even for "/fleet" without a slash.
const API_BASE = (() => {
  const p = location.pathname;
  if (p.endsWith('/')) return p;
  const last = p.slice(p.lastIndexOf('/') + 1);
  return last.includes('.') ? p.slice(0, p.lastIndexOf('/') + 1) : p + '/';
})();
const authHeaders = () => (S.token ? { 'x-agent-fleet-token': S.token } : {});

async function api(name, params) {
  if (S.demo) return S.demo.api(name, params || {});
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  let res;
  try { res = await fetch(`${API_BASE}api/${name}${q ? '?' + q : ''}`, { headers: authHeaders(), credentials: 'same-origin', cache: 'no-store' }); }
  catch (e) { throw new ApiError(0, '网络错误 network: ' + (e.message || e)); }
  let body = null;
  try { body = await res.json(); } catch { /* error pages are not JSON */ }
  if (!res.ok) throw new ApiError(res.status, (body && body.error) || `${res.status} ${res.statusText}`);
  return body;
}

const net = { gen: 0, es: null, abort: null, unsub: null, poll: 0, probe: 0, retry: 0, sseRetry: 0, fails: 0, streamFails: 0, pollFails: 0, mode: 'sse' };
function setConn(state, error) {
  if (S.conn.state === state && S.conn.error === (error || '')) return;
  S.conn.state = state; S.conn.error = error || '';
  renderConn();
}
function stopStream() {
  clearInterval(net.probe);
  if (net.es) { net.es.close(); net.es = null; }
  if (net.abort) { net.abort.abort(); net.abort = null; }
  if (net.unsub) { net.unsub(); net.unsub = null; }
}
function stopTransport() { clearTimeout(net.poll); clearTimeout(net.retry); clearTimeout(net.sseRetry); stopStream(); }
/** (Re)load the snapshot, then follow with the stream. Failure → "down" banner and exponential-backoff retry. */
async function connect() {
  const gen = ++net.gen;
  stopTransport();
  if (S.conn.state !== 'down') setConn('connecting');
  try { applySnapshot(await api('snapshot')); }
  catch (e) { if (gen === net.gen) failed(gen, e); return; }
  if (gen !== net.gen) return;
  net.fails = 0; net.streamFails = 0; net.pollFails = 0;
  startStream(gen);
}
function failed(gen, err) {
  if (gen !== net.gen) return;
  stopTransport();
  net.fails++;
  const wait = Math.min(15000, 1000 * 2 ** Math.min(net.fails - 1, 4));
  S.conn.retryAt = Date.now() + wait;
  setConn('down', (err && err.message) || String(err));
  renderConn();
  net.retry = setTimeout(connect, wait);
}
function onDelta(d) { if (d && d.reset) connect(); else if (d) applyDelta(d); }

function startStream(gen) {
  net.mode = 'sse';
  stopStream();
  const fail = () => {
    if (gen !== net.gen || net.mode !== 'sse') return;
    stopStream();
    net.streamFails++;
    if (net.streamFails >= 3 || (!S.demo && !S.token && !('EventSource' in window))) startPolling(gen);
    else net.retry = setTimeout(() => { if (gen === net.gen) startStream(gen); }, 400 * net.streamFails);
  };
  if (S.demo) { net.unsub = S.demo.subscribe(onDelta, fail); if (net.unsub) setConn('live'); return; }
  const url = `${API_BASE}api/stream?since=${S.cursor}`;
  if (!S.token && 'EventSource' in window) {
    const es = new EventSource(url);
    net.es = es;
    es.onopen = () => { net.streamFails = 0; setConn('live'); };
    es.addEventListener('delta', (ev) => { try { onDelta(JSON.parse(ev.data)); } catch (e) { console.error('bad delta', e); } });
    es.onerror = fail;
  } else {                                              // the token travels in a header → fetch-based SSE (EventSource cannot set headers)
    const ac = new AbortController();
    net.abort = ac;
    (async () => {
      try {
        const res = await fetch(url, { headers: { ...authHeaders(), accept: 'text/event-stream' }, credentials: 'same-origin', cache: 'no-store', signal: ac.signal });
        if (!res.ok || !res.body) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
        net.streamFails = 0; setConn('live');
        const dec = new TextDecoder();
        const parse = createSseParser((m) => { if (m.event === 'delta') { try { onDelta(JSON.parse(m.data)); } catch (e) { console.error('bad delta', e); } } });
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          S.lastContactAt = Date.now();                // keep-alive comments count as contact
          parse(dec.decode(value, { stream: true }));
        }
        fail();
      } catch (e) { if (!ac.signal.aborted) fail(); }
    })();
  }
  // EventSource hides keep-alive comments, so probe when nothing arrived for a while: catches silent drops.
  net.probe = setInterval(async () => {
    if (gen !== net.gen || Date.now() - S.lastContactAt < 25000) return;
    try {
      const d = await api('changes', { since: S.cursor });
      if (gen !== net.gen) return;
      const missed = d && d.cursor > S.cursor;
      onDelta(d); S.lastContactAt = Date.now();
      if (missed) startStream(gen);                    // the stream was silently dead: it missed changes
    } catch (e) { failed(gen, e); }
  }, 10000);
}
function startPolling(gen) {
  stopStream();
  net.mode = 'poll';
  const tick = async () => {
    if (gen !== net.gen || net.mode !== 'poll') return;
    try {
      const d = await api('changes', { since: S.cursor });
      if (gen !== net.gen || net.mode !== 'poll') return;
      net.pollFails = 0; setConn('polling'); onDelta(d);
    } catch (e) {
      if (gen !== net.gen) return;
      if (++net.pollFails >= 3) return failed(gen, e);
    }
    if (gen === net.gen && net.mode === 'poll') net.poll = setTimeout(tick, 1000);
  };
  tick();
  net.sseRetry = setTimeout(() => { if (gen === net.gen) { clearTimeout(net.poll); net.streamFails = 0; startStream(gen); } }, 30000);
}

/* ───────────────────────── scheduler ───────────────────────── */

const dirty = new Set();
let renderTimer = 0, rafPending = false, lastRender = 0;
function scheduleRender(what) {
  if (what) dirty.add(what);
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderNow(); });
  }, Math.max(0, 120 - (performance.now() - lastRender)));
}

/* ───────────────────────── 5a. shell: navigation, hash, top bar ───────────────────────── */

function writeHash(push) {
  const u = S.ui;
  const h = buildHash({ view: u.view, key: u.key, site: u.site, kinds: [...u.kinds], q: u.view === 'fleet' ? u.q : '', focus: u.focus, pod: u.view === 'pods' ? u.pod : '', file: u.view === 'files' ? u.file : '' });
  if (h === location.hash) return;
  S.hashSelf = h;
  if (push) location.hash = h; else history.replaceState(null, '', h);
}
function applyHash(h) {
  const u = S.ui;
  u.view = h.view || (h.focus && !h.key ? 'timeline' : 'fleet');
  u.key = h.key; u.site = h.site; u.kinds = new Set(h.kinds); u.q = h.q; u.focus = h.focus; u.pod = h.pod; u.file = h.file; u.ev = '';
  if (u.view === 'fleet' && h.key) u.drawer = { type: 'agent', key: h.key };       // in the timeline `key` only anchors the family
  else if (u.view === 'pods' && h.pod) u.drawer = { type: 'pod', key: h.pod };
  else u.drawer = null;
  syncControls();
  showView();
}
/** Switching tabs drops a drawer that belongs to another view's subject (agent detail over Pods/Files, pod detail elsewhere). */
function setView(view, push = true, fromTab = false) {
  const u = S.ui;
  u.view = VIEWS.includes(view) ? view : 'fleet';
  if (fromTab && u.drawer && (u.drawer.type === 'pod' ? u.view !== 'pods' : u.view === 'pods' || u.view === 'files')) u.drawer = null;
  showView();
  writeHash(push);
  scheduleRender('all');
}
function showView() {
  const view = S.ui.view;
  for (const v of VIEWS) {
    byId('view-' + v).hidden = v !== view;
    const tab = byId('tab-' + v);
    tab.setAttribute('aria-selected', String(v === view));
    tab.tabIndex = v === view ? 0 : -1;
  }
  hideTip();
}
function openPod(key) { S.ui.pod = key; S.ui.drawer = { type: 'pod', key }; }
function go(spec) {
  const i = spec.indexOf(':'), what = spec.slice(0, i), arg = spec.slice(i + 1);
  S.ui.focus = '';
  if (what === 'agent') openAgent(arg);
  else if (what === 'tl') { S.ui.key = arg; S.ui.ev = ''; S.ui.drawer = { type: 'agent', key: arg }; tlResetView(); setView('timeline'); }
  else if (what === 'pod') { openPod(arg); setView('pods'); }
  else if (what === 'file') { S.ui.file = arg; S.ui.fileEvent = ''; setView('files'); }
  else if (what === 'view') setView(arg);
}
function closeDrawer() { S.ui.drawer = null; scheduleRender('all'); }
function copyText(text, btn) {
  const done = () => { if (!btn) return; const old = btn.innerHTML; btn.textContent = '已复制 ✓'; setTimeout(() => { btn.innerHTML = old; }, 1100); };
  const legacy = () => { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch { /* clipboard unavailable */ } ta.remove(); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, legacy); else legacy();
}

/** Fills a <select> only when its option list changed; keeps the chosen value. */
function fillSelect(sel, options, value) {
  const sig = options.map((o) => o[0] + '\u0001' + o[1]).join('\u0002');
  if (sel._sig !== sig) { sel._sig = sig; sel.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); }
  if (sel.value !== value) sel.value = value;
}
function syncControls() {
  const u = S.ui;
  for (const id of ['f-kinds', 'fd-kinds']) for (const b of $$('.kfilter', byId(id))) b.setAttribute('aria-pressed', String((id === 'f-kinds' ? u.kinds : u.feedKinds).has(b.dataset.kind)));
  if (byId('f-q').value !== u.q) byId('f-q').value = u.q;
  byId('f-status').value = u.status;
  byId('f-proj').checked = u.proj;
  const sites = siteList();
  fillSelect(byId('f-site'), [['', '全部 All'], ...sites.map((s) => [s, siteLabel(s)])], u.site);
  fillSelect(byId('p-site'), [['', '全部 All'], ...sites.map((s) => [s, siteLabel(s)])], u.podSite);
}

function renderConn() {
  const c = S.conn, pill = byId('conn-pill');
  pill.dataset.state = c.state;
  setText(byId('conn-text'), c.state === 'down' ? '已断开 offline' : S.demo ? '演示 demo' : c.state === 'live' ? '实时 live' : c.state === 'polling' ? '轮询 polling' : '连接中…');
  const b = byId('banner');
  if (c.state === 'down') {
    const unauth = /^401|未授权|unauthor/i.test(c.error);
    const wait = Math.max(0, Math.ceil((c.retryAt - Date.now()) / 1000));
    b.className = 'banner';
    b.hidden = false;
    b.innerHTML = `<span class="grow"><b>${unauth ? '未授权 · Unauthorized' : '与 hub 断开 · Disconnected'}</b> — ${esc(c.error || 'no response')}${unauth ? ' · 请用 <code>/?token=…</code> 或 <code>#token=…</code> 打开' : ''}。${wait}s 后自动重连 · retrying${S.loaded ? ' · 当前显示为最后一次数据 (stale)' : ''}</span><button type="button" class="btn" data-act="retry">立即重试</button>`;
  } else if (c.state === 'polling') {
    b.className = 'banner warn'; b.hidden = false;
    b.innerHTML = '<span class="grow">SSE 不可用，已降级为每秒轮询 <code>api/changes</code> · stream unavailable, polling every 1 s</span>';
  } else b.hidden = true;
}
function renderTop() {
  const t = Date.now(), el = byId('fresh');
  byId('demo-badge').hidden = !S.demo;
  if (!S.loaded) { setText(el, '—'); return; }
  setText(el, `Δ ${fmtAge(t - S.lastDeltaAt)} 前`);
  el.title = `距上一次收到 hub 增量 ${fmtAge(t - S.lastDeltaAt)} · 距上次与 hub 联络 ${fmtAge(t - S.lastContactAt)} · cursor ${S.cursor}${S.hub ? ' · hub ' + (S.hub.hostId || '') + ' v' + (S.hub.version || '') : ''}`;
  el.classList.toggle('stale', S.conn.state === 'down' || (!S.demo && t - S.lastContactAt > 40000));
  if (S.conn.state === 'down') renderConn();
}

/** `#focus=<id>`: select the matching family (timeline anchors on it, fleet opens its ancestors and scrolls to it). */
function resolvePendingFocus() {
  const u = S.ui;
  if (!u.focus || !S.loaded) return;
  const r = resolveFocus(S.agents, getGraph(), u.focus);
  if (!r) return;
  u.focus = ''; u.ev = ''; u.drawer = null;
  expandChain(r.key);
  u.key = r.key;
  tlResetView();
  writeHash(false);
  S.scrollToKey = r.key;
}

function renderNow() {
  lastRender = performance.now();
  const what = new Set(dirty); dirty.clear();
  renderTop();
  if (document.hidden && !what.has('all')) { dirty.add('all'); return; }
  // A bare clock tick refreshes only the derived time cells: rebuilding every row once a second costs 100-300 ms at
  // 2 400 agents and stalls scrolling. The timeline still redraws for its live cursor; an open drawer still ages.
  if (what.size === 1 && what.has('tick')) {
    refreshTimes();
    if (S.ui.view === 'timeline') renderTimeline(what);
    if (!byId('drawer').hidden) renderDrawer();
    return;
  }
  resolvePendingFocus();
  syncSelects();
  switch (S.ui.view) {
    case 'fleet': renderFleet(); break;
    case 'timeline': renderTimeline(what); break;
    case 'pods': renderPods(); break;
    case 'files': renderFiles(); break;
    case 'feed': renderFeed(); break;
  }
  renderDrawer();
}
function syncSelects() {
  const sites = siteList();
  fillSelect(byId('f-site'), [['', '全部 All'], ...sites.map((s) => [s, siteLabel(s)])], S.ui.site);
  fillSelect(byId('p-site'), [['', '全部 All'], ...sites.map((s) => [s, siteLabel(s)])], S.ui.podSite);
}

/* ───────────────────────── 5b. fleet view ───────────────────────── */

const siteLabel = (s) => SITE_LABEL[s] || s;
function siteList() {
  const extra = new Set();
  for (const h of S.hosts.values()) if (!SITES.includes(h.site)) extra.add(h.site);
  for (const a of S.agents.values()) if (!SITES.includes(a.site)) extra.add(a.site);
  for (const p of S.pods.values()) if (!SITES.includes(p.site)) extra.add(p.site);
  return extra.size ? SITES.concat([...extra].sort()) : SITES;
}
const emptyKinds = () => Object.fromEntries(KINDS.map((k) => [k, { run: 0, wait: 0, total: 0 }]));
let ixCache = null, ixVer = '';
/** Per-site and per-host groupings, rebuilt only when hosts/agents/pods/links change. */
function getIndex() {
  const v = `${S.ver.agents}|${S.ver.hosts}|${S.ver.pods}|${S.ver.links}`;
  if (ixCache && ixVer === v) return ixCache;
  const sites = new Map(), byHost = new Map();
  const site = (s) => { let o = sites.get(s); if (!o) sites.set(s, (o = { hosts: [], pods: [], agents: [], kinds: emptyKinds(), hostKinds: new Map() })); return o; };
  for (const h of S.hosts.values()) site(h.site).hosts.push(h);
  for (const p of S.pods.values()) site(p.site).pods.push(p);
  for (const a of S.agents.values()) {
    const o = site(a.site);
    o.agents.push(a);
    const c = o.kinds[a.kind];
    if (c) { c.total++; if (a.status === 'running') c.run++; else if (a.status === 'waiting') c.wait++; }
    let hk = o.hostKinds.get(a.host);
    if (!hk) o.hostKinds.set(a.host, (hk = emptyKinds()));
    const hc = hk[a.kind];
    if (hc) { hc.total++; if (a.status === 'running') hc.run++; else if (a.status === 'waiting') hc.wait++; }
    let l = byHost.get(a.host);
    if (!l) byHost.set(a.host, (l = []));
    l.push(a);
  }
  ixCache = { sites, byHost }; ixVer = v;
  return ixCache;
}
const fmtLag = (ms) => (ms == null ? '' : ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');
const kindCounters = (counts) => KINDS.map((k) => {
  const c = counts[k] || { run: 0, wait: 0, total: 0 };
  return `<span class="kcount k-${k}${c.run ? ' on' : ''}" title="${esc(KIND_NAME[k])}: ${c.run} running · ${c.wait} waiting · ${c.total} total">${kindBadge(k)}<b>${c.run}</b></span>`;
}).join('');

function renderCards() {
  const ix = getIndex(), u = S.ui;
  const items = siteList().map((site) => {
    const o = ix.sites.get(site) || { hosts: [], pods: [], agents: [], kinds: emptyKinds() };
    const hs = o.hosts, online = hs.filter((h) => h.status === 'online');
    const lag = online.reduce((m, h) => Math.max(m, h.lagMs || 0), 0);
    const src = S.sources[site];
    const cs = hs.length === 0 ? 'none' : online.length === hs.length ? 'online' : online.length === 0 ? 'offline' : 'partial';
    const csTxt = { none: '无采集器 no collector', online: '在线 online', offline: '离线 offline', partial: `部分在线 ${online.length}/${hs.length}` }[cs];
    const isCluster = !['mac', 'server-bochao-01', 'sg-compute'].includes(site);
    const empty = !hs.length && !o.pods.length && !o.agents.length;
    const kube = isCluster && src ? (src.status === 'online' ? 'kube ✓' : `kube ✗ ${src.status || ''}`) : '';
    const sig = [site, hs.length, o.pods.length, cs, Math.round(lag / 100), kube, src && src.error, KINDS.map((k) => `${o.kinds[k].run}.${o.kinds[k].wait}.${o.kinds[k].total}`).join(','), u.site === site].join('|');
    return {
      key: site, tag: 'button', sig, cls: 'card' + (empty ? ' off' : ''),
      attrs: { type: 'button', 'data-site': site, 'aria-pressed': String(u.site === site), title: `${siteLabel(site)} · ${o.agents.length} agents${src && src.error ? ' · ' + src.error : ''}` },
      html: () => `<span class="t"><span class="name">${esc(siteLabel(site))}</span></span>
        <span class="m"><span>${hs.length} host${hs.length === 1 ? '' : 's'}</span><span>${o.pods.length} pod${o.pods.length === 1 ? '' : 's'}</span>${kube ? `<span class="${src.status === 'online' ? 'cs-online' : 'cs-offline'}" title="${esc(src.error || '')}">${esc(kube)}</span>` : ''}</span>
        <span class="m"><span class="ccollector cs-${cs}">● ${csTxt}${cs === 'online' || cs === 'partial' ? ` <span class="muted">· lag ${fmtLag(lag)}</span>` : ''}</span></span>
        <span class="c">${kindCounters(o.kinds)}</span>`,
    };
  });
  reconcile(byId('site-cards'), items);
}

function agentMatches(a, terms) {
  const u = S.ui, t = now();
  if (a.role === 'projection' && !u.proj) return false;
  if (u.kinds.size && !u.kinds.has(a.kind)) return false;
  if (u.status === 'running' && !isActive(a)) return false;
  if (u.status === 'recent' && !(isActive(a) || (a.live && a.live.alive) || t - (a.updatedAt || a.startedAt || 0) < RECENT_MS)) return false;
  if (terms.length) {
    if (a._hv !== a._v) { a._hv = a._v; a._hay = [agentTitle(a), a.name, a.description, a.model, a.cwd, a.id, a.key, a.host, a.site, a.kind, a.status, a.live && a.live.doing].filter(Boolean).join(' ').toLowerCase(); }
    for (const term of terms) if (!a._hay.includes(term)) return false;
  }
  return true;
}

function buildTree() {
  const u = S.ui, g = getGraph(), ix = getIndex(), tNow = now();
  const terms = u.q.toLowerCase().split(/\s+/).filter(Boolean);
  const filtering = terms.length > 0 || u.kinds.size > 0;
  const own = new Map(), vis = new Map(), act = new Map();
  const isOwn = (k) => { let v = own.get(k); if (v === undefined) own.set(k, (v = agentMatches(S.agents.get(k), terms))); return v; };
  const isVis = (k) => {
    let v = vis.get(k);
    if (v !== undefined) return v;
    vis.set(k, false);
    v = isOwn(k);
    for (const c of g.kids.get(k) || []) if (isVis(c)) v = true;
    vis.set(k, v);
    return v;
  };
  const isAct = (k) => {
    let v = act.get(k);
    if (v !== undefined) return v;
    act.set(k, false);
    v = isActive(S.agents.get(k));
    for (const c of g.kids.get(k) || []) if (isAct(c)) v = true;
    act.set(k, v);
    return v;
  };
  const expanded = (rowKey, dflt) => (u.exp.has(rowKey) ? u.exp.get(rowKey) : u.expandMode === 'all' ? true : u.expandMode === 'none' ? false : dflt);
  const rows = [];

  const emit = (out, a, depth, rowKey, ghost, parentAgent) => {
    const kids = (g.kids.get(a.key) || []).filter(isVis);
    const open = kids.length > 0 && expanded(rowKey, ghost ? false : kids.some(isAct));
    let xhost = '';
    if (parentAgent && parentAgent.host !== a.host) xhost = '↗ ' + hostLabel(a.host);
    else if (ghost && depth === 0) { const p = g.parent.get(a.key); const pa = p && S.agents.get(p.from); if (pa) xhost = '↖ ' + hostLabel(pa.host) + ' · ' + clip(agentTitle(pa), 24); }
    out.push({ t: 'agent', key: rowKey, a, depth, ghost, kids: kids.length, open, xhost, link: g.parent.get(a.key) });
    if (open) for (const k of kids) emit(out, S.agents.get(k), depth + 1, rowKey + '>' + k, ghost, a);
  };

  for (const site of siteList()) {
    if (u.site && u.site !== site) continue;
    const o = ix.sites.get(site);
    if (!o) { if (u.site === site) rows.push({ t: 'site', key: 'S:' + site, site, open: false, o: { hosts: [], pods: [], agents: [], kinds: emptyKinds() }, empty: true }); continue; }
    const hostMap = new Map();
    for (const h of o.hosts) hostMap.set(h.id, h);
    for (const a of o.agents) if (!hostMap.has(a.host)) hostMap.set(a.host, null);
    const body = [];
    let siteAgents = 0;
    for (const [hid, h] of hostMap) {
      const list = ix.byHost.get(hid) || [];
      const roots = [], ghosts = [];
      for (const a of list) {
        if (!isVis(a.key)) continue;
        const p = g.parent.get(a.key), pa = p && S.agents.get(p.from);
        if (!pa) roots.push(a);
        else if (pa.host !== a.host && isOwn(a.key)) ghosts.push(a);   // cross-host child: also listed greyed under its own host
      }
      roots.sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
      ghosts.sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
      const visCount = list.filter((a) => isVis(a.key)).length;
      if (filtering && !visCount) continue;
      siteAgents += visCount;
      const hkey = 'H:' + hid, hopen = expanded(hkey, true);
      body.push({ t: 'host', key: hkey, h, hid, site, open: hopen, hidden: list.length - visCount, counts: o.hostKinds.get(hid) || emptyKinds(), total: list.length });
      if (hopen) {
        for (const a of roots) emit(body, a, 0, hkey + '/' + a.key, false, null);
        for (const a of ghosts) emit(body, a, 0, 'G:' + hkey + '/' + a.key, true, null);
        if (!roots.length && !ghosts.length) body.push({ t: 'note', key: hkey + '/none', text: list.length ? `没有符合当前过滤的会话 (${list.length} 个已隐藏) · nothing matches the filters` : '没有会话 · no sessions' });
      }
    }
    if (filtering && !siteAgents) continue;
    if (!hostMap.size && !o.pods.length && !u.site) continue;
    const skey = 'S:' + site, sopen = expanded(skey, true);
    rows.push({ t: 'site', key: skey, site, open: sopen, o, empty: !hostMap.size });
    if (sopen) for (const r of body) rows.push(r);
  }
  return { rows, shown: new Set(rows.filter((r) => r.t === 'agent').map((r) => r.a.key)).size, tNow };
}

function treeItems(tree) {
  const u = S.ui, t = tree.tNow;
  const focusKey = tree.rows.some((r) => r.key === u.focusRow) ? u.focusRow : tree.rows[0] && tree.rows[0].key;
  return tree.rows.map((r) => {
    const tab = r.key === focusKey ? '0' : '-1';
    if (r.t === 'site') {
      const o = r.o;
      const sig = ['site', r.open ? 1 : 0, tab, r.empty ? 1 : 0, o.hosts.length, o.pods.length, o.agents.length, KINDS.map((k) => `${o.kinds[k].run}.${o.kinds[k].total}`).join(',')].join('|');
      return {
        key: r.key, sig, cls: 'row hdr site',
        attrs: { role: 'treeitem', 'aria-level': '1', 'aria-expanded': String(!!r.open), tabindex: tab, 'data-row': r.key },
        html: () => `<div class="nm"><button type="button" class="caret" data-toggle="${esc(r.key)}" tabindex="-1" aria-label="${r.open ? '折叠' : '展开'}">${ico('caret')}</button><b>${esc(siteLabel(r.site))}</b><span class="muted">${o.hosts.length} host · ${o.pods.length} pod</span></div><div class="sum">${r.empty ? '<span>无数据 no data</span>' : kindCounters(o.kinds)}<span>${o.agents.length} agents</span></div>`,
      };
    }
    if (r.t === 'host') {
      const h = r.h, st = h ? h.status : 'unknown';
      const podKeyId = h && h.pod ? `${h.site}/${h.namespace || NAMESPACE}/${h.pod}` : null;
      const pod = podKeyId ? S.pods.get(podKeyId) : null;
      const isPod = r.hid.startsWith('k8s/') || (h && h.kind === 'pod');
      const lag = h && h.status === 'online' ? fmtLag(h.lagMs) : '';
      const seen = h && h.status !== 'online' && h.lastSeen ? fmtAge(t - h.lastSeen) : '';
      const sig = ['host', r.open ? 1 : 0, tab, st, lag, seen, h && h.error, pod && pod._v, r.hidden, r.total, KINDS.map((k) => `${r.counts[k].run}.${r.counts[k].total}`).join(',')].join('|');
      return {
        key: r.key, sig, cls: 'row hdr host',
        attrs: { role: 'treeitem', 'aria-level': '2', 'aria-expanded': String(!!r.open), tabindex: tab, 'data-row': r.key },
        html: () => `<div class="nm"><button type="button" class="caret" data-toggle="${esc(r.key)}" tabindex="-1" aria-label="${r.open ? '折叠' : '展开'}">${ico('caret')}</button>${ico(isPod ? 'pod' : 'host')}<span>${esc(h ? h.label || shortHost(r.hid) : shortHost(r.hid))}</span>${h && h.via ? `<span class="tag" title="collector transport">${esc(h.via)}</span>` : ''}${pod ? `<span class="chip ph-${esc(pod.phase)}" title="pod phase / ready / restarts">${esc(pod.phase)} ${esc(pod.ready || '')}${pod.restarts ? ' ↻' + pod.restarts : ''}</span>` : ''}<span class="ccollector cs-${st === 'online' ? 'online' : st === 'connecting' ? 'connecting' : st === 'unknown' ? 'none' : 'offline'}" title="${esc(h && h.error || '')}">● ${esc(st === 'online' ? 'online' : st)}</span>${lag ? `<span class="muted" title="hub 接收时间 − 采集器发送时间 (已校正时钟偏差)">lag ${lag}</span>` : ''}${seen ? `<span class="muted" data-live="age" data-t="${h.lastSeen || 0}" data-pre="last seen " data-suf=" 前">${seen}</span>` : ''}</div><div class="sum">${kindCounters(r.counts)}<span>${r.total} 会话${r.hidden ? ` · <span title="被过滤隐藏">+${r.hidden} 隐藏</span>` : ''}</span></div>`,
      };
    }
    if (r.t === 'note') return { key: r.key, sig: 'note' + r.text, cls: 'row empty', html: esc(r.text) };
    return agentRowItem(r, tab, t);
  });
}

function agentRowItem(r, tab, t) {
  const a = r.a, sel = selKey() === a.key;
  const o = { depth: r.depth, ghost: r.ghost, kids: r.kids, open: r.open, sel, tab, xhost: r.xhost, link: r.link, rowKey: r.key, now: t };
  const tip = [a.cwd, a.key, a.model, a.provider].filter(Boolean).join('\n');
  return {
    key: r.key, sig: agentRowSig(a, o), cls: 'row agent' + (sel ? ' sel' : '') + (r.ghost ? ' ghost' : ''),
    attrs: { role: 'treeitem', 'aria-level': String(r.depth + 3), 'aria-selected': String(sel), ...(r.kids ? { 'aria-expanded': String(!!r.open) } : {}), tabindex: tab, 'data-sel': a.key, 'data-row': r.key, title: tip },
    html: () => agentRowHtml(a, o),
  };
}

/** Refreshes every clock-derived cell (`[data-live="age"|"since"]`) in place: the tick path never rebuilds a row. */
function refreshTimes() {
  const t = now();
  for (const el of $$('[data-live]')) {
    const base = Number(el.dataset.t);
    if (!(base > 0)) continue;
    const text = (el.dataset.pre || '') + (el.dataset.live === 'since' ? fmtDur(t - base) : fmtAge(t - base)) + (el.dataset.suf || '');
    if (el.textContent !== text) el.textContent = text;
  }
}

function renderFleet() {
  renderCards();
  const tree = buildTree();
  const host = byId('fleet-tree');
  reconcile(host, treeItems(tree));
  host.parentElement.style.setProperty('--sbw', (host.offsetWidth - host.clientWidth) + 'px');   // keeps the column header aligned with the rows
  setText(byId('f-count'), `${tree.shown} / ${S.agents.size} agents`);
  if (S.scrollToKey) {
    const el = host.querySelector(`[data-sel="${CSS.escape(S.scrollToKey)}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); S.scrollToKey = null; }
  }
}

/* ───────────────────────── 5c. detail drawer ───────────────────────── */

const setHtml = (el, html) => { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } };
function ensureSkeleton(el, kind, html) {
  if (el._sk === kind) return;
  el._sk = kind; el.innerHTML = html;
  for (const c of $$('[id]', el)) c._h = undefined;
}
const EVENT_TYPE_LABEL = { user: '用户', model: '模型', tool: '工具', spawn: '派生', message: '消息', compaction: '压缩', error: '错误', turn: '回合' };

function renderDrawer() {
  const el = byId('drawer'), d = S.ui.drawer;
  if (!d) { if (!el.hidden) el.hidden = true; return; }
  if (el.hidden) el.hidden = false;
  if (d.type === 'pod') renderPodDrawer(el, d.key); else renderAgentDrawer(el, d.key);
}

function drawerParentHtml(a, g) {
  const p = g.parent.get(a.key);
  const rows = [];
  if (p) {
    const pa = S.agents.get(p.from), l = p.link || {};
    rows.push(['父 parent', `${agentChip(p.from, 34)} <span class="tag">${esc(l.via || a.parent && a.parent.via || '?')}</span>${l.exact ? '<span class="tag exact">exact</span>' : '<span class="tag" title="由命令行/时间窗推断">inferred</span>'}${pa && pa.host !== a.host ? `<span class="chip xhost">↗ ${esc(hostLabel(pa.host))}</span>` : ''}${l.toolCallId ? `<span class="chip mono" title="parent tool call">${esc(clip(l.toolCallId, 18))}</span>` : ''}`]);
  } else if (a.parent && (a.parent.key || a.parent.id || a.parent.file)) {
    rows.push(['父 parent', `<span class="chip warn" title="hub 尚未解析到该父会话">未解析 ${esc(a.parent.kind || '')}:${esc(clip(a.parent.id || a.parent.key || a.parent.file, 24))} · via ${esc(a.parent.via)}</span>`]);
  }
  if (a.acp) {
    const peer = [...S.agents.values()].find((x) => x.kind === a.acp.kind && x.id === a.acp.id);
    rows.push(['ACP 绑定', `<span class="chip mono">${esc(a.acp.provider)}</span> → ${peer ? agentChip(peer.key, 30) : `<span class="chip mono">${esc(a.acp.kind)}:${esc(clip(a.acp.id, 16))}</span><span class="muted"> 未在线</span>`}`]);
  }
  const kids = g.kids.get(a.key) || [];
  if (kids.length) rows.push([`子 children <small>${kids.length}</small>`, `<div class="kids">${kids.slice(0, 40).map((k) => {
    const ka = S.agents.get(k), l = (g.parent.get(k) || {}).link || {};
    return `<div class="kid" data-go="agent:${esc(k)}" role="button" tabindex="0">${kindBadge(ka.kind)}${statusDot(ka.status)}<span class="t">${esc(ka.role !== 'main' && ka.name ? ka.name + ' · ' : '')}${esc(agentTitle(ka))}</span>${ka.host !== a.host ? `<span class="chip xhost">↗ ${esc(hostLabel(ka.host))}</span>` : ''}<span class="tag">${esc(l.via || '')}</span>${l.exact ? '' : '<span class="tag" title="inferred">~</span>'}</div>`;
  }).join('')}${kids.length > 40 ? `<span class="muted">… +${kids.length - 40}</span>` : ''}</div>`]);
  return rows.length ? `<h4>关系 Relations</h4><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '<h4>关系 Relations</h4><div class="muted">独立会话，无父子关系 · standalone session</div>';
}

function drawerUsageHtml(a) {
  const c = a.counts || {}, u = a.usage || {}, t = now();
  const ctxPct = u.contextTokens && u.contextWindow ? Math.min(100, (u.contextTokens / u.contextWindow) * 100) : null;
  const end = a.endedAt || (isActive(a) ? t : a.updatedAt);
  return `<h4>统计 Usage</h4>
    <div class="stats">${[['turns', c.turns], ['tools', c.tools], ['errors', c.errors], ['subagents', c.subagents], ['events', c.events]].map(([k, v]) => `<div class="stat"><b${k === 'errors' && v ? ' class="bad"' : ''}>${v ?? '–'}</b><span>${k}</span></div>`).join('')}</div>
    <dl class="kv" style="margin-top:6px">
      <dt>tokens</dt><dd class="mono">in ${fmtNum(u.input)} · out ${fmtNum(u.output)} · cache r ${fmtNum(u.cacheRead)} / w ${fmtNum(u.cacheWrite)}${u.reasoning ? ' · reason ' + fmtNum(u.reasoning) : ''}${u.cost != null ? ` · $${Number(u.cost).toFixed(2)}` : ''}</dd>
      ${ctxPct != null ? `<dt>上下文 ctx</dt><dd><span class="mono">${fmtNum(u.contextTokens)} / ${fmtNum(u.contextWindow)} (${ctxPct.toFixed(0)}%)</span><div class="meter"><i style="width:${ctxPct.toFixed(1)}%"></i></div></dd>` : ''}
      <dt>时间 time</dt><dd class="mono">${a.startedAt ? fmtDateTime(a.startedAt) : '–'} → ${a.endedAt ? fmtDateTime(a.endedAt) : isActive(a) ? '进行中' : a.updatedAt ? fmtDateTime(a.updatedAt) : '–'} <span class="muted">(${a.startedAt ? fmtDur(end - a.startedAt) : '–'})</span></dd>
      <dt>文件 file</dt><dd class="mono" title="${esc(a.file || '')}">${esc(a.file || '')}</dd>
    </dl>`;
}

function drawerTargetsHtml(s) {
  if (!s || !s.list.length) return '<h4>触达 Targets</h4><div class="muted">事件尚未加载 · events not loaded</div>';
  if (s._tg && s._tg.ver === s.ver) return s._tg.html;
  const pods = new Map(), files = new Map(), hosts = new Map(), urls = new Map(), launches = new Map();
  for (const e of s.list) for (const t of e.targets || []) {
    if (t.type === 'pod') { const k = podKeyOfTarget(t); if (k) { const o = pods.get(k) || { n: 0, ops: new Set() }; o.n++; if (t.op) o.ops.add(t.op); pods.set(k, o); } }
    else if (t.type === 'file') { const k = fileKeyOfTarget(t); if (k) { const o = files.get(k) || { n: 0, r: 0, w: 0, e: 0 }; o.n++; o[fileOpClass(t.op)]++; files.set(k, o); } }
    else if (t.type === 'host') hosts.set(t.host, (hosts.get(t.host) || 0) + 1);
    else if (t.type === 'url') urls.set(urlHost(t.url), (urls.get(urlHost(t.url)) || 0) + 1);
    else if (t.type === 'agent') { const k = `${t.kind || 'agent'}@${t.pod || t.site || ''}`; launches.set(k, (launches.get(k) || 0) + 1); }
  }
  const sec = (title, n, body) => (n ? `<div class="kvs"><div class="muted" style="margin:4px 0 2px">${title} <small>${n}</small></div><div class="chips">${body}</div></div>` : '');
  const html = `<h4>触达 Targets</h4>${
    sec('Pods', pods.size, [...pods].sort((x, y) => y[1].n - x[1].n).slice(0, 10).map(([k, o]) => `${podChip(k)}<span class="muted" style="margin-right:4px">${[...o.ops].join('/')}×${o.n}</span>`).join(''))
  }${
    sec('文件 Files', files.size, [...files].sort((x, y) => y[1].n - x[1].n).slice(0, 14).map(([k, o]) => `${fileChip(k)}<span class="muted" style="margin-right:4px">${o.r ? 'r' + o.r : ''}${o.w ? ' w' + o.w : ''}${o.e ? ' e' + o.e : ''}</span>`).join('') + (files.size > 14 ? `<span class="muted">… +${files.size - 14}</span>` : ''))
  }${
    sec('主机 Hosts', hosts.size, [...hosts].map(([h, n]) => `<span class="chip t-host mono">${ico('host', 'sm')}${esc(clip(h, 28))}×${n}</span>`).join(''))
  }${
    sec('启动 Launches', launches.size, [...launches].map(([k, n]) => `<span class="chip t-agent mono">${ico('spawn', 'sm')}${esc(k)}×${n}</span>`).join(''))
  }${
    sec('URL', urls.size, [...urls].slice(0, 8).map(([h, n]) => `<span class="chip t-url mono">${ico('web', 'sm')}${esc(h)}×${n}</span>`).join(''))
  }${!pods.size && !files.size && !hosts.size && !urls.size && !launches.size ? '<div class="muted">没有记录到目标 · no targets in loaded events</div>' : ''}`;
  s._tg = { ver: s.ver, html };
  return html;
}

function eventRowHtml(e, sel) {
  const err = e.type === 'error' || e.status === 'error';
  const catCls = e.type === 'tool' || e.type === 'spawn' ? 'cat-' + (CATS.includes(e.category) ? e.category : e.type === 'spawn' ? 'spawn' : 'other') : '';
  const name = e.name || EVENT_TYPE_LABEL[e.type] || e.type;
  const text = e.preview || e.text || (e.child && (e.child.name || e.child.id)) || (e.peer ? '→ ' + e.peer : '') || '';
  const du = e.status === 'pending' ? '…' : e.duration != null ? fmtDur(e.duration) : '';
  return `<div class="erow${e.status === 'pending' ? ' pending' : ''}${err ? ' error' : ''}${sel ? ' sel' : ''}" data-ev="${esc(e.id)}" role="button" tabindex="0"><span class="tm">${fmtClock(e.t)}</span>${catIcon(e)}<span class="nm ${catCls}" title="${esc(text)}"><b>${esc(name)}</b><span>${esc(clip(text, 140))}</span></span><span class="du">${du}</span></div>`;
}
function eventDetailHtml(e) {
  const rows = [
    ['id', `<span class="mono">${esc(e.id)}</span>`],
    ['类型 type', esc(e.type) + (e.category ? ` · <span class="cat cat-${esc(e.category)}">${esc(CAT_LABEL[e.category] || e.category)}</span>` : '') + (e.name ? ` · <b>${esc(e.name)}</b>` : '')],
    ['时间 time', `${fmtDateTime(e.t)}.${String(new Date(e.t).getMilliseconds()).padStart(3, '0')}${e.duration != null ? ` · 耗时 ${fmtDur(e.duration)}` : e.status === 'pending' ? ' · 进行中 pending' : ''}${e.ttft != null ? ` · ttft ${fmtDur(e.ttft)}` : ''}`],
  ];
  if (e.status) rows.push(['状态 status', `<span class="${e.status === 'error' ? 'bad' : e.status === 'pending' ? 'warn' : ''}">${esc(e.status)}</span>${e.exitCode != null ? ` · exit ${e.exitCode}` : ''}`]);
  if (e.model) rows.push(['模型 model', `<span class="mono">${esc(e.model)}</span>`]);
  if (e.usage) rows.push(['用量 usage', `<span class="mono">${Object.entries(e.usage).filter(([, v]) => v).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' · ')}</span>`]);
  if (e.child) rows.push(['子 child', `<span class="mono">${esc([e.child.kind, e.child.name || e.child.id].filter(Boolean).join(':'))}</span>${e.child.key ? ' ' + agentChip(e.child.key, 28) : ''}`]);
  if (e.peer) rows.push(['对端 peer', `<span class="mono">${esc(e.peer)}</span>`]);
  const pre = e.preview ? `<pre>${esc(e.preview)}</pre>` : '';
  const txt = e.text ? `<details open><summary>text</summary><pre>${esc(e.text)}</pre></details>` : '';
  const tg = (e.targets || []).length ? `<div class="chips" style="margin-top:5px">${e.targets.map(targetChip).join('')}</div>` : '';
  return `<div class="evd"><div style="display:flex;align-items:center;gap:6px"><b>事件详情 Event</b><span style="flex:1"></span><button type="button" class="btn icon" data-act="ev-close" aria-label="关闭事件详情">${ico('close', 'sm')}</button></div><dl class="kv" style="margin-top:4px">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${pre}${txt}${tg}</div>`;
}

function drawerEventsHtml(a, s) {
  const u = S.ui, f = u.evFilter, list = s.list;
  const parts = [];
  let shown = 0, matched = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (f === 'tools' && e.type !== 'tool' && e.type !== 'spawn') continue;
    if (f === 'errors' && !(e.type === 'error' || e.status === 'error')) continue;
    matched++;
    if (shown < u.evShow) { parts.push(eventRowHtml(e, u.ev === e.id)); shown++; }
  }
  const total = (a.counts && a.counts.events) || list.length;
  const more = matched > shown ? `<button type="button" class="btn more" data-act="ev-more">显示更多 +${Math.min(120, matched - shown)} · show more</button>` : s.hasMore ? `<button type="button" class="btn more" data-act="ev-older"${inflight.has('older:' + a.key) ? ' disabled' : ''}>${inflight.has('older:' + a.key) ? '加载中…' : '加载更早 · load older (api/agent)'}</button>` : '';
  const sel = u.ev ? s.byId.get(u.ev) : null;
  return `<h4>事件 Events <span class="muted">${list.length}${total > list.length ? ' / ' + total : ''}</span>
    <span style="flex:1"></span>
    <span class="seg">${[['all', '全部'], ['tools', '工具'], ['errors', '错误']].map(([v, l]) => `<button type="button" class="btn" data-act="ev-filter" data-v="${v}" aria-pressed="${f === v}">${l}</button>`).join('')}</span></h4>
    ${sel ? eventDetailHtml(sel) : ''}
    <div class="evl">${parts.join('') || `<div class="muted" style="padding:6px 4px">${s.loaded ? '没有事件 · no events' : '加载中… loading'}</div>`}</div>${more}`;
}

function renderAgentDrawer(el, key) {
  ensureSkeleton(el, 'agent', '<div class="dh" id="dr-head"></div><div class="db" id="dr-body"><div class="sec" id="dr-rel"></div><div class="sec" id="dr-use"></div><div class="sec" id="dr-tgt"></div><div class="sec" id="dr-ev"></div></div>');
  const a = S.agents.get(key), body = byId('dr-body');
  if (el._for !== key) { el._for = key; body.scrollTop = 0; S.ui.evShow = 120; }
  if (!a) {
    setHtml(byId('dr-head'), `<div class="l1"><div class="ttl">${S.loaded ? '未找到该 agent · not found' : '加载中…'}</div><button type="button" class="btn icon" data-act="close-drawer" aria-label="关闭">${ico('close')}</button></div><div class="muted mono">${esc(key)}</div>`);
    for (const id of ['dr-rel', 'dr-use', 'dr-tgt', 'dr-ev']) setHtml(byId(id), '');
    return;
  }
  const g = getGraph(), live = a.live || {}, t = now();
  const s = storeOf(key);
  refreshStores([key], 5000);
  const liveTxt = isActive(a) || live.state === 'idle' ? [live.state, live.doing].filter(Boolean).join(' · ') + (live.since && isActive(a) ? ` · ${fmtDur(t - live.since)}` : '') : '';
  setHtml(byId('dr-head'), `<div class="l1">${kindBadge(a.kind, 'lg')}<div class="ttl">${esc(agentTitle(a))}</div><button type="button" class="btn icon" data-act="close-drawer" aria-label="关闭详情 close">${ico('close')}</button></div>
    <div class="l2">${statusDot(a.status)}<b>${esc(STATUS_LABEL[a.status] || a.status)}</b><span class="muted">${esc(a.status)}</span>${liveTxt ? `<span class="mono" style="font-size:11px;color:var(--fg2)">${esc(clip(liveTxt, 90))}</span>` : ''}<span class="tag">${esc(ROLE_LABEL[a.role] || a.role)} ${esc(a.role)}</span>${live.alive === true ? `<span class="chip good">进程 pid ${live.pid ?? '?'}</span>` : live.alive === false ? '<span class="chip">无进程 no process</span>' : ''}</div>
    <div class="l3"><span class="chip" title="${esc(a.host)}">${ico(a.host.startsWith('k8s/') ? 'pod' : 'host', 'sm')}${esc(hostLabel(a.host))}</span><span class="chip">${esc(siteLabel(a.site))}</span>${a.model ? `<span class="chip mono">${esc(a.model)}${a.effort ? ' · ' + esc(a.effort) : ''}</span>` : ''}${a.version ? `<span class="chip mono">v${esc(a.version)}</span>` : ''}${a.container ? `<span class="chip mono" title="container">${esc(a.container)}</span>` : ''}${a.cwd ? `<span class="chip mono" title="${esc(a.cwd)}" style="max-width:100%">${esc(clip(a.cwd, 64))}</span>` : ''}</div>
    ${a.description ? `<div class="muted">${esc(clip(a.description, 240))}</div>` : ''}
    <div class="actions"><button type="button" class="btn" data-go="tl:${esc(a.key)}">${ico('timeline', 'sm')} 打开时间线 Open timeline</button><button type="button" class="btn" data-act="copy" data-v="${esc(a.key)}" title="${esc(a.key)}">${ico('copy', 'sm')} 复制 key</button><button type="button" class="btn" data-act="show-fleet" data-v="${esc(a.key)}">${ico('fleet', 'sm')} 在网络中定位</button></div>`);
  setHtml(byId('dr-rel'), drawerParentHtml(a, g));
  setHtml(byId('dr-use'), drawerUsageHtml(a));
  setHtml(byId('dr-tgt'), drawerTargetsHtml(s));
  setHtml(byId('dr-ev'), drawerEventsHtml(a, s));
  if (S.scrollEv) {
    const row = el.querySelector(`[data-ev="${CSS.escape(S.scrollEv)}"]`);
    if (row) { row.scrollIntoView({ block: 'center' }); S.scrollEv = null; }
  }
}

/* pod drawer */
const podDetail = new Map();
function loadPodDetail(key, force) {
  const cur = podDetail.get(key);
  if (cur && (cur.loading || (!force && Date.now() - cur.at < 15000))) return;
  const rec = cur || { at: 0, data: null, error: '', loading: false };
  rec.loading = true; podDetail.set(key, rec);
  api('pod', { key }).then((d) => { rec.data = d; rec.error = ''; }, (e) => { rec.error = e.message || String(e); })
    .finally(() => { rec.loading = false; rec.at = Date.now(); scheduleRender('pod'); });
}
function podContainersHtml(p) {
  if (!p.containers || !p.containers.length) return '<div class="muted">无容器信息</div>';
  return `<table class="grid" style="font-size:11.5px"><thead><tr><th>容器</th><th>状态</th><th class="num">重启</th><th>镜像</th></tr></thead><tbody>${p.containers.map((c) => `<tr style="cursor:default"><td class="mono">${esc(c.name)}</td><td><span class="cstate ${containerClass(c.state)}">● ${esc(c.state)}</span></td><td class="num">${c.restarts || 0}</td><td class="mono" title="${esc(c.image)}">${esc(clip(String(c.image).replace(/^.*\//, ''), 40))}</td></tr>`).join('')}</tbody></table>`;
}
function renderPodDrawer(el, key) {
  ensureSkeleton(el, 'pod', '<div class="dh" id="dr-head"></div><div class="db" id="dr-body"><div class="sec" id="dr-pi"></div><div class="sec" id="dr-pc"></div><div class="sec" id="dr-pt"></div><div class="sec" id="dr-pe"></div></div>');
  if (el._for !== key) { el._for = key; byId('dr-body').scrollTop = 0; }
  loadPodDetail(key);
  const rec = podDetail.get(key) || {};
  const d = rec.data || {};
  const p = S.pods.get(key) || d.pod || null;
  const parts = key.split('/'), name = parts.slice(2).join('/');
  setHtml(byId('dr-head'), `<div class="l1">${ico('pod')}<div class="ttl mono">${esc(p ? p.name : name)}</div><button type="button" class="btn icon" data-act="close-drawer" aria-label="关闭">${ico('close')}</button></div>
    <div class="l2">${p ? `<span class="chip ph-${esc(p.phase)}">● ${esc(p.phase)}</span><span class="chip">ready ${esc(p.ready || '–')}</span>${p.restarts ? `<span class="chip warn">↻ ${p.restarts}</span>` : ''}` : '<span class="chip warn">kube 未监视该 pod</span>'}<span class="chip">${esc(siteLabel(parts[0]))}</span>${p && p.collect ? '<span class="chip good">collector</span>' : ''}</div>`);
  if (p) {
    const lab = Object.entries(p.labels || {}).slice(0, 8);
    setHtml(byId('dr-pi'), `<h4>Pod 信息</h4><dl class="kv">
      <dt>cluster</dt><dd class="mono">${esc(p.cluster)}</dd><dt>namespace</dt><dd class="mono">${esc(p.namespace)}</dd>
      <dt>node</dt><dd class="mono">${esc(p.node || '–')}</dd><dt>podIP</dt><dd class="mono">${esc(p.podIP || '–')}</dd>
      <dt>age</dt><dd>${p.createdAt ? fmtAge(now() - p.createdAt) : '–'}</dd>
      <dt>requests</dt><dd class="mono">${esc([p.requests && p.requests.cpu && 'cpu ' + p.requests.cpu, p.requests && p.requests.memory && 'mem ' + p.requests.memory, p.requests && p.requests.gpu ? 'gpu ' + p.requests.gpu : ''].filter(Boolean).join(' · ') || '–')}</dd>
      ${p.owner ? `<dt>owner</dt><dd class="mono">${esc(p.owner.kind)}/${esc(p.owner.name)}</dd>` : ''}
      ${p.hostId ? `<dt>collector</dt><dd class="mono">${esc(p.hostId)}</dd>` : ''}
      ${lab.length ? `<dt>labels</dt><dd><div class="chips">${lab.map(([k, v]) => `<span class="chip mono" title="${esc(k)}=${esc(v)}">${esc(clip(k.replace(/^.*\//, '') + '=' + v, 36))}</span>`).join('')}</div></dd>` : ''}
    </dl>`);
    setHtml(byId('dr-pc'), `<h4>容器 Containers</h4>${podContainersHtml(p)}`);
  } else { setHtml(byId('dr-pi'), `<h4>Pod 信息</h4><div class="muted mono">${esc(key)}</div>`); setHtml(byId('dr-pc'), ''); }
  const touches = d.touches || [];
  const ts = summarizeTouches(S.touch.pods.get(key) || new Map());
  setHtml(byId('dr-pt'), `<h4>被触碰 Touches <span class="muted">${touches.length || ts.n}${rec.loading ? ' · 加载中…' : ''}</span></h4>${rec.error ? `<div class="notice bad">${esc(rec.error)}</div>` : ''}
    <div>${(touches.length ? touches : []).slice(0, 80).map((x) => `<div class="trow" data-go="tl:${esc(x.agent)}" role="button" tabindex="0" title="打开该 agent 的时间线"><span class="tm muted">${fmtClock(x.t)}</span><span>${agentChip(x.agent, 22)} <span class="opchip">${esc(x.op || x.category || '')}</span></span><span class="pv">${esc(x.preview || '')}</span></div>`).join('') || (rec.loading ? '' : `<div class="muted">没有记录 · no touches recorded${ts.n ? '' : ''}</div>`)}</div>`);
  const kev = d.events || [];
  setHtml(byId('dr-pe'), `<h4>Kube 事件 Events <span class="muted">${kev.length}</span></h4>${d.eventsError ? `<div class="notice warn">kube 事件读取失败 · ${esc(clip(d.eventsError, 200))}</div>` : ''}${kev.length ? `<table class="grid" style="font-size:11.5px"><thead><tr><th>类型</th><th>原因</th><th>消息</th><th class="num">×</th><th>最近</th></tr></thead><tbody>${kev.slice(0, 40).map((e) => `<tr style="cursor:default"><td class="${e.type === 'Warning' ? 'ph-Pending' : ''}">${esc(e.type)}</td><td class="mono">${esc(e.reason)}</td><td style="white-space:normal;max-width:210px">${esc(clip(e.message, 160))}</td><td class="num">${e.count || 1}</td><td>${e.lastSeen ? fmtAge(now() - e.lastSeen) : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="muted">${rec.loading ? '加载中…' : d.eventsError ? '' : '没有 kube 事件 · none'}</div>`}`);
}

/* ───────────────────────── 5d. timeline (SVG Gantt) ───────────────────────── */

// Layout per lane (LH px): bar 2..30 · label baseline 12.5 · marks/model row ~16.5 · tick band 19..29 split in ≤3 sub-rows.
// Only lanes inside the scroll window and ticks inside the time window are emitted (merged per pixel), so cost follows
// what is visible, not the 200 lanes × thousands of tool calls behind it. Hover/click use geometry, not DOM nodes.
const TL = {
  v0: 0, v1: 0, follow: 'fit', scopeKey: null, collapse: false,
  gut: 210, axisH: 40, LH: 32, W: 0, H: 0, pw: 0, dMin: 0, dMax: 0,
  model: null, modelSig: '', hit: { ticks: [], bars: [], lanes: [] }, hot: null, ptr: null, drag: null, brush: null,
  lastDraw: 0, raf: 0, timer: 0, fam: new Map(), omitted: false,
};
const TL_MIN_SPAN = 300;
const TL_PRIO = { write: 7, edit: 7, remote: 6, k8s: 6, spawn: 6, shell: 5, read: 4, search: 4, web: 4, coordination: 3, other: 3 };
const tlClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lowerBound = (list, t) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t < t) lo = m + 1; else hi = m; } return lo; };
const selKey = () => drawerKey() || S.ui.key;
function tlResetView() { TL.scopeKey = null; TL.model = null; }
const openEnded = (a, t) => isActive(a) || (a.status === 'idle' && a.live && a.live.alive !== false && t - (a.updatedAt || 0) < 3600e3);

/** Agents shown by the timeline: the family of the selected key, or every family with a running member (+ recent ones). */
function tlBuildModel() {
  const g = getGraph(), u = S.ui, t = now();
  const sig = [S.ver.agents, S.ver.links, S.ver.events, u.key, u.proj ? 1 : 0, TL.collapse ? 1 : 0].join('|');
  if (TL.model && TL.modelSig === sig) return TL.model;
  const keepRole = (a) => a.role !== 'projection' || u.proj;
  let keys, scope;
  if (u.key && S.agents.has(u.key)) {
    const root = rootOf(g, u.key);
    keys = subtree(g, root).filter((k) => keepRole(S.agents.get(k)));
    scope = { type: 'family', root };
  } else {
    const roots = [], seen = new Set();
    for (const a of S.agents.values()) {
      if (!isActive(a) || !keepRole(a)) continue;
      const r = rootOf(g, a.key);
      if (!seen.has(r)) { seen.add(r); roots.push(r); }
    }
    roots.sort((x, y) => (S.agents.get(x).startedAt || 0) - (S.agents.get(y).startedAt || 0));
    const memo = new Map();
    const activeBelow = (k) => { let v = memo.get(k); if (v === undefined) { memo.set(k, false); v = isActive(S.agents.get(k)); for (const c of g.kids.get(k) || []) if (activeBelow(c)) v = true; memo.set(k, v); } return v; };
    const keep = new Set();
    for (const r of roots) for (const k of subtree(g, r)) {
      const a = S.agents.get(k);
      if (!keepRole(a)) continue;
      if (activeBelow(k) || t - (a.updatedAt || 0) < 30 * 60e3) for (let c = k; c && !keep.has(c); c = g.parent.has(c) ? g.parent.get(c).from : null) keep.add(c);
    }
    keys = [];
    for (const r of roots) for (const k of subtree(g, r)) if (keep.has(k)) keys.push(k);
    scope = { type: 'running', roots: roots.length };
  }
  const keepSet = new Set(keys), depth = new Map(), nodes = [];
  for (const k of keys) {
    const a = S.agents.get(k), s = S.stores.get(k), p = g.parent.get(k);
    const pk = p && keepSet.has(p.from) ? p.from : null;
    depth.set(k, pk ? (depth.get(pk) || 0) + 1 : 0);
    const first = s && s.list.length ? s.list[0].t : 0;
    const start = a.startedAt || first || a.updatedAt || t;
    let last = a.updatedAt || start;
    if (s) for (let i = s.list.length - 1, n = 0; i >= 0 && n < 40; i--, n++) { const e = s.list[i], en = e.t + (e.duration || 0); if (en > last) last = en; }
    nodes.push({ key: k, a, parent: pk, host: a.host, start, end: Math.max(a.endedAt || last, start), open: openEnded(a, t) && !a.endedAt, depth: depth.get(k), link: p ? p.link : null });
  }
  const packed = packLanes(nodes.map((n) => ({ key: n.key, parent: n.parent, host: n.host, start: n.start, end: n.open ? Infinity : n.end })));
  const lanes = Array.from({ length: packed.count }, (_, i) => ({ host: packed.hosts[i], nodes: [] }));
  for (const n of nodes) { n.lane = packed.lane.get(n.key); lanes[n.lane].nodes.push(n); }
  let minT = Infinity, maxT = -Infinity, anyOpen = false;
  for (const n of nodes) { minT = Math.min(minT, n.start); maxT = Math.max(maxT, n.end); if (n.open) anyOpen = true; }
  if (!nodes.length) { minT = t - 60e3; maxT = t; }
  const m = { scope, nodes, lanes, byKey: new Map(nodes.map((n) => [n.key, n])), minT, maxT, anyOpen, axis: null };
  m.axis = tlBuildAxis(m, t);
  TL.model = m; TL.modelSig = sig;
  return m;
}

/** Minute buckets of one event store (cached by store version): only the buckets that hold an event start or lie inside a long call. */
function storeBuckets(s) {
  if (s._bv === s.ver) return s._bk;
  const B = 60000, set = new Set();
  for (const e of s.list) {
    if (e.status === 'pending') continue;                               // open calls are added with "now" by the caller
    if (e.duration > B) { const i1 = Math.floor((e.t + e.duration) / B); for (let i = Math.floor(e.t / B); i <= i1 && i - Math.floor(e.t / B) < 20000; i++) set.add(i); }
    else set.add(Math.floor(e.t / B));
  }
  s._bv = s.ver; s._bk = set;
  return set;
}
/** Active axis: quiet gaps over 15 min collapse. "Quiet" is judged on event times (1-minute buckets), not on bar extents. */
function tlBuildAxis(m, t) {
  if (!TL.collapse) return makeAxis([], Infinity);
  const B = 60000, buckets = new Set();
  const addRange = (a, b) => { const i0 = Math.floor(a / B), i1 = Math.min(Math.floor(b / B), i0 + 20000); for (let i = i0; i <= i1; i++) buckets.add(i); };
  for (const n of m.nodes) {
    buckets.add(Math.floor(n.start / B)); buckets.add(Math.floor(n.end / B));
    if (isActive(n.a)) addRange(n.a.updatedAt || n.start, t);
    const s = S.stores.get(n.key);
    if (!s) continue;
    for (const i of storeBuckets(s)) buckets.add(i);
    for (const id of s.pend) { const e = s.byId.get(id); if (e) addRange(e.t, t); }
  }
  return makeAxis(bucketSpans(buckets, B), GAP_MS);
}

/** Loads events for the shown agents: one api/family per family (in the background), tails only for what is on screen. */
function tlEnsureData(m) {
  const g = getGraph(), roots = new Set(m.nodes.map((n) => rootOf(g, n.key)));
  for (const r of roots) {
    if (TL.fam.has(r) || inflight.size >= 6) continue;
    TL.fam.set(r, 'loading');
    loadFamily(r).then(() => TL.fam.set(r, 'done'), () => TL.fam.set(r, 'failed'));
  }
}
/** Keeps the tails of the visible, still-moving agents fresh (model/user events do not travel in the feed). */
function tlRefreshVisible(m, l0, l1) {
  const g = getGraph(), keys = [];
  for (let i = l0; i <= l1; i++) for (const n of m.lanes[i].nodes) {
    const st = TL.fam.get(rootOf(g, n.key)), s = S.stores.get(n.key);
    if (st === 'loading') continue;
    if (st === 'failed' || !s || !s.loaded || isActive(n.a)) keys.push(n.key);
  }
  refreshStores(keys, 8000);
}

/** Sub-rows for overlapping tool calls of one agent (parallel calls): row index per event in e._r, count in s.rows. */
function tlPackRows(s) {
  if (s.rv === s.ver) return;
  const ends = [];
  for (const e of s.list) {
    if (e.type !== 'tool' && e.type !== 'spawn') continue;
    const end = e.status === 'pending' ? Infinity : e.t + (e.duration || 0);
    let r = ends.findIndex((x) => x <= e.t);
    if (r < 0) r = ends.length < 3 ? ends.push(0) - 1 : 2;
    ends[r] = Math.max(ends[r], end, e.t + 1);
    e._r = r;
  }
  s.rows = Math.max(1, ends.length); s.rv = s.ver;
}

const tlTargetText = (t) => {
  switch (t.type) {
    case 'file': return `${t.op || 'file'} ${t.path}`;
    case 'pod': return `pod ${t.op || ''} ${t.name || ''}${t.site ? ' @' + t.site : ''}`;
    case 'k8s': return `k8s ${t.op || ''} ${[t.resource, t.name].filter(Boolean).join('/')}${t.site ? ' @' + t.site : ''}`;
    case 'host': return `${t.op || 'ssh'} ${t.host || ''}`;
    case 'url': return t.url;
    case 'agent': return `launch ${t.kind || ''}${t.pod ? '@' + t.pod : t.site ? '@' + t.site : ''}`;
    default: return '';
  }
};
function tlTipHtml(h) {
  const n = h.node, a = n.a;
  if (h.type === 'bar' || h.type === 'lane') {
    const t = now(), par = n.parent ? S.agents.get(n.parent) : null;
    return `<div><b>${esc(agentTitle(a))}</b></div><div class="row2"><span class="k">kind</span>${esc(KIND_NAME[a.kind])} · ${esc(a.role)}</div><div class="row2"><span class="k">host</span>${esc(hostLabel(a.host))} · ${esc(a.site)}</div><div class="row2"><span class="k">状态</span>${esc(STATUS_LABEL[a.status] || a.status)}${a.live && a.live.doing ? ' · ' + esc(clip(a.live.doing, 70)) : ''}</div><div class="row2"><span class="k">时间</span>${fmtClock(n.start)} → ${n.open ? '进行中' : fmtClock(n.end)} (${fmtDur((n.open ? t : n.end) - n.start)})</div>${a.model ? `<div class="row2"><span class="k">模型</span>${esc(a.model)}</div>` : ''}${par && n.link ? `<div class="row2"><span class="k">来自</span>${esc(clip(agentTitle(par), 40))} · via ${esc(n.link.via)}${n.link.exact ? ' (exact)' : ' (inferred)'}${par.host !== a.host ? ` · 跨主机 ↗ ${esc(hostLabel(a.host))}` : ''}</div>` : ''}<div class="muted">点击打开详情 · click for details</div>`;
  }
  const e = h.evs[0];
  if (h.type === 'mark') return `<div><b>${esc(EVENT_TYPE_LABEL[e.type] || e.type)}</b> · ${fmtClock(e.t, true)} · ${esc(clip(agentTitle(a), 36))}</div>${e.text || e.preview ? `<pre>${esc(clip(e.text || e.preview, 260))}</pre>` : ''}`;
  if (h.n > 1) {
    return `<div><b>${h.n} 个事件 events</b> · ${esc(clip(agentTitle(a), 40))}</div>${h.evs.slice(0, 6).map((x) => `<div class="mono" style="font-size:11px">${fmtClock(x.t)} <b>${esc(x.name || x.type)}</b> ${esc(clip(x.preview || '', 60))}</div>`).join('')}${h.n > 6 ? `<div class="muted">… +${h.n - 6}</div>` : ''}<div class="muted">放大查看单个调用 · zoom in to separate calls</div>`;
  }
  const pend = e.status === 'pending';
  return `<div><b>${esc(e.name || e.type)}</b> <span class="cat cat-${esc(e.category || 'other')}">${esc(CAT_LABEL[e.category] || e.category || '')}</span> · <span class="${e.status === 'error' ? 'bad' : pend ? 'warn' : ''}">${esc(e.status || '')}</span>${e.exitCode != null ? ` · exit ${e.exitCode}` : ''}</div>
    <div class="row2"><span class="k">耗时</span>${pend ? `进行中 ${fmtDur(now() - e.t)}` : e.duration != null ? fmtDur(e.duration) : '–'}</div><div class="row2"><span class="k">时间</span>${fmtClock(e.t, true)}</div><div class="row2"><span class="k">agent</span>${esc(clip(agentTitle(a), 50))}</div>
    ${e.preview ? `<pre>${esc(clip(e.preview, 300))}</pre>` : ''}${(e.targets || []).length ? `<div class="mono" style="font-size:11px;margin-top:3px">${e.targets.slice(0, 6).map((x) => '→ ' + esc(clip(tlTargetText(x), 90))).join('<br>')}</div>` : ''}<div class="muted">点击查看事件详情 · click for event detail</div>`;
}

function tlDrawSoon() { if (!TL.raf) TL.raf = requestAnimationFrame(() => { TL.raf = 0; tlDraw(); }); }
function tlDrawThrottled(minGap) {
  const el = performance.now() - TL.lastDraw;
  if (el >= minGap) tlDraw();
  else if (!TL.timer) TL.timer = setTimeout(() => { TL.timer = 0; tlDraw(); }, minGap - el);
}
function renderTimeline(what) {
  const m = tlBuildModel();
  const scopeKey = m.scope.type === 'family' ? m.scope.root : 'running';
  if (TL.scopeKey !== scopeKey) { TL.scopeKey = scopeKey; TL.follow = m.scope.type === 'family' ? 'fit' : 30 * 60e3; byId('tl-scroll').scrollTop = 0; }
  tlEnsureData(m);
  tlToolbar(m);
  if (what && what.has('all')) tlDraw(); else tlDrawThrottled(what && what.has('tick') ? 800 : 350);
}
function tlToolbar(m) {
  const sc = m.scope, root = sc.type === 'family' ? S.agents.get(sc.root) : null;
  setHtml(byId('tl-scope'), sc.type === 'family'
    ? `<span class="muted">家族 Family</span>${root ? `${kindBadge(root.kind)}${statusDot(root.status)}<b title="${esc(agentTitle(root))}">${esc(clip(agentTitle(root), 46))}</b>` : ''}<button type="button" class="btn" data-act="tl-clear" title="取消选择，显示所有运行中的 agent">全部运行 All running</button>`
    : `<b>全部运行中</b> <span class="muted">All running · ${sc.roots} 个家族 families</span>`);
  let ev = 0;
  for (const n of m.nodes) { const s = S.stores.get(n.key); if (s) ev += s.list.length; }
  setText(byId('tl-count'), `${m.nodes.length} agents · ${m.lanes.length} lanes · ${ev} events`);
  for (const b of $$('#tl-ranges .btn')) b.setAttribute('aria-pressed', String(TL.follow === ({ all: 'fit', '5m': 300e3, '30m': 1800e3, '2h': 7200e3 })[b.dataset.range]));
  byId('tl-axis').setAttribute('aria-pressed', String(TL.collapse));
}

const TL_DEFS = '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--fg3)" stroke-width="1.6" opacity=".4"/></pattern><pattern id="stripes" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" style="stroke:var(--stripe)" stroke-width="2"/></pattern></defs>';

function tlDraw() {
  const sc = byId('tl-scroll'), svg = byId('tl-svg');
  const W = sc.clientWidth, H = sc.clientHeight;
  if (W < 120 || H < 120 || S.ui.view !== 'timeline') return;
  TL.lastDraw = performance.now();
  const m = tlBuildModel(), ax = m.axis, t = now(), empty = byId('tl-empty');
  if (!m.nodes.length) {
    svg.innerHTML = ''; TL.hit = { ticks: [], bars: [], lanes: [] };
    empty.hidden = false;
    empty.innerHTML = S.loaded ? '当前没有运行中的 agent<br><small>No running agents · 在「网络」视图选择一个 agent 查看它的家族时间线</small>' : '加载中… loading';
    byId('tl-spacer').style.height = '0px';
    return;
  }
  empty.hidden = true;
  const gut = Math.min(TL.gut, Math.round(W * 0.38)), axisH = TL.axisH, LH = TL.LH;
  const pw = Math.max(80, W - gut - 14), ph = H - axisH;

  // visible window (axis domain)
  const dMin = ax.D(m.minT), dMax = ax.D(m.anyOpen ? Math.max(m.maxT, t) : m.maxT);
  TL.dMin = dMin; TL.dMax = dMax;
  if (TL.follow === 'fit') { const pad = Math.max((dMax - dMin) * 0.03, 1500); TL.v0 = dMin - pad; TL.v1 = dMax + pad; }
  else if (typeof TL.follow === 'number') { TL.v1 = ax.D(t) + TL.follow * 0.04; TL.v0 = TL.v1 - TL.follow; }
  else if (!(TL.v1 > TL.v0)) { TL.v0 = dMin - 1000; TL.v1 = dMax + 1000; }
  const span = TL.v1 - TL.v0, k = pw / span;
  const X = (d) => tlClamp(gut + (d - TL.v0) * k, -1e5, 1e5), XT = (tt) => X(ax.D(tt));
  const tLo = ax.T(TL.v0), tHi = ax.T(TL.v1);
  Object.assign(TL, { W, H, pw, gut });

  // vertical virtualization
  byId('tl-spacer').style.height = Math.max(0, axisH + m.lanes.length * LH + 10 - H) + 'px';
  const top = sc.scrollTop, l0 = Math.max(0, Math.floor((top - 4) / LH)), l1 = Math.min(m.lanes.length - 1, Math.floor((top + ph) / LH));
  const yOf = (lane) => axisH + lane * LH - top;
  tlRefreshVisible(m, l0, l1);
  const hit = { ticks: [], bars: [], lanes: [] };
  const bg = [], conn = [], bars = [], ticks = [], gutter = [], axisSvg = [], over = [];
  const sel = selKey();

  let vis = 0;                                                    // visible events decide the merge distance
  for (let i = l0; i <= l1; i++) for (const n of m.lanes[i].nodes) { const s = S.stores.get(n.key); if (s && s.list.length) vis += Math.max(0, lowerBound(s.list, tHi + 1) - lowerBound(s.list, tLo - s.maxDur)); }
  const mg = vis > 30000 ? 6 : vis > 12000 ? 3.5 : vis > 5000 ? 2 : 1.1;
  let budget = 14000;
  TL.omitted = false;

  // grid + axis
  const step = pickStep(span / pw, 86);
  let prevDay = '';
  for (const [a, b] of visibleSegments(ax.gaps, tLo, tHi)) for (const tt of tickTimes(a, b, step)) {
    const x = XT(tt);
    if (x < gut || x > gut + pw + 10) continue;
    const d = new Date(tt), dayKey = d.getMonth() + '-' + d.getDate();
    const lbl = step >= 86400e3 ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : step < 60e3 ? fmtClock(tt) : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    bg.push(`<line class="grid-line" x1="${x.toFixed(1)}" y1="${axisH}" x2="${x.toFixed(1)}" y2="${H}"/>`);
    axisSvg.push(`<line class="axis-line" x1="${x.toFixed(1)}" y1="${axisH - 6}" x2="${x.toFixed(1)}" y2="${axisH}"/><text class="ax-txt" x="${(x + 3).toFixed(1)}" y="${axisH - 9}">${lbl}</text>`);
    if (dayKey !== prevDay && step < 86400e3) axisSvg.push(`<text class="ax-txt" x="${(x + 3).toFixed(1)}" y="${axisH - 22}" style="font-weight:600">${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}</text>`);
    prevDay = dayKey;
  }
  for (const g of ax.gaps) {
    const x0 = X(ax.D(g.s)), x1 = X(ax.D(g.e));
    if (x1 < gut || x0 > gut + pw + 14) continue;
    bg.push(`<rect class="gap-fill" x="${x0.toFixed(1)}" y="${axisH}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${ph}"/>`);
    axisSvg.push(`<path class="gap-glyph" d="M${x0.toFixed(1)} ${axisH - 5}l3 -5l3 5l3 -5l3 5"/><text class="ax-txt" x="${(x0 + 2).toFixed(1)}" y="${axisH - 14}" style="fill:var(--warn)">⋯ 空档 ${fmtDur(g.len)}</text>`);
  }

  // lanes, bars, ticks
  const pos = new Map();
  for (let i = l0; i <= l1; i++) {
    const lane = m.lanes[i], y = yOf(i), first = lane.nodes[0], fa = first.a;
    if (i % 2) bg.push(`<rect class="lane-alt" x="${gut}" y="${y}" width="${pw + 14}" height="${LH}"/>`);
    const hostChange = i === 0 || m.lanes[i - 1].host !== lane.host;
    if (hostChange && i > 0) bg.push(`<line class="grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}" style="stroke:var(--line2)"/>`);
    const ind = Math.min(first.depth, 7) * 9, maxPx = gut - 44 - ind - (hostChange ? 70 : 0);
    hit.lanes.push({ type: 'lane', node: first, x: 0, y, w: gut, h: LH });
    gutter.push(`<g><rect class="gk" x="${6 + ind}" y="${y + 8}" width="13" height="13" rx="2" style="fill:var(--c-${fa.kind})"/><text x="${12.5 + ind}" y="${y + 18}" text-anchor="middle" style="fill:#fff;font-size:9px;font-weight:700">${KIND_LETTER[fa.kind]}</text><circle class="sdot s-${esc(fa.status)}" cx="${28 + ind}" cy="${y + 14.5}" r="3.3"/><text class="glab" x="${37 + ind}" y="${y + 18.5}"${first.key === sel ? ' style="font-weight:700"' : ''}>${esc(clipPx(agentTitle(fa), maxPx - (lane.nodes.length > 1 ? 22 : 0)))}${lane.nodes.length > 1 ? ` +${lane.nodes.length - 1}` : ''}</text>${hostChange ? `<text class="glab sub" x="${gut - 6}" y="${y + 18.5}" text-anchor="end">${esc(clipPx(shortHost(lane.host), 66))}</text>` : ''}</g>`);

    for (const n of lane.nodes) {
      const end = n.open ? t : n.end, x0 = XT(n.start), x1 = Math.max(XT(end), x0 + 2.5);
      pos.set(n.key, { y, x0, x1 });
      if (x1 < gut - 1 || x0 > gut + pw + 14) continue;
      hit.bars.push({ type: 'bar', node: n, x: x0, y: y + 2, w: x1 - x0, h: LH - 4 });
      bars.push(`<rect class="bar k-${n.a.kind}${n.open ? ' run' : ''}${n.a.status === 'stale' ? ' stale' : ''}${n.key === sel ? ' sel' : ''}" x="${x0.toFixed(1)}" y="${y + 2}" width="${(x1 - x0).toFixed(1)}" height="${LH - 4}" rx="3"/>`);
      const vx0 = Math.max(x0, gut), vw = Math.min(x1, gut + pw) - vx0;
      const par = n.parent ? S.agents.get(n.parent) : null, cross = par && par.host !== n.host;
      if (vw > 44) {
        const lbl = (cross ? `↗ ${shortHost(n.host)} · ` : '') + (n.a.role !== 'main' && n.a.name ? n.a.name + ' · ' : '') + agentTitle(n.a);
        ticks.push(`<text class="bar-lbl" x="${(vx0 + 5).toFixed(1)}" y="${y + 12.5}"${cross ? ' style="fill:var(--accent);font-weight:600"' : ''}>${esc(clipPx(lbl, vw - 8))}</text>`);
      }
      const s = S.stores.get(n.key);
      if (!s || !s.list.length) continue;
      tlPackRows(s);
      const rows = Math.min(3, s.rows), rh = 10 / rows, accs = [null, null, null];
      let accM = null;
      const emitTick = (c, r) => {
        const w = Math.max(c.x1 - c.x0, 1.5), ry = y + 19 + r * rh, h = Math.max(rh - (rows > 1 ? 0.6 : 0), 2.2);
        hit.ticks.push({ type: 'tick', node: n, evs: c.evs, n: c.n, x: c.x0, y: ry, w, h });
        ticks.push(`<rect class="t t-${c.cat}" x="${c.x0.toFixed(1)}" y="${ry.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1"${c.pend ? ' opacity=".7"' : ''}/>`);
        if (c.pend) ticks.push(`<rect class="t pend-ov" x="${c.x0.toFixed(1)}" y="${ry.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`);
        if (c.err) ticks.push(`<rect class="t-err" x="${(c.x0 - 0.6).toFixed(1)}" y="${(ry - 0.6).toFixed(1)}" width="${(w + 1.2).toFixed(1)}" height="${(h + 1.2).toFixed(1)}" rx="1.5"/>`);
      };
      for (let j = lowerBound(s.list, tLo - s.maxDur); j < s.list.length; j++) {
        const e = s.list[j];
        if (e.t > tHi) break;
        if (budget <= 0) { TL.omitted = true; break; }
        if (e.type === 'tool' || e.type === 'spawn') {
          const pend = e.status === 'pending', err = e.status === 'error';
          const endT = e.duration != null ? e.t + e.duration : pend ? t : e.t;
          const xa = XT(e.t), xb = Math.max(XT(Math.max(endT, e.t)), xa);
          if (xb < gut - 2 || xa > gut + pw + 14) continue;
          const cat = e.type === 'spawn' ? 'spawn' : CATS.includes(e.category) ? e.category : 'other', pr = err ? 9 : pend ? 8 : TL_PRIO[cat] || 3, r = Math.min(e._r || 0, rows - 1);
          const c = accs[r];
          if (c && xa <= c.x1 + mg) {
            c.x1 = Math.max(c.x1, xb); c.n++;
            if (pr > c.pr) { c.pr = pr; c.cat = cat; }
            if (c.evs.length < 6) c.evs.push(e);
            if (pend) c.pend = true;
            if (err) c.err = true;
          } else { if (c) emitTick(c, r); budget -= 2; accs[r] = { x0: xa, x1: xb, cat, pr, n: 1, evs: [e], pend, err }; }
        } else if (e.type === 'model') {
          const xa = XT(e.t), xb = XT(e.t + (e.duration || 0));
          if (xb < gut - 2 || xa > gut + pw + 14) continue;
          if (accM && xa <= accM.x1 + mg) accM.x1 = Math.max(accM.x1, xb);
          else { if (accM) ticks.push(`<rect style="fill:var(--c-model)" x="${accM.x0.toFixed(1)}" y="${y + 15.4}" width="${Math.max(accM.x1 - accM.x0, 1.3).toFixed(1)}" height="2.2"/>`); budget--; accM = { x0: xa, x1: xb }; }
        } else if (e.type === 'user' || e.type === 'error' || e.type === 'message' || e.type === 'compaction') {
          const xa = XT(e.t);
          if (xa < gut - 3 || xa > gut + pw + 14) continue;
          hit.ticks.push({ type: 'mark', node: n, evs: [e], n: 1, x: xa - 3.5, y: y + 12.5, w: 7, h: 8 });
          budget--;
          ticks.push(e.type === 'user' ? `<circle class="m-user" cx="${xa.toFixed(1)}" cy="${y + 16.5}" r="2.6"/>`
            : e.type === 'error' ? `<path class="m-error" d="M${(xa - 3.5).toFixed(1)} ${y + 20}l3.5 -7l3.5 7z"/>`
            : e.type === 'message' ? `<rect class="m-msg" x="${(xa - 2.5).toFixed(1)}" y="${y + 14}" width="5" height="5"/>`
            : `<path class="m-comp" d="M${xa.toFixed(1)} ${y + 13}l3.5 3.5l-3.5 3.5l-3.5 -3.5z"/>`);
        }
      }
      for (let r = 0; r < 3; r++) if (accs[r]) emitTick(accs[r], r);
      if (accM) ticks.push(`<rect style="fill:var(--c-model)" x="${accM.x0.toFixed(1)}" y="${y + 15.4}" width="${Math.max(accM.x1 - accM.x0, 1.3).toFixed(1)}" height="2.2"/>`);
    }
  }

  // spawn connectors (parent tool tick → child bar start) and return markers (child end → spawn call result)
  for (const n of m.nodes) {
    if (!n.parent) continue;
    const pp = pos.get(n.parent), cp = pos.get(n.key);
    if (!pp || !cp) continue;
    const ps = S.stores.get(n.parent), tc = n.link && n.link.toolCallId;
    let ev = ps && tc ? ps.byId.get(tc) : null;
    if (!ev && ps) {
      let best = Infinity;
      for (let j = lowerBound(ps.list, n.start - 90e3); j < ps.list.length; j++) {
        const e = ps.list[j];
        if (e.t > n.start + 3000) break;
        if (e.type !== 'spawn' && e.category !== 'spawn' && e.category !== 'remote' && e.category !== 'k8s') continue;
        const dt = Math.abs(n.start - e.t);
        if (dt < best) { best = dt; ev = e; }
      }
    }
    const col = S.agents.get(n.parent).host !== n.host ? 'var(--c-remote)' : 'var(--c-spawn)';
    const yp = pp.y + 29, yc = cp.y + 16, xe = ev ? XT(ev.t) : cp.x0, xc = cp.x0;
    if (Math.max(xe, xc) >= gut && Math.min(xe, xc) <= gut + pw + 14) conn.push(`<path class="conn" d="M${xe.toFixed(1)} ${yp.toFixed(1)}V${yc.toFixed(1)}H${xc.toFixed(1)}" style="stroke:${col}"/><circle cx="${xc.toFixed(1)}" cy="${yc.toFixed(1)}" r="2.6" style="fill:${col}"/>`);
    if (ev && ev.duration != null && !n.open) {
      const xr = XT(ev.t + ev.duration), xce = cp.x1;
      if (Math.max(xr, xce) >= gut && Math.min(xr, xce) <= gut + pw + 14) conn.push(`<path class="conn ret" d="M${xce.toFixed(1)} ${yc.toFixed(1)}H${xr.toFixed(1)}V${yp.toFixed(1)}" style="stroke:${col}"/><path class="ret-mk" d="M${xr.toFixed(1)} ${(yp - 4).toFixed(1)}l4 4l-4 4l-4 -4z" style="fill:${col}"/>`);
    }
  }

  // now line
  const xn = XT(t);
  if (xn >= gut && xn <= gut + pw + 14) over.push(`<line class="now-line" x1="${xn.toFixed(1)}" y1="${axisH - 4}" x2="${xn.toFixed(1)}" y2="${H}"/><text class="now-lbl" x="${(xn - 3).toFixed(1)}" y="${axisH - 22}" text-anchor="end">现在 ${fmtClock(t)}</text>`);
  if (TL.omitted) over.push(`<text class="ax-txt" x="${gut + 6}" y="${H - 6}" style="fill:var(--warn)">部分刻度已合并/省略，放大查看 · ticks merged, zoom in</text>`);

  TL.hit = hit; TL.map = { gut, pw, k, v0: TL.v0, ax };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `${TL_DEFS}<clipPath id="tl-c1"><rect x="${gut}" y="${axisH}" width="${pw + 14}" height="${ph}"/></clipPath><clipPath id="tl-c2"><rect x="${gut}" y="0" width="${pw + 14}" height="${axisH}"/></clipPath><clipPath id="tl-c3"><rect x="0" y="${axisH}" width="${gut}" height="${ph}"/></clipPath>
    <rect class="gutter-bg" x="0" y="0" width="${gut}" height="${H}"/>
    <g clip-path="url(#tl-c1)">${bg.join('')}${conn.join('')}${bars.join('')}${ticks.join('')}</g>
    <rect class="axis-bg" x="0" y="0" width="${W}" height="${axisH}"/><line class="axis-line" x1="0" y1="${axisH}" x2="${W}" y2="${axisH}"/>
    <g clip-path="url(#tl-c2)">${axisSvg.join('')}</g><g clip-path="url(#tl-c3)">${gutter.join('')}</g>
    <line class="axis-line" x1="${gut}" y1="0" x2="${gut}" y2="${H}"/>
    <text class="ax-txt" x="8" y="${axisH - 9}">${TL.collapse ? '活跃轴 active' : '实际时间 real'}</text>
    <text class="ax-txt" x="8" y="${axisH - 22}">${m.scope.type === 'family' ? '家族 family' : '全部运行 running'}</text>
    <g clip-path="url(#tl-c1)">${over.join('')}<line id="tl-cross" class="axis-line" y1="${axisH}" y2="${H}" visibility="hidden" style="stroke-dasharray:2 3"/><rect id="tl-hover" class="hover-box" visibility="hidden"/><rect id="tl-brush" class="brush" y="0" height="${H}" visibility="hidden"/></g>
    <text id="tl-cross-t" class="ax-txt" y="${axisH - 22}" visibility="hidden" style="fill:var(--fg);font-weight:600"></text>`;
  tlOverlay();
}

/** Geometry hit test: ticks (±3 px slop) beat bars; the label gutter hits lanes. */
function tlPick(x, y) {
  if (y < TL.axisH) return null;
  const h = TL.hit;
  if (x < TL.gut) { for (const o of h.lanes) if (y >= o.y && y < o.y + o.h) return o; return null; }
  let best = null, bd = 1e9;
  for (const o of h.ticks) {
    if (y < o.y - 3 || y > o.y + o.h + 3 || x < o.x - 3 || x > o.x + o.w + 3) continue;
    const d = x < o.x ? o.x - x : x > o.x + o.w ? x - o.x - o.w : 0;
    if (d < bd) { bd = d; best = o; }
  }
  if (best) return best;
  for (let i = h.bars.length - 1; i >= 0; i--) { const o = h.bars[i]; if (x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h) return o; }
  return null;
}
/** Repositions hover box, crosshair and brush without redrawing the chart. */
function tlOverlay() {
  const svg = byId('tl-svg'), hov = svg.querySelector('#tl-hover'), cross = svg.querySelector('#tl-cross'), ct = svg.querySelector('#tl-cross-t'), br = svg.querySelector('#tl-brush');
  if (!hov) return;
  const p = TL.ptr, o = p && !TL.drag ? tlPick(p.x, p.y) : null;
  TL.hot = o;
  if (o) { hov.setAttribute('x', (o.x - 1).toFixed(1)); hov.setAttribute('y', (o.y - 1).toFixed(1)); hov.setAttribute('width', (o.w + 2).toFixed(1)); hov.setAttribute('height', (o.h + 2).toFixed(1)); hov.setAttribute('rx', '2'); hov.setAttribute('visibility', 'visible'); } else hov.setAttribute('visibility', 'hidden');
  svg.style.cursor = o ? 'pointer' : '';
  if (p && p.x >= TL.gut && p.x <= TL.gut + TL.pw && p.y >= TL.axisH && TL.map) {
    const tt = TL.map.ax.T(TL.map.v0 + (p.x - TL.gut) / TL.map.k);
    cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.setAttribute('visibility', 'visible');
    ct.setAttribute('x', Math.min(p.x + 4, TL.W - 74)); ct.textContent = fmtClock(tt); ct.setAttribute('visibility', 'visible');
  } else { cross.setAttribute('visibility', 'hidden'); ct.setAttribute('visibility', 'hidden'); }
  if (TL.brush) { br.setAttribute('x', Math.min(TL.brush.x0, TL.brush.x1)); br.setAttribute('width', Math.abs(TL.brush.x1 - TL.brush.x0)); br.setAttribute('visibility', 'visible'); } else br.setAttribute('visibility', 'hidden');
}

/** Sets the visible window (manual mode) with sane bounds. */
function tlSetWindow(v0, v1) {
  const full = Math.max(TL.dMax - TL.dMin, 60e3), span = tlClamp(v1 - v0, TL_MIN_SPAN, full * 6 + 3600e3), mid = (v0 + v1) / 2;
  TL.v0 = mid - span / 2; TL.v1 = mid + span / 2; TL.follow = null;
  tlDrawSoon();
  if (TL.model) tlToolbar(TL.model);
}
function tlZoom(factor, anchorPx) {
  const span = TL.v1 - TL.v0, frac = tlClamp(anchorPx / TL.pw, 0, 1), anchor = TL.v0 + span * frac;
  const ns = tlClamp(span * factor, TL_MIN_SPAN, Math.max(TL.dMax - TL.dMin, 60e3) * 6 + 3600e3), v0 = anchor - ns * frac;
  tlSetWindow(v0, v0 + ns);
}
function tlPan(dxPx) { const shift = (dxPx / TL.pw) * (TL.v1 - TL.v0); tlSetWindow(TL.v0 - shift, TL.v1 - shift); }
function tlFollowDefault() { TL.follow = S.ui.key ? 'fit' : 30 * 60e3; tlDraw(); tlToolbar(TL.model); }
function tlClickHot(o) {
  if (!o) return;
  if (o.type === 'tick' || o.type === 'mark') openAgent(o.node.key, { ev: o.evs[0].id }); else openAgent(o.node.key);
}

function initTimeline() {
  const sc = byId('tl-scroll'), svg = byId('tl-svg');
  byId('tl-legend').innerHTML = CATS.map((c) => `<span class="cat-${c}"><i style="--cc:var(--c-${c})"></i>${esc(CAT_LABEL[c])}</span>`).join('') + '<span><i class="pend"></i>进行中 pending</span><span><i class="mod"></i>模型调用 model</span><span style="color:var(--bad)">▲ 错误 error</span><span><span style="color:var(--c-user)">●</span> 用户 prompt</span><span><span style="color:var(--c-remote)">━</span> 跨主机派生 cross-host spawn</span><span><span style="color:var(--c-spawn)">━</span> 派生/返回 spawn/return ◆</span>';
  new ResizeObserver(() => { if (S.ui.view === 'timeline') tlDrawSoon(); }).observe(sc);
  sc.addEventListener('scroll', () => { if (S.ui.view === 'timeline') tlDrawSoon(); }, { passive: true });
  const local = (ev) => { const r = svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const p = local(ev);
    TL.drag = { x0: p.x, y0: p.y, v0: TL.v0, v1: TL.v1, st: sc.scrollTop, moved: false, type: p.x < TL.gut ? 'gutter' : p.y < TL.axisH ? 'brush' : 'pan' };
    if (TL.drag.type !== 'gutter') { try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ } }
    hideTip();
  });
  svg.addEventListener('pointermove', (ev) => {
    const p = local(ev), d = TL.drag;
    TL.ptr = p;
    if (d && d.type !== 'gutter') {
      if (Math.abs(p.x - d.x0) > 3 || Math.abs(p.y - d.y0) > 3) d.moved = true;
      if (d.moved) {
        svg.classList.add('panning');
        if (d.type === 'pan') {
          const shift = ((p.x - d.x0) / TL.pw) * (d.v1 - d.v0);
          TL.v0 = d.v0 - shift; TL.v1 = d.v1 - shift; TL.follow = null;
          sc.scrollTop = d.st - (p.y - d.y0);
          tlDrawSoon();
          if (TL.model) tlToolbar(TL.model);
        } else { TL.brush = { x0: tlClamp(d.x0, TL.gut, TL.gut + TL.pw), x1: tlClamp(p.x, TL.gut, TL.gut + TL.pw) }; tlOverlay(); }
      }
      hideTip();
      return;
    }
    tlOverlay();
    if (TL.hot) showTip(tlTipHtml(TL.hot), ev.clientX, ev.clientY); else hideTip();
  });
  const endDrag = (ev, cancel) => {
    const d = TL.drag; TL.drag = null; svg.classList.remove('panning');
    if (!d) return;
    if (d.type === 'brush' && d.moved && TL.brush && !cancel) {
      const a = Math.min(TL.brush.x0, TL.brush.x1), b = Math.max(TL.brush.x0, TL.brush.x1);
      TL.brush = null;
      if (b - a > 6) { const k = (d.v1 - d.v0) / TL.pw; tlSetWindow(d.v0 + (a - TL.gut) * k, d.v0 + (b - TL.gut) * k); return; }
    }
    TL.brush = null;
    if (!d.moved && !cancel) { const p = local(ev); TL.ptr = p; tlClickHot(tlPick(p.x, p.y)); }
    tlOverlay();
  };
  svg.addEventListener('pointerup', (ev) => endDrag(ev, false));
  svg.addEventListener('pointercancel', (ev) => endDrag(ev, true));
  svg.addEventListener('pointerleave', () => { if (!TL.drag) { TL.ptr = null; tlOverlay(); } hideTip(); });
  svg.addEventListener('dblclick', (ev) => { if (local(ev).x >= TL.gut) tlFollowDefault(); });
  svg.addEventListener('wheel', (ev) => {
    const p = local(ev);
    if (p.x < TL.gut || ev.altKey) return;                    // label gutter / Alt: native vertical scrolling of the lanes
    ev.preventDefault();
    const dx = ev.deltaMode === 1 ? ev.deltaX * 16 : ev.deltaX, dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    if (ev.shiftKey || Math.abs(dx) > Math.abs(dy)) tlPan(-(dx || dy));
    else tlZoom(Math.exp(dy * 0.0016), p.x - TL.gut);
  }, { passive: false });
  sc.addEventListener('keydown', (ev) => {
    if (ev.target !== sc) return;
    const mid = TL.pw / 2;
    if (ev.key === '+' || ev.key === '=') tlZoom(0.6, mid);
    else if (ev.key === '-' || ev.key === '_') tlZoom(1 / 0.6, mid);
    else if (ev.key === '0') tlFollowDefault();
    else if (ev.key === 'ArrowLeft') tlPan(TL.pw * 0.2);
    else if (ev.key === 'ArrowRight') tlPan(-TL.pw * 0.2);
    else if (ev.key === 'End') { TL.follow = TL.v1 - TL.v0; tlDraw(); tlToolbar(TL.model); }
    else return;
    ev.preventDefault();
  });
  byId('tl-zoom-in').addEventListener('click', () => tlZoom(0.55, TL.pw / 2));
  byId('tl-zoom-out').addEventListener('click', () => tlZoom(1 / 0.55, TL.pw / 2));
  byId('tl-fit').addEventListener('click', tlFollowDefault);
  byId('tl-ranges').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-range]');
    if (!b) return;
    TL.follow = ({ '5m': 300e3, '30m': 1800e3, '2h': 7200e3, all: 'fit' })[b.dataset.range];
    tlDraw(); tlToolbar(TL.model);
  });
  byId('tl-axis').addEventListener('click', () => {
    const old = TL.model ? TL.model.axis : null, r0 = old ? old.T(TL.v0) : 0, r1 = old ? old.T(TL.v1) : 0;
    TL.collapse = !TL.collapse; TL.modelSig = '';
    const m = tlBuildModel();
    if (TL.follow === null && old) { TL.v0 = m.axis.D(r0); TL.v1 = m.axis.D(r1); }
    tlDraw(); tlToolbar(m);
  });
}

/* ───────────────────────── 5e. pods view ───────────────────────── */

const touchIdx = { pod: { at: 0, loading: false, error: '' }, file: { at: 0, loading: false, error: '' } };
/** Pulls the fleet-wide tool-call index for pod / file targets so the tables are complete, not just what the feed carried. */
function loadTouchIndex(type, force) {
  const st = touchIdx[type];
  if (st.loading || (!force && Date.now() - st.at < 20000)) return;
  st.loading = true;
  api('query', { target: type, limit: 3000, since: Math.floor(now() - 24 * 3600e3) })
    .then((r) => { for (const it of (r && r.items) || []) ingestEvent(it.agent, it.event); st.error = ''; }, (e) => { st.error = e.message || String(e); })
    .finally(() => { st.loading = false; st.at = Date.now(); scheduleRender('touch'); });
}

const podBad = (p) => !p || !['Running', 'Succeeded'].includes(p.phase) || (p.containers || []).some((c) => containerClass(c.state) === 'bad') || (p.restarts || 0) >= 5 || (p.phase === 'Running' && /^0\//.test(p.ready || ''));
function podRows() {
  const rows = new Map();
  for (const p of S.pods.values()) rows.set(p.key, { key: p.key, site: p.site, name: p.name, pod: p });
  for (const key of S.touch.pods.keys()) if (!rows.has(key)) { const [site, , ...rest] = key.split('/'); rows.set(key, { key, site, name: rest.join('/'), pod: null }); }
  return [...rows.values()];
}
function renderPods() {
  loadTouchIndex('pod');
  const u = S.ui;
  const terms = u.podQ.toLowerCase().split(/\s+/).filter(Boolean);
  const all = podRows();
  for (const r of all) {
    const m = S.touch.pods.get(r.key);
    r.ts = summarizeTouches(m || new Map());
  }
  const list = all.filter((r) => {
    if (u.podSite && r.site !== u.podSite) return false;
    if (u.podPhase) { if (u.podPhase === 'bad' ? !podBad(r.pod) || !r.pod : !r.pod || r.pod.phase !== u.podPhase) return false; }
    if (u.podTouched && !r.ts.n) return false;
    if (terms.length) {
      const hay = [r.name, r.pod && r.pod.node, r.pod && r.pod.phase, ...(r.pod ? r.pod.containers.map((c) => c.name + ' ' + c.image) : []), ...[...r.ts.agents.keys()].map((k) => { const a = S.agents.get(k); return a ? agentTitle(a) + ' ' + a.kind : k; })].filter(Boolean).join(' ').toLowerCase();
      for (const t of terms) if (!hay.includes(t)) return false;
    }
    return true;
  });
  const t = now(), items = [];
  const bySite = new Map();
  for (const r of list) { let l = bySite.get(r.site); if (!l) bySite.set(r.site, (l = [])); l.push(r); }
  for (const site of siteList()) {
    const l = bySite.get(site);
    if (!l) continue;
    l.sort((a, b) => (b.ts.last - a.ts.last) || (a.pod && a.pod.collect ? -1 : 0) || (a.name < b.name ? -1 : 1));
    const bad = l.filter((r) => r.pod && podBad(r.pod)).length;
    items.push({ key: 'g:' + site, tag: 'tr', cls: 'group', sig: `g|${l.length}|${bad}`, html: `<td colspan="11">${esc(siteLabel(site))} <span class="muted" style="font-weight:400">· ${l.length} pods${bad ? ` · <span class="ph-bad">${bad} 异常</span>` : ''}${S.sources[site] && S.sources[site].status !== 'online' ? ` · <span class="ph-bad">kube ${esc(S.sources[site].status)}</span> ${esc(S.sources[site].error || '')}` : ''}</span></td>` });
    for (const r of l) {
      const p = r.pod, ts = r.ts, sel = u.pod === r.key;
      const age = p && p.createdAt ? fmtAge(t - p.createdAt) : '–';
      const last = ts.last ? fmtAge(t - ts.last) : '';
      const sig = [p ? p._v : 'x', ts.n, ts.last, sel ? 1 : 0, ts.agents.size, S.ver.agents].join('|');
      items.push({
        key: r.key, tag: 'tr', cls: sel ? 'sel' : '', sig, attrs: { 'data-pod': r.key, tabindex: '0' },
        html: () => {
          const ag = [...ts.agents].sort((x, y) => y[1].last - x[1].last);
          const chips = ag.slice(0, 4).map(([k]) => agentChip(k, 18)).join('') + (ag.length > 4 ? `<span class="chip">+${ag.length - 4}</span>` : '');
          const ops = [...ts.ops].sort((x, y) => y[1] - x[1]).map(([op, n]) => `<span class="opchip">${esc(op)}×${n}</span>`).join('');
          if (!p) return `<td class="mono">${esc(r.name)} <span class="tag" title="hub 的 kube watch 里没有这个 pod">untracked</span></td><td class="muted" colspan="3">未被 kube 监视 · not watched</td><td>–</td><td>–</td><td class="muted">–</td><td class="num">–</td><td class="wrapchips">${chips}</td><td>${last}</td><td>${ops}</td>`;
          const gpu = p.requests && p.requests.gpu ? p.requests.gpu : 0;
          return `<td class="mono" title="${esc(p.key)}">${esc(p.name)}${p.collect ? ' <span class="chip good" title="collector attached">collector</span>' : ''}${p.deletedAt ? ' <span class="tag">terminating</span>' : ''}</td>
            <td class="ph-${esc(p.phase)}${podBad(p) && p.phase === 'Running' ? ' ph-bad' : ''}">● ${esc(p.phase)}</td><td class="mono">${esc(p.ready || '')}</td><td class="num${p.restarts >= 5 ? ' ph-bad' : ''}">${p.restarts || 0}</td>
            <td class="mono" title="${esc(p.podIP || '')}">${esc(p.node || '–')}</td><td class="num" data-live="age" data-t="${p.createdAt || 0}">${age}</td>
            <td>${(p.containers || []).map((c) => `<span class="cstate ${containerClass(c.state)}" title="${esc(c.image)}">● ${esc(c.name)} <span class="muted">${esc(clip(c.state, 26))}</span></span>`).join('')}</td>
            <td class="num">${gpu || '–'}</td><td class="wrapchips">${chips}</td><td data-live="age" data-t="${ts.last || 0}" title="${ts.last ? esc(fmtDateTime(ts.last)) : ''}">${last}</td><td>${ops}</td>`;
        },
      });
    }
  }
  if (!items.length) items.push({ key: 'empty', tag: 'tr', cls: 'empty', sig: 'e', html: '<td colspan="11" class="muted" style="padding:20px;text-align:center">没有符合条件的 pod · no pods match</td>' });
  reconcile(byId('pods-body'), items);
  setText(byId('p-count'), `${list.length} / ${all.length} pods${touchIdx.pod.error ? ' · 触碰索引: ' + clip(touchIdx.pod.error, 50) : ''}`);
}

/* ───────────────────────── 5f. files view ───────────────────────── */

let fileAgg = null, fileAggVer = -1;
function fileRows() {
  if (fileAgg && fileAggVer === S.ver.touch) return fileAgg;
  fileAgg = [];
  for (const [key, m] of S.touch.files) {
    const { host, path } = splitFileKey(key), ts = summarizeTouches(m);
    fileAgg.push({ key, host, path, ts });
  }
  fileAggVer = S.ver.touch;
  return fileAgg;
}
function renderFiles() {
  loadTouchIndex('file');
  const u = S.ui, rows = fileRows(), t = now();
  const hosts = new Set(), agents = new Set();
  for (const r of rows) { hosts.add(r.host); for (const k of r.ts.agents.keys()) agents.add(k); }
  fillSelect(byId('fl-host'), [['', '全部 All'], ...[...hosts].sort().map((h) => [h, hostLabel(h)])], u.fileHost);
  fillSelect(byId('fl-agent'), [['', '全部 All'], ...[...agents].map((k) => [k, (S.agents.get(k) ? KIND_LETTER[S.agents.get(k).kind] + ' ' + clip(agentTitle(S.agents.get(k)), 40) : k) + ' · ' + hostLabel((S.agents.get(k) || {}).host || '')]).sort((a, b) => (a[1] < b[1] ? -1 : 1))], u.fileAgent);
  for (const b of $$('#fl-ops .btn')) b.setAttribute('aria-pressed', String(u.fileOps.has(b.dataset.op)));
  if (byId('fl-q').value !== u.fileQ) byId('fl-q').value = u.fileQ;
  const q = u.fileQ.toLowerCase();
  const list = rows.filter((r) => {
    if (u.fileHost && r.host !== u.fileHost) return false;
    if (u.fileAgent && !r.ts.agents.has(u.fileAgent)) return false;
    if (u.fileOps.size && ![...u.fileOps].some((o) => r.ts[o] > 0)) return false;
    if (q && !r.path.toLowerCase().includes(q)) return false;
    return true;
  });
  list.sort((a, b) => b.ts.last - a.ts.last || (a.path < b.path ? -1 : 1));
  const shown = list.slice(0, 600);
  reconcile(byId('files-body'), shown.map((r) => {
    const ts = r.ts, sel = u.file === r.key, last = fmtAge(t - ts.last);
    return {
      key: r.key, tag: 'tr', cls: sel ? 'sel' : '', sig: [ts.n, ts.r, ts.w, ts.e, ts.last, ts.agents.size, sel ? 1 : 0, S.ver.agents].join('|'), attrs: { 'data-file': r.key, tabindex: '0' },
      html: () => {
        const ag = [...ts.agents].sort((x, y) => y[1].last - x[1].last);
        return `<td><span class="path" title="${esc(r.path)}"><span class="dir">${esc(dirName(r.path))}</span><span class="base">${esc(baseName(r.path))}</span></span></td><td class="mono">${esc(shortHost(r.host))}</td>
          <td class="num r${ts.r ? '' : ' zero'}">${ts.r}</td><td class="num w${ts.w ? '' : ' zero'}">${ts.w}</td><td class="num e${ts.e ? '' : ' zero'}">${ts.e}</td><td data-live="age" data-t="${ts.last || 0}" title="${esc(fmtDateTime(ts.last))}">${last}</td>
          <td class="wrapchips">${ag.slice(0, 3).map(([k]) => agentChip(k, 16)).join('')}${ag.length > 3 ? `<span class="chip">+${ag.length - 3}</span>` : ''}</td>`;
      },
    };
  }));
  setText(byId('fl-count'), `${list.length}${list.length > shown.length ? ' (显示前 600)' : ''} / ${rows.length} 文件${touchIdx.file.error ? ' · ' + clip(touchIdx.file.error, 40) : ''}`);
  renderFilePreview();
}

const filePrev = new Map();
function loadFilePreview(key, force) {
  const rec = filePrev.get(key) || { at: 0, data: null, error: '', loading: false };
  if (rec.loading || (!force && rec.data && Date.now() - rec.at < 30000)) return rec;
  rec.loading = true; filePrev.set(key, rec);
  const { host, path } = splitFileKey(key);
  api('file', { host, path }).then((d) => { rec.data = d; rec.error = ''; }, (e) => { rec.error = e.message || String(e); })
    .finally(() => { rec.loading = false; rec.at = Date.now(); scheduleRender('file'); });
  return rec;
}
function codeHtml(content) {
  const MAX = 4000;
  let lines = String(content).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const cut = lines.length > MAX;
  if (cut) lines = lines.slice(0, MAX);
  const w = String(lines.length).length;
  return `<div class="code"><pre class="ln" aria-hidden="true">${lines.map((_, i) => String(i + 1).padStart(w, ' ')).join('\n')}</pre><pre class="tx">${esc(lines.join('\n'))}${cut ? '\n… 已截断显示前 ' + MAX + ' 行 · display capped' : ''}</pre></div>`;
}
function renderFilePreview() {
  const el = byId('file-preview'), u = S.ui;
  if (!u.file) { setHtml(el, '<div class="empty">选择左侧文件以预览内容 · select a file to preview<br><small>内容经采集器读取并脱敏 (api/file)</small></div>'); return; }
  const { host, path } = splitFileKey(u.file);
  const rec = loadFilePreview(u.file);
  const d = rec.data, tm = S.touch.files.get(u.file) || new Map();
  const touches = [...tm.values()].sort((a, b) => b.t - a.t);
  const edit = (u.fileEvent && tm.get(u.fileEvent)) || touches.find((x) => x.op === 'edit' || x.op === 'write') || null;
  const banners = [];
  if (d) {
    if (d.denied) banners.push(`<div class="notice bad"><b>已拒绝 denied</b> · ${esc(d.denied)} — 出于安全原因不显示内容 · content not shown</div>`);
    else if (d.exists === false) banners.push('<div class="notice warn"><b>文件不存在 not found</b> · 已被删除/移动，或位于离线主机 · deleted, moved, or host offline</div>');
    else if (d.binary) banners.push('<div class="notice info"><b>二进制文件 binary</b> · 不显示内容 · not rendered</div>');
    if (d.truncated) banners.push(`<div class="notice warn"><b>已截断 truncated</b> · 仅显示前 ${fmtBytes((d.content || '').length)} / 共 ${fmtBytes(d.size)}</div>`);
    if (d.redactions) banners.push(`<div class="notice info"><b>${d.redactions} 处已脱敏 redacted</b> · 疑似密钥已被替换为 ‹redacted›</div>`);
  }
  if (rec.error) banners.push(`<div class="notice bad"><b>读取失败</b> · ${esc(rec.error)} <button type="button" class="btn" data-act="file-retry">重试</button></div>`);
  if (edit && edit.preview) banners.push(`<div class="notice info"><b>${esc(edit.op || 'edit')} · ${fmtClock(edit.t)}</b> ${agentChip(edit.agent, 22)} <span class="mono">${esc(edit.preview)}</span></div>`);
  const meta = d && d.exists !== false && !d.denied ? [d.size != null ? fmtBytes(d.size) : '', d.mtime ? 'mtime ' + fmtDateTime(d.mtime) : ''].filter(Boolean).join(' · ') : '';
  const body = rec.loading && !d ? '<div class="empty">读取中… reading</div>' : d && d.content != null && !d.denied && !d.binary && d.exists !== false ? codeHtml(d.content) : '';
  const tList = touches.slice(0, 60).map((x) => { const tk = x.agent + '|' + x.id; return `<div class="trow${u.fileEvent === tk ? ' sel' : ''}" data-fev="${esc(tk)}" role="button" tabindex="0"><span class="tm muted">${fmtClock(x.t)}</span><span>${agentChip(x.agent, 20)} <span class="opchip">${esc(x.op || '')}</span></span><span class="pv" title="${esc(x.preview || '')}">${esc(x.preview || x.name || '')}</span></div>`; }).join('');
  setHtml(el, `<div class="ph"><div class="p">${esc(path)}</div><div class="banners"><span class="chip">${ico('host', 'sm')}${esc(hostLabel(host))}</span>${meta ? `<span class="muted">${esc(meta)}</span>` : ''}<span style="flex:1"></span><button type="button" class="btn" data-act="copy" data-v="${esc(path)}">${ico('copy', 'sm')} 复制路径</button><button type="button" class="btn" data-act="file-retry" title="重新读取">${ico('refresh', 'sm')}</button></div></div>${banners.join('')}${body}<div class="touches"><h4>被触碰 Touches · ${touches.length}</h4>${tList || '<div class="muted" style="padding:4px 10px">无记录</div>'}</div>`);
}

/* ───────────────────────── 5g. feed view ───────────────────────── */

let feedSeen = null;
function renderFeed() {
  const u = S.ui;
  const sel = byId('fd-cat');
  fillSelect(sel, [['', '全部 All'], ...CATS.map((c) => [c, CAT_LABEL[c]]), ['spawn-ev', '派生事件'], ['error-ev', '错误事件']], u.feedCat);
  if (byId('fd-q').value !== u.feedQ) byId('fd-q').value = u.feedQ;
  for (const b of $$('#fd-kinds .kfilter')) b.setAttribute('aria-pressed', String(u.feedKinds.has(b.dataset.kind)));
  byId('fd-err').checked = u.feedErr;
  const src = u.feedPaused && u.feedFrozen ? u.feedFrozen : S.feed;
  const terms = u.feedQ.toLowerCase().split(/\s+/).filter(Boolean), t = now();
  const out = [];
  for (const it of src) {
    const e = it.event;
    if (e.type !== 'tool' && e.type !== 'spawn' && e.type !== 'error') continue;
    const a = S.agents.get(it.agent);
    if (u.feedKinds.size && !(a && u.feedKinds.has(a.kind))) continue;
    if (u.feedErr && !(e.type === 'error' || e.status === 'error')) continue;
    if (u.feedCat) { if (u.feedCat === 'error-ev' ? e.type !== 'error' : u.feedCat === 'spawn-ev' ? e.type !== 'spawn' : e.category !== u.feedCat) continue; }
    if (terms.length) {
      const hay = [e.name, e.preview, e.text, a && agentTitle(a), a && a.host, a && a.site, a && a.kind, ...(e.targets || []).map(tlTargetText)].filter(Boolean).join(' ').toLowerCase();
      let ok = true;
      for (const term of terms) if (!hay.includes(term)) { ok = false; break; }
      if (!ok) continue;
    }
    out.push(it);
    if (out.length >= 400) break;
  }
  const firstPaint = feedSeen === null;
  const nextSeen = new Set();
  const items = out.map((it) => {
    const e = it.event, a = S.agents.get(it.agent), id = it.agent + '|' + e.id, err = e.type === 'error' || e.status === 'error';
    nextSeen.add(id);
    const fresh = !firstPaint && !feedSeen.has(id);
    const sig = [e.status, e.duration, e.preview, e.exitCode, a && a._v, u.key === it.agent && u.ev === e.id ? 1 : 0].join('|');
    return {
      key: id, sig, cls: 'frow' + (e.status === 'pending' ? ' pending' : '') + (err ? ' err' : '') + (fresh ? ' fresh-in' : '') + (u.key === it.agent && u.ev === e.id ? ' sel' : ''),
      attrs: { 'data-feed': id, role: 'button', tabindex: '0' },
      html: () => {
        const tg = (e.targets || []).filter((x) => x.type !== 'agent' || true);
        const host = a ? a.host : '';
        return `<span class="tm" title="${esc(fmtDateTime(e.t))}">${fmtClock(e.t)}</span><span class="ag">${a ? agentChip(it.agent, 20) : `<span class="chip mono">${esc(clip(it.agent, 22))}</span>`}</span>
          <span class="lc" title="${esc(a ? a.site : '')}">${host ? `<span class="chip" title="${esc(host)}">${ico(host.startsWith('k8s/') ? 'pod' : 'host', 'sm')}${esc(clip(hostLabel(host), 16))}</span>` : ''}</span>
          <span class="ca">${catIcon(e)}<span class="cat cat-${esc(e.category || 'other')}${err ? ' ev-error' : ''}">${esc(clip(e.name || e.type, 12))}</span></span>
          <span class="pv" title="${esc(e.preview || e.text || '')}">${esc(clip(e.preview || e.text || '', 200))}${e.duration != null ? ` <span class="muted">${fmtDur(e.duration)}</span>` : ''}</span>
          <span class="tg">${tg.slice(0, 3).map(targetChip).join('')}${tg.length > 3 ? `<span class="chip">+${tg.length - 3}</span>` : ''}</span>`;
      },
    };
  });
  reconcile(byId('feed-list'), items);
  feedSeen = nextSeen;
  const pausedNew = u.feedPaused && u.feedFrozen ? S.feed.length - u.feedFrozen.length : 0;
  setText(byId('fd-count'), `${out.length} 条${pausedNew > 0 ? ` · 暂停中，有新事件 ${pausedNew}+` : ''}`);
  const pb = byId('fd-pause');
  pb.setAttribute('aria-pressed', String(u.feedPaused));
  pb.querySelector('span').textContent = u.feedPaused ? '继续 Resume' : '暂停 Pause';
  pb.querySelector('use').setAttribute('href', u.feedPaused ? '#i-play' : '#i-pause');
  void t;
}

/* ───────────────────────── 6. events, ticker, boot ───────────────────────── */

const drawerKey = () => (S.ui.drawer && S.ui.drawer.type === 'agent' ? S.ui.drawer.key : '');
function toggleRow(rowKey) {
  const el = document.querySelector(`[data-row="${CSS.escape(rowKey)}"]`);
  S.ui.exp.set(rowKey, !(el && el.getAttribute('aria-expanded') === 'true'));
  S.ui.focusRow = rowKey;
  scheduleRender('all');
}
/** Opens every ancestor row of `key` in the Fleet tree (rows are keyed by their path: host/root>child>…). */
function expandChain(key) {
  const u = S.ui, g = getGraph(), chain = [key];
  for (let c = key; g.parent.has(c) && chain.length < 100;) { c = g.parent.get(c).from; chain.unshift(c); }
  const root = S.agents.get(chain[0]);
  if (!root) return;
  let rk = 'H:' + root.host + '/' + root.key;
  u.exp.set('S:' + root.site, true); u.exp.set('H:' + root.host, true);
  for (let i = 1; i < chain.length; i++) { u.exp.set(rk, true); rk += '>' + chain[i]; }
}
/** Make a session visible in the Fleet tree: clear conflicting filters, open its ancestors, scroll to it. */
function revealInFleet(key) {
  const u = S.ui, a = S.agents.get(key);
  if (!a) return;
  u.q = ''; u.kinds = new Set(); u.site = '';
  if (u.status !== 'all' && !(isActive(a) || now() - (a.updatedAt || 0) < RECENT_MS)) u.status = 'all';
  if (a.role === 'projection') u.proj = true;
  expandChain(key);
  u.key = key; u.drawer = { type: 'agent', key }; u.ev = '';
  S.scrollToKey = key;
  syncControls();
  setView('fleet');
}
function openAgent(key, { ev = '' } = {}) {
  const u = S.ui;
  u.drawer = { type: 'agent', key }; u.ev = ev; u.focus = '';
  if (u.view !== 'timeline') u.key = key;
  if (ev) S.scrollEv = ev;
  writeHash(true);
  scheduleRender('all');
}

function handleAct(el) {
  const u = S.ui, v = el.dataset.v;
  switch (el.dataset.act) {
    case 'retry': clearTimeout(net.retry); connect(); break;
    case 'close-drawer': closeDrawer(); break;
    case 'ev-close': u.ev = ''; scheduleRender('all'); break;
    case 'ev-filter': u.evFilter = v; u.evShow = 120; scheduleRender('all'); break;
    case 'ev-more': u.evShow += 120; scheduleRender('all'); break;
    case 'ev-older': { const k = drawerKey(); if (k) { loadOlder(k).catch(() => {}); scheduleRender('all'); } break; }
    case 'copy': copyText(v, el); break;
    case 'show-fleet': revealInFleet(v); break;
    case 'file-retry': if (u.file) { loadFilePreview(u.file, true); scheduleRender('file'); } break;
    case 'tl-clear': u.key = ''; TL.model = null; writeHash(false); scheduleRender('all'); break;
    default: break;
  }
}

function initEvents() {
  const tabs = byId('tabs');
  tabs.addEventListener('click', (ev) => { const b = ev.target.closest('[data-view]'); if (b) setView(b.dataset.view, true, true); });
  tabs.addEventListener('keydown', (ev) => {
    const i = VIEWS.indexOf(S.ui.view);
    const n = ev.key === 'ArrowRight' ? (i + 1) % VIEWS.length : ev.key === 'ArrowLeft' ? (i + VIEWS.length - 1) % VIEWS.length : ev.key === 'Home' ? 0 : ev.key === 'End' ? VIEWS.length - 1 : -1;
    if (n < 0) return;
    ev.preventDefault(); setView(VIEWS[n], true, true); byId('tab-' + VIEWS[n]).focus();
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const goEl = t.closest('[data-go]');
    if (goEl) { ev.preventDefault(); go(goEl.dataset.go); return; }
    const act = t.closest('[data-act]');
    if (act) { handleAct(act); return; }
    const tog = t.closest('[data-toggle]');
    if (tog) { toggleRow(tog.dataset.toggle); return; }
    const hdr = t.closest('.row.hdr[data-row]');
    if (hdr) { toggleRow(hdr.dataset.row); return; }
    const sel = t.closest('[data-sel]');
    if (sel) { S.ui.focusRow = sel.dataset.row; openAgent(sel.dataset.sel); return; }
    const card = t.closest('.card[data-site]');
    if (card) { S.ui.site = S.ui.site === card.dataset.site ? '' : card.dataset.site; syncControls(); writeHash(false); scheduleRender('all'); return; }
    const pod = t.closest('tr[data-pod]');
    if (pod) { openPod(pod.dataset.pod); writeHash(true); scheduleRender('all'); return; }
    const file = t.closest('tr[data-file]');
    if (file) { S.ui.file = file.dataset.file; S.ui.fileEvent = ''; writeHash(true); scheduleRender('all'); return; }
    const fev = t.closest('[data-fev]');
    if (fev) { S.ui.fileEvent = S.ui.fileEvent === fev.dataset.fev ? '' : fev.dataset.fev; scheduleRender('file'); return; }
    const feed = t.closest('.frow[data-feed]');
    if (feed) { const id = feed.dataset.feed, i = id.indexOf('|'); openAgent(id.slice(0, i), { ev: id.slice(i + 1) }); return; }
    const er = t.closest('.erow[data-ev]');
    if (er) { S.ui.ev = S.ui.ev === er.dataset.ev ? '' : er.dataset.ev; scheduleRender('all'); }
  });
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (ev.key === 'Escape' && S.ui.drawer && !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) { closeDrawer(); return; }
    if ((ev.key === 'Enter' || ev.key === ' ') && t.matches('[role=button],[role=treeitem],tr[data-pod],tr[data-file],.card') && !t.matches('button')) { ev.preventDefault(); t.click(); }
  });
  // tree keyboard model: up/down move, right expands, left collapses / jumps to parent, enter selects
  byId('fleet-tree').addEventListener('keydown', (ev) => {
    const row = ev.target.closest && ev.target.closest('[role=treeitem]');
    if (!row || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    const rows = $$('[role=treeitem]', byId('fleet-tree')), i = rows.indexOf(row);
    const focus = (r) => { if (!r) return; row.tabIndex = -1; r.tabIndex = 0; r.focus(); S.ui.focusRow = r.dataset.row; };
    if (ev.key === 'ArrowDown') focus(rows[i + 1]);
    else if (ev.key === 'ArrowUp') focus(rows[i - 1]);
    else if (ev.key === 'Home') focus(rows[0]);
    else if (ev.key === 'End') focus(rows[rows.length - 1]);
    else if (ev.key === 'ArrowRight') { if (row.getAttribute('aria-expanded') === 'false') toggleRow(row.dataset.row); else focus(rows[i + 1]); }
    else if (row.getAttribute('aria-expanded') === 'true') toggleRow(row.dataset.row);
    else { const lvl = Number(row.getAttribute('aria-level')); for (let j = i - 1; j >= 0; j--) if (Number(rows[j].getAttribute('aria-level')) < lvl) { focus(rows[j]); break; } }
  });
  byId('fleet-tree').addEventListener('focusin', (ev) => { const r = ev.target.closest && ev.target.closest('[data-row]'); if (r) S.ui.focusRow = r.dataset.row; });

  // fleet filters
  const u = S.ui;
  const kindToggle = (group, set) => group.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-kind]');
    if (!b) return;
    if (set().has(b.dataset.kind)) set().delete(b.dataset.kind); else set().add(b.dataset.kind);
    syncControls(); writeHash(false); scheduleRender('all');
  });
  kindToggle(byId('f-kinds'), () => u.kinds);
  kindToggle(byId('fd-kinds'), () => u.feedKinds);
  byId('f-q').addEventListener('input', (ev) => { u.q = ev.target.value; writeHash(false); scheduleRender('all'); });
  byId('f-status').addEventListener('change', (ev) => { u.status = ev.target.value; scheduleRender('all'); });
  byId('f-site').addEventListener('change', (ev) => { u.site = ev.target.value; writeHash(false); scheduleRender('all'); });
  byId('f-proj').addEventListener('change', (ev) => { u.proj = ev.target.checked; TL.model = null; scheduleRender('all'); });
  byId('f-expand').addEventListener('click', () => { u.exp.clear(); u.expandMode = 'all'; scheduleRender('all'); });
  byId('f-collapse').addEventListener('click', () => { u.exp.clear(); u.expandMode = 'none'; scheduleRender('all'); });
  // pods
  byId('p-site').addEventListener('change', (ev) => { u.podSite = ev.target.value; scheduleRender('all'); });
  byId('p-phase').addEventListener('change', (ev) => { u.podPhase = ev.target.value; scheduleRender('all'); });
  byId('p-touched').addEventListener('change', (ev) => { u.podTouched = ev.target.checked; scheduleRender('all'); });
  byId('p-q').addEventListener('input', (ev) => { u.podQ = ev.target.value; scheduleRender('all'); });
  byId('p-refresh').addEventListener('click', async () => {
    try { const r = await api('pods'); for (const p of (r && r.pods) || r || []) S.pods.set(p.key, stamp(p)); S.ver.pods++; } catch (e) { console.warn('api/pods failed', e); }
    loadTouchIndex('pod', true); scheduleRender('all');
  });
  // files
  byId('fl-host').addEventListener('change', (ev) => { u.fileHost = ev.target.value; scheduleRender('all'); });
  byId('fl-agent').addEventListener('change', (ev) => { u.fileAgent = ev.target.value; scheduleRender('all'); });
  byId('fl-q').addEventListener('input', (ev) => { u.fileQ = ev.target.value; scheduleRender('all'); });
  byId('fl-ops').addEventListener('click', (ev) => { const b = ev.target.closest('[data-op]'); if (!b) return; if (u.fileOps.has(b.dataset.op)) u.fileOps.delete(b.dataset.op); else u.fileOps.add(b.dataset.op); scheduleRender('all'); });
  // feed
  byId('fd-q').addEventListener('input', (ev) => { u.feedQ = ev.target.value; scheduleRender('all'); });
  byId('fd-cat').addEventListener('change', (ev) => { u.feedCat = ev.target.value; scheduleRender('all'); });
  byId('fd-err').addEventListener('change', (ev) => { u.feedErr = ev.target.checked; scheduleRender('all'); });
  byId('fd-pause').addEventListener('click', () => { u.feedPaused = !u.feedPaused; u.feedFrozen = u.feedPaused ? S.feed.slice() : null; scheduleRender('all'); });

  const norm = (h) => buildHash(parseHash(h));
  window.addEventListener('hashchange', () => {
    const h = parseHash(location.hash);
    if (h.token || h.nonce) {                               // a new credential: off the address bar first, then reconnect with it
      applyHash(h); S.hashSelf = null; writeHash(false); scheduleRender('all');
      adoptCredential(h).then(connect);
      return;
    }
    if (location.hash === S.hashSelf || (S.hashSelf && norm(location.hash) === norm(S.hashSelf))) return;
    applyHash(h); scheduleRender('all');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender('all'); });
  window.addEventListener('resize', hideTip);
}

/**
 * The credential a URL fragment carries stays in this page's memory and goes out as the `x-agent-fleet-token`
 * header. It is never written to sessionStorage/localStorage (a same-origin script could read it there) or back into
 * a URL; the caller scrubs the address bar.
 *   #token=…  manual entry: used as is, and exchanged for the hub's HttpOnly cookie so a reload survives.
 *   #nonce=…  the DSH plugin's panel URL: redeemed once (`POST api/session`) for a panel session key.
 * The header is what works in the desktop app, which embeds the loopback hub in an iframe of its dsh-app:// page: the
 * browser keeps the SameSite cookie out of that third-party frame. A spent or expired nonce leaves the page on the
 * cookie, which still serves a same-site reload.
 */
async function adoptCredential(h) {
  if (h.token) {
    S.token = h.token;
    postCredential('session-nonce', { 'x-agent-fleet-token': h.token });   // only its Set-Cookie matters
    return;
  }
  const res = await postCredential('session', { 'x-agent-fleet-nonce': h.nonce });
  const body = res && res.ok ? await res.json().catch(() => null) : null;
  if (body && typeof body.session === 'string' && body.session !== '') S.token = body.session;
}
/** Body-less POST to one of the hub's credential routes; null when the hub cannot be reached. */
function postCredential(route, headers) {
  return fetch(`${API_BASE}api/${route}`, { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
}
async function boot() {
  const h = parseHash(location.hash);
  S.token = '';                                             // memory only: never sessionStorage/localStorage
  const qs = new URLSearchParams(location.search);
  initTimeline(); initEvents();
  if (qs.get('demo')) {
    try { S.demo = await createDemo(qs); } catch (e) { S.conn = { state: 'down', error: 'demo fixture: ' + e.message, retryAt: Date.now() + 1e9 }; }
    window.__fleet = { S, TL, demo: S.demo, draw: tlDraw };       // review / test hook, only present in ?demo=1
  }
  applyHash(h);
  const credential = Boolean(h.token || h.nonce);
  if (credential) { S.hashSelf = null; writeHash(false); }  // never leave a credential in the address bar
  syncControls();
  renderConn();
  setInterval(() => { if (S.loaded) scheduleRender('tick'); else renderTop(); }, 1000);
  setInterval(() => { if (S.conn.state === 'down') renderConn(); }, 1000);
  if (credential && !S.demo) await adoptCredential(h);
  if (S.demo || S.conn.state !== 'down') connect();
}

/* ───────────────────────── 7. demo hub (?demo=1) ───────────────────────── */

// Serves fixtures/demo.json through the same api() surface as the hub and simulates deltas (new tool calls, tools
// finishing, subagents spawning and returning) so every view can be reviewed without a running hub.
const DEMO_TIME_KEYS = new Set(['t', 'startedAt', 'updatedAt', 'endedAt', 'since', 'createdAt', 'connectedAt', 'lastSeen', 'now', 'mtime', 'firstSeen', 'deletedAt', 'at']);
function demoRebase(v, d) {
  if (Array.isArray(v)) { for (const x of v) demoRebase(x, d); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { const x = v[k]; if (typeof x === 'number' && DEMO_TIME_KEYS.has(k)) v[k] = x + d; else demoRebase(x, d); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createDemo(qs) {
  const res = await fetch('fixtures/demo.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`fixtures/demo.json → HTTP ${res.status}`);
  const fx = await res.json();
  demoRebase(fx, Date.now() - fx.meta.now);
  const st = {
    cursor: fx.snapshot.cursor, hub: fx.snapshot.hub,
    agents: new Map(fx.snapshot.agents.map((a) => [a.key, a])), hosts: new Map(fx.snapshot.hosts.map((h) => [h.id, h])),
    links: fx.snapshot.links, pods: new Map(fx.snapshot.pods.map((p) => [p.key, p])), events: fx.events, files: fx.files, podEvents: fx.podEvents,
    pending: new Map(), kids: [], subs: new Set(), seq: 0, step: 0,
  };
  const speed = Math.max(0.2, Number(qs.get('speed')) || 1);
  const rnd = (a, b) => a + Math.random() * (b - a), pick = (l) => l[Math.floor(Math.random() * l.length)];
  const evsOf = (key) => st.events[key] || (st.events[key] = []);
  for (const [key, list] of Object.entries(st.events)) for (const e of list) if (e.status === 'pending' && st.agents.get(key) && st.agents.get(key).status === 'running') st.pending.set(key, { e, doneAt: Date.now() + rnd(2500, 12000) / speed });

  const subtreeOf = (root) => {
    const kids = new Map();
    for (const l of st.links) { let c = kids.get(l.from); if (!c) kids.set(l.from, (c = [])); c.push(l.to); }
    const out = [], stack = [root], seen = new Set();
    while (stack.length) { const k = stack.pop(); if (seen.has(k) || !st.agents.has(k)) continue; seen.add(k); out.push(k); for (const c of kids.get(k) || []) stack.push(c); }
    return out;
  };
  const rootOfKey = (key) => { let cur = key; for (let n = 0; n < 50; n++) { const l = st.links.find((x) => x.to === cur); if (!l) break; cur = l.from; } return cur; };
  const feedNow = () => {
    const all = [];
    for (const [agent, list] of Object.entries(st.events)) for (const e of list) if (e.type === 'tool' || e.type === 'spawn' || e.type === 'error') all.push({ agent, event: e });
    all.sort((a, b) => a.event.t - b.event.t);
    return all.slice(-300);
  };
  const touchedPod = (e, key) => (e.targets || []).some((t) => t.type === 'pod' && podKeyOfTarget(t) === key);

  const impl = {
    snapshot: () => ({ cursor: st.cursor, now: Date.now(), hub: st.hub, hosts: [...st.hosts.values()], agents: [...st.agents.values()], links: st.links, pods: [...st.pods.values()], feed: feedNow(), sources: { chengdu: { status: 'online' }, weihai: { status: 'online' }, iron: { status: 'online' }, os: { status: 'online' } } }),
    changes: () => ({ cursor: st.cursor, now: Date.now() }),
    hosts: () => ({ hosts: [...st.hosts.values()] }),
    pods: () => ({ pods: [...st.pods.values()] }),
    family: ({ key }) => {
      const root = rootOfKey(key), keys = subtreeOf(root), events = {};
      for (const k of keys) events[k] = evsOf(k).slice(-400);
      const set = new Set(keys);
      return { root, agents: keys.map((k) => st.agents.get(k)), links: st.links.filter((l) => set.has(l.from) && set.has(l.to)), events };
    },
    agent: ({ key, before, limit }) => {
      const list = evsOf(key), lim = Math.min(Number(limit) || 200, 1000);
      const end = before ? list.findIndex((e) => e.t >= Number(before)) : list.length;
      const stop = end < 0 ? list.length : end, start = Math.max(0, stop - lim);
      return { key, events: list.slice(start, stop), hasMore: start > 0 };
    },
    pod: ({ key }) => {
      const touches = [];
      for (const [agent, list] of Object.entries(st.events)) for (const e of list) if (touchedPod(e, key)) { const tg = e.targets.find((t) => t.type === 'pod' && podKeyOfTarget(t) === key); touches.push({ agent, event: e.id, t: e.t, op: tg.op, category: e.category, name: e.name, preview: e.preview }); }
      touches.sort((a, b) => b.t - a.t);
      return { pod: st.pods.get(key) || null, touches: touches.slice(0, 200), events: (st.podEvents[key] || []).slice().sort((a, b) => b.lastSeen - a.lastSeen) };
    },
    file: ({ host, path }) => st.files[`${host}:${path}`] || { host, path, exists: false },
    query: (p) => {
      const items = [], lim = Math.min(Number(p.limit) || 200, 3000), cats = p.category ? String(p.category).split(',') : null;
      const needle = (p.text || '').toLowerCase();
      for (const [agent, list] of Object.entries(st.events)) {
        const a = st.agents.get(agent);
        if (!a || (p.kind && a.kind !== p.kind) || (p.site && a.site !== p.site) || (p.host && a.host !== p.host)) continue;
        for (const e of list) {
          if (e.type !== 'tool' && e.type !== 'spawn') continue;
          if (p.since && e.t < Number(p.since)) continue;
          if (cats && !cats.includes(e.category)) continue;
          if (p.target && !(e.targets || []).some((t) => t.type === p.target)) continue;
          if (needle && !((e.preview || '') + ' ' + (e.name || '')).toLowerCase().includes(needle)) continue;
          items.push({ agent, event: e });
        }
      }
      items.sort((a, b) => b.event.t - a.event.t);
      return { items: items.slice(0, lim), total: items.length };
    },
  };

  // ── simulation ──
  const filesByHost = new Map(), podTargets = [];
  for (const [agent, list] of Object.entries(st.events)) {
    const a = st.agents.get(agent);
    for (const e of list) for (const t of e.targets || []) {
      if (t.type === 'file' && t.host) { let l = filesByHost.get(t.host); if (!l) filesByHost.set(t.host, (l = [])); if (!l.includes(t.path)) l.push(t.path); }
      if (t.type === 'pod' && a && !podTargets.some((p) => p.name === t.name)) podTargets.push(t);
    }
  }
  const CMDS = ['node --test tests/hub.test.mjs', 'git status --short', 'rg -n "TODO|FIXME" lib', 'npm run build:collector', 'python3 eval.py --ckpt step_12000 --limit 64', 'tail -n 40 train.log', 'curl -s 127.0.0.1:7840/api/health'];
  const TOOLS = {
    omp: [['read', 'read', 'file'], ['edit', 'edit', 'file'], ['grep', 'search', 'file'], ['bash', 'shell'], ['bash', 'k8s', 'pod']],
    claude: [['Read', 'read', 'file'], ['Edit', 'edit', 'file'], ['Grep', 'search', 'file'], ['Bash', 'shell'], ['Bash', 'k8s', 'pod']],
    codex: [['read_file', 'read', 'file'], ['apply_patch', 'edit', 'file'], ['shell', 'shell'], ['shell', 'k8s', 'pod']],
    dsh: [['Read', 'read', 'file'], ['Edit', 'edit', 'file'], ['Bash', 'shell']],
  };
  const newTool = (a) => {
    const [name, category, tg] = pick(TOOLS[a.kind] || TOOLS.omp);
    const e = { id: `toolu_sim${++st.seq}`, type: 'tool', t: Date.now(), status: 'pending', name, category };
    if (tg === 'file') {
      const paths = filesByHost.get(a.host) || [...filesByHost.values()][0] || ['/tmp/demo.txt'], path = pick(paths), op = category === 'edit' ? 'edit' : category === 'search' ? 'search' : 'read';
      e.targets = [{ type: 'file', op, host: a.host, path }];
      e.preview = category === 'edit' ? `edit ${path} (+${Math.round(rnd(2, 40))} −${Math.round(rnd(0, 12))})` : category === 'search' ? `grep -rn "${pick(['TODO', 'cursor', 'pending', 'snapshot'])}" ${dirName(path)}` : `read ${path}`;
    } else if (tg === 'pod' && podTargets.length) {
      const p = pick(podTargets), op = pick(['logs', 'get', 'exec', 'describe']);
      e.targets = [{ ...p, op }];
      e.preview = `kubectl --context ${p.cluster || 'ulanqab-osmium'} -n ${p.namespace || NAMESPACE} ${op}${op === 'get' ? ' pod' : op === 'exec' ? '' : ''} ${p.name}${op === 'logs' ? ' --tail=80' : op === 'exec' ? ' -- nvidia-smi -L' : ''}`;
    } else { e.category = 'shell'; e.preview = pick(CMDS); }
    return e;
  };
  const durOf = () => rnd(1800, 11000) / speed;

  function simulate() {
    const t = Date.now(), changed = new Map(), feed = [];
    st.step++;
    for (const [key, a] of st.agents) {
      if (a.status !== 'running') continue;
      const pend = st.pending.get(key);
      if (pend && t >= pend.doneAt) {
        const e = pend.e, err = Math.random() < 0.09;
        e.status = err ? 'error' : 'ok'; e.duration = Math.max(200, Math.round(t - e.t)); if (err) e.exitCode = 1;
        st.pending.delete(key);
        a.live = { ...a.live, state: 'model', doing: 'thinking', since: t };
        a.updatedAt = t;
        if (err) a.counts.errors++;
        changed.set(key, a); feed.push({ agent: key, event: clone(e) });
      } else if (!pend && a.live && a.live.state !== 'tool' && t - (a.live.since || 0) > rnd(1500, 4500) / speed) {
        const e = newTool(a), list = evsOf(key);
        const think = Math.max(300, Math.round(t - a.live.since));
        list.push({ id: `model:sim${++st.seq}`, type: 'model', t: a.live.since, duration: think, ttft: Math.round(think * 0.2), model: a.model, usage: { input: Math.round(rnd(2000, 9000)), output: Math.round(rnd(60, 900)) } });
        list.push(e);
        st.pending.set(key, { e, doneAt: t + durOf() });
        a.live = { ...a.live, state: 'tool', doing: e.preview, since: t };
        a.updatedAt = t; a.counts.tools++; a.counts.events += 2;
        a.usage = { ...a.usage, input: (a.usage.input || 0) + Math.round(rnd(1500, 8000)), output: (a.usage.output || 0) + Math.round(rnd(40, 700)), cacheRead: (a.usage.cacheRead || 0) + Math.round(rnd(8000, 60000)) };
        changed.set(key, a); feed.push({ agent: key, event: clone(e) });
      }
    }
    // a subagent of the server OMP session spawns, works and returns
    const parent = [...st.agents.values()].find((a) => a.kind === 'omp' && a.status === 'running' && a.role === 'main' && a.host === 'server-bochao-01');
    if (parent && st.step % 24 === 5 && st.kids.length < 2) {
      const id = `sim-${++st.seq}`, key = `${parent.host}#omp:${id}`, callId = `toolu_task${st.seq}`;
      const child = { ...clone(parent), key, id, file: `${dirName(parent.file)}${id}.jsonl`, role: 'subagent', name: pick(['verify-edge', 'lint-sweep', 'trace-links']), title: '', description: 'simulated subagent', parent: { key: parent.key, kind: 'omp', id: parent.id, via: 'file', exact: true, toolCallId: callId }, startedAt: t, updatedAt: t, endedAt: null, status: 'running', counts: { turns: 1, tools: 0, errors: 0, subagents: 0, events: 1 }, usage: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, live: { alive: true, state: 'model', since: t, doing: 'thinking', turnOpen: true } };
      delete child.acp;
      st.agents.set(key, child); st.events[key] = [{ id: 'user:1', type: 'user', t, text: 'sub-task from parent' }];
      const sp = { id: callId, type: 'spawn', t, status: 'pending', name: 'task', category: 'spawn', preview: `task ${child.name}`, child: { kind: 'omp', id, name: child.name, key } };
      evsOf(parent.key).push(sp);
      st.links = [...st.links, { from: parent.key, to: key, via: 'file', exact: true, toolCallId: callId, crossHost: false, crossSite: false }];
      parent.counts.subagents++; parent.counts.events++;
      st.kids.push({ key, parent: parent.key, spawn: sp, doneAt: t + 22000 / speed });
      changed.set(key, child); changed.set(parent.key, parent); feed.push({ agent: parent.key, event: clone(sp) });
      st.newLinks = true;
    }
    for (const k of st.kids.slice()) if (t >= k.doneAt) {
      const c = st.agents.get(k.key);
      c.status = 'done'; c.endedAt = t; c.updatedAt = t; c.live = { alive: false, state: 'ended', since: t, doing: '', turnOpen: false };
      k.spawn.status = 'ok'; k.spawn.duration = t - k.spawn.t;
      st.pending.delete(k.key); st.kids.splice(st.kids.indexOf(k), 1);
      changed.set(k.key, c); feed.push({ agent: k.parent, event: clone(k.spawn) });
    }
    const d = { cursor: ++st.cursor, now: t };
    if (changed.size) d.agents = [...changed.values()].map(clone);
    if (feed.length) d.feed = feed;
    if (st.newLinks) { d.links = clone(st.links); st.newLinks = false; }
    if (st.step % 5 === 0) {
      const hs = [];
      for (const h of st.hosts.values()) if (h.status === 'online') { h.lagMs = Math.max(2, Math.round((h.lagMs || 100) * rnd(0.7, 1.3))); h.lastSeen = t; hs.push(h); }
      d.hosts = hs.map(clone);
    }
    for (const s of st.subs) s.cb(d);
  }

  setInterval(simulate, 1100);
  const hub = {
    online: true,
    async api(name, params) {
      await sleep(25 + Math.random() * 90);
      if (!hub.online) throw new ApiError(0, 'demo hub offline');
      if (!impl[name]) throw new ApiError(404, `unknown api ${name}`);
      return clone(impl[name](params || {}));
    },
    /** Like an SSE stream: deltas to `cb`, `onError` when the "connection" drops. Returns an unsubscribe function (null when offline). */
    subscribe(cb, onError) {
      if (!hub.online) { setTimeout(onError, 0); return null; }
      const sub = { cb, onError };
      st.subs.add(sub);
      return () => st.subs.delete(sub);
    },
    /** Review aid: setOnline(false) drops the stream and fails every api call until setOnline(true). */
    setOnline(on) {
      hub.online = !!on;
      if (!on) for (const s of [...st.subs]) { st.subs.delete(s); s.onError(); }
    },
    state: st,
  };
  return hub;
}

boot();
})();
