// 你的待办和目标（对齐页数据 api 17，2026-11-02 从 personal-ops 迁来的第 1 轮：数据和命令）。
// 只在进程内调 align.mjs（ALIGN_STORE / ALIGN_WORKSPACES 指向临时目录，会话经替身 dsh-threads），不连 3080、不碰 first-mate 页。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mine-'));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, 'workspace.json');
process.env.ALIGN_THREADS_CLI = fileURLToPath(new URL('./fixtures/fake-threads.mjs', import.meta.url));
const A = await import('../cli/align.mjs');
A.probes.pauseApi = async () => true;
let probed = 0;
A.probes.mineApi = async () => { probed++; };
const run = (...argv) => A.main(argv);
const at = (d, h = '10') => '2026-11-' + d + 'T' + h + ':00:00+08:00';
const setNow = (d, h) => { process.env.ALIGN_NOW = at(d, h); };

const alpha = path.join(dir, 'alpha');
fs.mkdirSync(alpha, { recursive: true });
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ tables: { workspaces: { 'ws-a': { path: alpha, title: 'Alpha', sessionIds: [] } } } }));
const S = (n) => 'session-712ba360-0000-4000-8000-' + String(n).padStart(12, '0');
const E = ['eta=40m', 'eta75=1h', 'etaconf=中'];
const read = (f) => A.parsePage(fs.readFileSync(f, 'utf8'));
// 页面里的数据块（模板脚本本身也有 todos 字样，只看数据）
const block = (f) => fs.readFileSync(f, 'utf8').match(/id="align-data">\r?\n([\s\S]*?)\r?\n<\/script>/)[1];
const rejects = async (f, argv, re) => {
  const snap = fs.readFileSync(f, 'utf8');
  await assert.rejects(A.main(argv), (e) => e instanceof A.UsageError && (!re || re.test(e.message)), argv.join(' '));
  assert.equal(fs.readFileSync(f, 'utf8'), snap, '出错不改文件: ' + argv.join(' '));
};
async function page(name) {
  const f = path.join(dir, name + '.html');
  await run('init', f, '--name', name, '--title', name, '--owner', S(99), '--version', '3');
  await run('project', 'add', name, '--ws', 'ws-a');
  await run('round', 'add', name, 'r1', '--mode', 'new', '--proj', 'Alpha', 'title=第一轮', 'sid=' + S(1), 'why=新任务', '--no-check-sid', ...E);
  return f;
}
const todoId = (out) => out.match(/todo\/(t-[a-z0-9-]+)/)[1];
const goalId = (out) => out.match(/goal\/(g-[a-z0-9-]+)/)[1];

test('没有待办和目标的旧页面：写入后不出现 todos / goals 字段，和以前一样读写；第一次写待办前探测 3080，探测不过就不写', async () => {
  setNow('02');
  const f = await page('m1');
  assert.doesNotMatch(block(f), /"todos"|"goals"/);
  assert.match(await run('note', 'add', 'm1', 'n1', 'title=须知'), /加了 note\/n1/);
  assert.doesNotMatch(block(f), /"todos"|"goals"/);
  assert.equal(A.legacyView(read(f)).version, 2);
  // 探测报错（3080 还是 api 16）→ 拒写，页面不变
  const keep = A.probes.mineApi;
  A.probes.mineApi = async () => { throw new A.UsageError('3080 报 api=16：还是旧插件'); };
  try {
    await rejects(f, ['todo', 'add', 'm1', 'title=找 Tianyi'], /api=16/);
    await rejects(f, ['goal', 'add', 'm1', 'title=旁白上线'], /api=16/);
  } finally { A.probes.mineApi = keep; }
  // 探测通过才写；页面上已有待办后不再探测
  probed = 0;
  await run('todo', 'add', 'm1', 'title=找 Tianyi');
  assert.equal(probed, 1);
  await run('todo', 'add', 'm1', 'title=试 Codex 语音');
  assert.equal(probed, 1);
  const d = read(f);
  assert.equal(d.todos.length, 2);
  // 待办不进决定数 / 卡数 / 手机旧格式
  assert.equal(A.cardCount(d), 0);
  assert.ok(!A.legacyView(d).items.some((x) => /Tianyi/.test(x.title)));
  assert.equal(A.listPages().find((p) => p.name === 'm1').open, 0);
});

test('todo add / set / done / ls：字段校验、分组、已过几天、在做排前', async () => {
  setNow('02');
  const f = await page('m2');
  const g = goalId(await run('goal', 'add', 'm2', 'title=旁白 11 月上线测试机', 'range=季度', 'due=2026-11-30'));
  const a = todoId(await run('todo', 'add', 'm2', 'title=找 Tianyi 续期', 'p=P0', 'urg=紧急', 'energy=低', 'eta=10m', 'due=2026-10-28', 'goal=' + g, '--today'));
  const b = todoId(await run('todo', 'add', 'm2', 'title=寅子数据集管线', 'p=P0', 'urg=正常', 'energy=中', 'eta=2h', 'due=2026-10-27'));
  await run('todo', 'set', 'm2', b, 'status=doing');
  await run('todo', 'today', 'm2', b);
  const c = todoId(await run('todo', 'add', 'm2', 'title=试 Codex 语音', 'p=P1', 'urg=正常', 'energy=低', 'eta=15m', 'why=看还晕不晕'));
  const t = read(f).todos.find((x) => x.id === a);
  assert.deepEqual([t.status, t.src, t.p, t.urg, t.energy, t.eta, t.due, t.goal, t.today], ['open', 'First Mate', 'P0', '紧急', '低', '10m', '2026-10-28', [g], '2026-11-02']);
  assert.deepEqual(t.log.map((e) => e.ev), ['add', 'today']);
  const ls = (await run('todo', 'ls', 'm2')).split('\n');
  assert.equal(ls.length, 3);
  assert.match(ls[0], new RegExp('^todo/' + b + ' \\[今天\\] \\[在做 P0 · 正常 中能量 2h 截止 10-27 已过 6 天\\] 寅子'));
  assert.match(ls[1], /\[今天\] \[P0 · 紧急 低能量 10m 截止 10-28 已过 5 天\] 找 Tianyi 续期 · 目标「旁白 11 月上线测试机」/);
  assert.match(ls[2], new RegExp('^todo/' + c + ' \\[以后\\] \\[P1 · 正常 低能量 15m\\]'));
  assert.match(await run('todo', 'ls', 'm2', '--goal', g), new RegExp('^todo/' + a + ' '));
  // 校验：枚举、时长、日期、不存在的目标、不认识的字段、状态
  await rejects(f, ['todo', 'add', 'm2', 'title=x', 'p=P5'], /p 只能是 P0 \| P1 \| P2 \| P3/);
  await rejects(f, ['todo', 'add', 'm2', 'title=x', 'eta=10分钟'], /eta 要写成时长/);
  await rejects(f, ['todo', 'add', 'm2', 'title=x', 'due=2026-02-30'], /due 要写成 YYYY-MM-DD/);
  await rejects(f, ['todo', 'add', 'm2', 'title=x', 'goal=g-nope'], /没有 id 为 g-nope 的目标/);
  await rejects(f, ['todo', 'add', 'm2', 'title=x', 'today=2026-11-02'], /没有可写的字段 today/);
  await rejects(f, ['todo', 'add', 'm2', 'p=P1'], /缺 'title=/);
  await rejects(f, ['todo', 'set', 'm2', a, 'status=done'], /完成用 todo done/);
  await rejects(f, ['todo', 'set', 'm2', a, 'status=sent'], /派出用 todo dispatch/);
  await rejects(f, ['todo', 'done', 'm2', 't-nope'], /没有 id 为 t-nope 的待办/);
  // 完成：写 ended，默认 ls 不列，--all 列在已完成
  assert.match(await run('todo', 'done', 'm2', c, 'note=不晕了'), new RegExp('todo/' + c + ' → 已完成'));
  const done = read(f).todos.find((x) => x.id === c);
  assert.equal(done.ended, at('02'));
  assert.deepEqual(done.log.at(-1), { at: at('02'), ev: 'done', note: '不晕了' });
  assert.doesNotMatch(await run('todo', 'ls', 'm2'), new RegExp('todo/' + c + ' '));
  assert.match(await run('todo', 'ls', 'm2', '--all'), new RegExp('todo/' + c + ' \\[已完成\\].*完成于 11-02 10:00'));
  await rejects(f, ['todo', 'done', 'm2', c], /已经是「已完成」/);
  // 放弃再改回待办：ended 跟着删
  await run('todo', 'set', 'm2', a, 'status=dropped');
  assert.equal(read(f).todos.find((x) => x.id === a).ended, at('02'));
  await run('todo', 'set', 'm2', a, 'status=open', 'why=又要做了');
  const back = read(f).todos.find((x) => x.id === a);
  assert.equal(back.ended, undefined);
  assert.equal(back.why, '又要做了');
  // --json 给 agent
  assert.equal(JSON.parse(await run('todo', 'ls', 'm2', '--json')).length, 3);
});

test('「今天」一直留到做完或手动移出：跨天不清，写从哪天起', async () => {
  setNow('02');
  const f = await page('m3');
  const a = todoId(await run('todo', 'add', 'm3', 'title=在 Mac 上选证书', '--today'));
  const b = todoId(await run('todo', 'add', 'm3', 'title=以后再说'));
  setNow('05');
  // 別的写入（任何命令）都不动 today
  await run('note', 'add', 'm3', 'n1', 'title=须知');
  await run('todo', 'today', 'm3', b);
  const d = read(f);
  assert.equal(d.todos.find((x) => x.id === a).today, '2026-11-02');
  assert.equal(d.todos.find((x) => x.id === b).today, '2026-11-05');
  const ls = await run('todo', 'ls', 'm3');
  assert.match(ls, new RegExp('todo/' + a + ' \\[今天\\] \\[从 11-02 起在今天\\]'));
  assert.match(ls, new RegExp('todo/' + b + ' \\[今天\\] 以后再说'));
  await rejects(f, ['todo', 'today', 'm3', a], /从 2026-11-02 起已经在今天/);
  assert.match(await run('todo', 'today', 'm3', a, b, '--off'), /移出今天：/);
  assert.ok(read(f).todos.every((x) => x.today === undefined));
  await rejects(f, ['todo', 'today', 'm3', a, '--off'], /不在今天/);
  // 做完的留着 today 作记录，但不在「今天」组；完成的不能再放进今天
  await run('todo', 'today', 'm3', a);
  await run('todo', 'done', 'm3', a);
  assert.doesNotMatch(await run('todo', 'ls', 'm3'), new RegExp('todo/' + a + ' '));
  await rejects(f, ['todo', 'today', 'm3', a], /现在是「已完成」/);
  await run('todo', 'set', 'm3', a, 'status=open');
  assert.match(await run('todo', 'ls', 'm3'), new RegExp('todo/' + a + ' \\[今天\\]'));
});

// 2026-11-03（personal-ops 搬到对齐页第 3 轮）：收工 worklog 读 align day
function dayFixture() {
  const R = (id, status, started, extra = {}) => ({ id, title: '轮次 ' + id, status, started, updated: started, ...extra });
  return { version: 3, projects: [{ id: 'p1', title: 'Alpha' }], todos: [
    { id: 't-a', title: '找 Tianyi 续期', status: 'done', ended: at('03', '15') },
    { id: 't-b', title: '昨天做完的', status: 'done', ended: at('02', '15') },
    { id: 't-c', title: '今天放弃的', status: 'dropped', ended: at('03', '16') },
    { id: 't-d', title: '派出去做完的', status: 'done', ended: at('03', '17'), round: 'r-acc' },
  ], rounds: [
    R('r-acc', 'accepted', at('02', '20'), { proj: 'p1', ended: at('03', '09'), updated: at('03', '11'), result: '已合入' }),
    R('r-done', 'done', at('03', '10'), { ended: at('03', '12') }),
    R('r-new', 'doing', at('03', '13')),
    R('r-old', 'doing', at('01', '10'), { updated: at('03', '14') }),
    R('r-stale', 'doing', at('01', '10'), { updated: at('02', '14') }),
    R('r-drop', 'dropped', at('02', '10'), { ended: at('03', '15') }),
    R('r-y', 'accepted', at('02', '08'), { ended: at('02', '18'), updated: at('03', '09') }),
  ] };
}
test('align day：当天交了结果 / 新开 / 之前开、当天有更新 / 放弃的轮次，当天完成的待办；命令只读', async () => {
  const rep = A.dayReport(dayFixture(), '2026-11-03');
  const ids = (xs) => xs.map((x) => x.id);
  assert.deepEqual(ids(rep.done), ['r-acc', 'r-done'], '通过和待验收都算完成；昨天交、今天才通过的 r-y 不算');
  assert.equal(rep.done[0].proj, 'Alpha');
  assert.deepEqual(ids(rep.started), ['r-new']);
  assert.deepEqual(ids(rep.doing), ['r-old'], '今天没更新的老轮次不列');
  assert.deepEqual(ids(rep.dropped), ['r-drop']);
  assert.deepEqual(ids(rep.todos), ['t-a', 't-d'], '只列当天完成的待办，放弃的不算');
  const txt = A.dayLines(rep);
  assert.match(txt, /^2026-11-03 对齐页\n完成的轮次 2：\n  round\/r-acc \[Alpha\] \[已通过\] 轮次 r-acc · 09:00 交 · 结果：已合入/);
  assert.match(txt, /做完的待办 2：\n  todo\/t-a 找 Tianyi 续期 · 15:00 完成\n  todo\/t-d 派出去做完的 · 17:00 完成（派给轮次 r-acc）/);
  assert.equal(A.dayLines(A.dayReport({ rounds: [], todos: [] }, '2026-11-04')), '2026-11-04 对齐页没有轮次或待办的记录');
  // 命令：缺省今天（ALIGN_NOW）、--date、--json；不改页面文件
  setNow('03', '18');
  const f = await page('m-day');
  await run('round', 'done', 'm-day', 'r1', 'visual=false', 'result=交了');
  const snap = fs.readFileSync(f, 'utf8');
  assert.match(await run('day', 'm-day'), /^2026-11-03 对齐页\n完成的轮次 1：\n  round\/r1 \[Alpha\] \[待验收\] 第一轮 · 18:00 交 · 结果：交了/);
  assert.equal(JSON.parse(await run('day', 'm-day', '--date', '2026-11-02', '--json')).done.length, 0);
  await rejects(f, ['day', 'm-day', '--date', '11-02'], /--date 要写 YYYY-MM-DD/);
  await rejects(f, ['day', 'm-day', 'x=1'], /用法: day/);
  assert.equal(fs.readFileSync(f, 'utf8'), snap, 'align day 不写页面');
});

test('派给会话的待办自动收尾：round accept → 已完成；那一轮放弃 → 回到待办；--prev 接着做跟到新一轮', async () => {
  setNow('02');
  const f = await page('m4');
  const pf = path.join(dir, 'task.md');
  fs.writeFileSync(pf, '去做');
  const a = todoId(await run('todo', 'add', 'm4', 'title=把禁用词里的「啥」去掉', '--today'));
  // todo dispatch：新开会话，title 缺省取待办标题
  const out = await run('todo', 'dispatch', 'm4', a, 'd1', '--prompt-file', pf, '--mode', 'new', '--proj', 'Alpha', 'why=用户点了派出去做', ...E);
  assert.match(out, new RegExp('待办 ' + a + ' 派成这一轮'));
  let d = read(f);
  let t = d.todos.find((x) => x.id === a);
  assert.deepEqual([t.status, t.round, t.today], ['sent', 'd1', '2026-11-02']);
  assert.equal(d.rounds.find((r) => r.id === 'd1').title, '把禁用词里的「啥」去掉');
  assert.match(await run('todo', 'ls', 'm4'), new RegExp('todo/' + a + ' \\[已派出\\].* · 派给轮次 d1'));
  assert.ok(A.roundShowLines(d, d.rounds.find((r) => r.id === 'd1')).includes('源自待办: ' + a + ' [已派出] 把禁用词里的「啥」去掉'));
  // 已派出的不能用 todo set 改状态（跟着轮次收尾），也不能再派
  await rejects(f, ['todo', 'set', 'm4', a, 'status=dropped'], /已派成轮次 d1：.*round set m4 d1 status=dropped/);
  // 已派出的不能再派
  await rejects(f, ['round', 'add', 'm4', 'd9', '--mode', 'continue', '--prev', 'd1', '--todo', a, 'title=x', 'why=y', ...E], /只有待办 \/ 在做的能派出去/);
  // 接着做（--prev）：待办跟到新一轮；上一轮自动收成 done 不影响待办
  assert.match(await run('round', 'add', 'm4', 'd2', '--mode', 'continue', '--prev', 'd1', 'title=第二轮', 'why=接着做', ...E), new RegExp('待办 ' + a + ' 跟到这一轮'));
  t = read(f).todos.find((x) => x.id === a);
  assert.deepEqual([t.status, t.round], ['sent', 'd2']);
  // round accept → 待办完成（输出里说明）
  await run('round', 'done', 'm4', 'd2', 'visual=false', 'result=好了');
  assert.equal(read(f).todos.find((x) => x.id === a).status, 'sent', 'done（等验收）不算完成');
  setNow('03');
  assert.match(await run('round', 'accept', 'm4', 'd2'), new RegExp('待办 ' + a + ' 跟着轮次 d2 通过 → 已完成'));
  t = read(f).todos.find((x) => x.id === a);
  assert.deepEqual([t.status, t.ended, t.round], ['done', at('03'), 'd2']);
  assert.deepEqual(t.log.map((e) => e.ev), ['add', 'today', 'send', 'send', 'done']);
  // 放弃那一轮 → 回到待办（今天还在），可以再派
  const b = todoId(await run('todo', 'add', 'm4', 'title=镜头对照截图', '--today'));
  await run('round', 'add', 'm4', 'd3', '--mode', 'continue', '--prev', 'r1', '--todo', b, 'title=做对照', 'why=派出', ...E);
  assert.match(await run('round', 'set', 'm4', 'd3', 'status=dropped', 'result=不做了'), new RegExp('轮次 d3 放弃了，待办 ' + b + ' 回到待办'));
  t = read(f).todos.find((x) => x.id === b);
  assert.deepEqual([t.status, t.round, t.today, t.log.at(-1).ev, t.log.at(-1).round], ['open', undefined, '2026-11-03', 'back', 'd3']);
  // 页面上的「确认」只记 ask，待办不动；First Mate 跑 round accept 时才收尾
  await run('round', 'add', 'm4', 'd4', '--mode', 'continue', '--prev', 'r1', '--todo', b, 'title=再做对照', 'why=再派', ...E);
  await run('round', 'done', 'm4', 'd4', 'visual=false');
  await A.answerBatch('m4', { answers: [{ kind: 'round', id: 'd4', action: 'accept' }] }, async () => {});
  assert.equal(read(f).todos.find((x) => x.id === b).status, 'sent');
  await run('round', 'accept', 'm4', 'd4');
  assert.equal(read(f).todos.find((x) => x.id === b).status, 'done');
  // round set 不收 --todo；不存在的待办报错
  await rejects(f, ['round', 'set', 'm4', 'd4', '--todo', b, 'state=x'], /--todo 只用于 round add/);
  await rejects(f, ['round', 'add', 'm4', 'd5', '--mode', 'continue', '--prev', 'r1', '--todo', 't-nope', 'title=x', 'why=y', ...E], /没有 id 为 t-nope 的待办/);
});

test('目标：关键结果列表、记进度、达成；轮次挂目标 / 等待办，待办上「N 个会话在等」', async () => {
  setNow('02');
  const f = await page('m5');
  const g = goalId(await run('goal', 'add', 'm5', 'title=旁白 11 月上线测试机', 'range=季度', 'metric=连续跑通', 'unit=局', 'base=0', 'target=10', 'due=2026-11-30', 'projs=Alpha', 'why=双击就能跑完一局'));
  await run('goal', 'kr', 'm5', g, 'add', 'title=27B 接口稳定、并发 2', 'cur=0', 'target=2');
  await run('goal', 'kr', 'm5', g, 'add', 'title=离线测试集四项问题修完', 'cur=3', 'target=4');
  await run('goal', 'kr', 'm5', g, 'add', 'title=05 和 01 同时各跑一局');
  assert.match(await run('goal', 'progress', 'm5', g, 'cur=2', 'note=01 跑通第一局'), /目标 → 2（20%）/);
  assert.match(await run('goal', 'progress', 'm5', g, 'cur=4', '--kr', 'k2'), /关键结果 k2「离线测试集四项问题修完」 → 4/);
  await run('goal', 'kr', 'm5', g, 'set', 'k3', 'done=true');
  let x = read(f).goals[0];
  assert.deepEqual([x.status, x.range, x.metric, x.unit, x.base, x.cur, x.target, x.due, x.projs], ['doing', '季度', '连续跑通', '局', 0, 2, 10, '2026-11-30', ['ws-a']]);
  assert.deepEqual(x.kr.map((k) => [k.id, k.cur, k.target, A.krDone(k)]), [['k1', 0, 2, false], ['k2', 4, 4, true], ['k3', undefined, undefined, true]]);
  assert.deepEqual(x.log.map((e) => [e.cur, e.kr, e.note]), [[2, undefined, '01 跑通第一局'], [4, 'k2', undefined]]);
  assert.equal(A.goalPct(x), 20);
  // 待办挂目标、轮次挂目标并等这条待办
  const t = todoId(await run('todo', 'add', 'm5', 'title=找 Tianyi 续期', 'goal=' + g));
  await run('round', 'set', 'm5', 'r1', 'goal=' + g, 'wait=' + t);
  await run('round', 'add', 'm5', 'r2', '--mode', 'new', '--proj', 'Alpha', 'title=镜头对照', 'sid=' + S(2), 'why=新任务', '--no-check-sid', 'goal=' + g, 'wait=' + t, ...E);
  let d = read(f);
  assert.equal(A.waitingSessions(d, t), 2);
  assert.match(await run('todo', 'ls', 'm5'), /· 2 个会话在等/);
  assert.ok(A.roundShowLines(d, d.rounds.find((r) => r.id === 'r2')).includes('在等待办: ' + t + ' [待办] 找 Tianyi 续期'));
  assert.match(await run('goal', 'ls', 'm5'), new RegExp('^goal/' + g + ' \\[进行中\\] \\[季度 截止 11-30 剩 28 天\\] 旁白 11 月上线测试机 · 连续跑通 2 / 10 局（20%） · 关键结果 2/3 · 待办 1（已派出 0，已完成 0） · 轮次 进行中 2 · 待验收 0 · 已结束 0$'));
  // 待办做完：列出在等它的轮次和解除命令；轮次结束后不再算在等
  const out = await run('todo', 'done', 'm5', t);
  assert.match(out, /在等它的轮次 r1（会话 session-712ba360-0000-4000-8000-000000000001）：通知那个会话继续，再 align round set m5 r1 wait=/);
  await run('round', 'set', 'm5', 'r1', 'wait=');
  await run('round', 'set', 'm5', 'r2', 'status=dropped');
  assert.equal(A.waitingSessions(read(f), t), 0);
  // 引用不存在的目标 / 待办、关键结果参数不对
  await rejects(f, ['round', 'set', 'm5', 'r1', 'goal=g-nope'], /goal g-nope 不在目标里/);
  await rejects(f, ['round', 'set', 'm5', 'r1', 'wait=t-nope'], /wait t-nope 不在待办里/);
  await rejects(f, ['goal', 'progress', 'm5', g, 'cur=三'], /cur 要是数/);
  await rejects(f, ['goal', 'progress', 'm5', g, 'cur=1', '--kr', 'k9'], /没有关键结果 k9/);
  await rejects(f, ['goal', 'add', 'm5', 'title=x', 'range=年度'], /range 只能是 长期/);
  await rejects(f, ['goal', 'set', 'm5', g, 'status=done'], /达成用 goal done/);
  // 达成：默认 ls 不列，--all 列
  await run('goal', 'done', 'm5', g, 'note=提前达成');
  x = read(f).goals[0];
  assert.deepEqual([x.status, x.ended, x.log.at(-1).note], ['done', at('02'), '提前达成']);
  assert.equal(await run('goal', 'ls', 'm5'), '（没有目标）');
  assert.match(await run('goal', 'ls', 'm5', '--all'), /\[达成\] \[季度 截止 11-30\]/);
  await run('goal', 'kr', 'm5', g, 'del', 'k3');
  assert.deepEqual(read(f).goals[0].kr.map((k) => k.id), ['k1', 'k2']);
});

test('推荐「我来做」：rec take 和页面 {kind:rec-take} 都变成放进今天的待办、推荐标成已处理，不发消息；3390 在主 3080 是旧插件时 409', async () => {
  setNow('02');
  const f = await page('m6');
  const recs = path.join(dir, 'recs.json');
  fs.writeFileSync(recs, JSON.stringify([{ title: '试一次 Codex 语音', why: '你说过想试', src: '早报' }, { title: '把日志压缩', why: '占空间' }, { title: '第三条', why: '理由' }]));
  await run('rec', 'set', 'm6', '--file', recs, '--date', '2026-11-02');
  // 3390：页面还没有待办，mineGuard 报错 → 409，页面不变、不发消息
  const snap = fs.readFileSync(f, 'utf8');
  let sent = 0;
  await assert.rejects(A.answerBatch('m6', { answers: [{ kind: 'rec-take', id: 'rec-20261102-1' }] }, async () => { sent++; }, { mineGuard: async () => { throw new A.UsageError('3080 报 api=16'); } }),
    (e) => e.status === 409 && e.code === 'needs-update');
  assert.equal(fs.readFileSync(f, 'utf8'), snap);
  // 页面：我来做 + 另一条「不做」一起发→ 只写文件
  const r = await A.answerBatch('m6', { answers: [{ kind: 'rec-take', id: 'rec-20261102-1' }, { kind: 'note', id: 'rec-20261102-2', ack: true }] }, async () => { sent++; });
  assert.equal(sent, 0);
  assert.equal(r.sid, undefined);
  const t = r.data.todos[0];
  assert.deepEqual([t.title, t.status, t.src, t.today, t.why], ['试一次 Codex 语音', 'open', '推荐', '2026-11-02', '你说过想试\n来源：早报']);
  assert.deepEqual(t.log.map((e) => [e.ev, e.note]), [['rec', 'rec-20261102-1'], ['today', undefined]]);
  assert.match(A.recLines(r.data), /rec-20261102-1 \[已处理\]/);
  // 同一条推荐不能既我来做又不做；已处理的不能再我来做
  await assert.rejects(A.answerBatch('m6', { answers: [{ kind: 'note', id: 'rec-20261102-3', ack: true }, { kind: 'rec-take', id: 'rec-20261102-3' }] }, async () => {}), (e) => e.code === 'bad-request');
  await assert.rejects(A.answerBatch('m6', { answers: [{ kind: 'rec-take', id: 'rec-20261102-1' }] }, async () => {}), (e) => e.code === 'bad-action');
  await assert.rejects(A.answerBatch('m6', { answers: [{ kind: 'rec-take', id: 'n-nope' }] }, async () => {}), (e) => e.code === 'note-not-found');
  // CLI：rec take 可以顺手补字段
  assert.match(await run('rec', 'take', 'm6', 'rec-20261102-3', 'p=P1', 'eta=15m'), /rec\/rec-20261102-3 → 我来做：加了今天的待办 todo\/t-/);
  const t3 = read(f).todos.find((x) => x.title === '第三条');
  assert.deepEqual([t3.p, t3.eta, t3.today], ['P1', '15m', '2026-11-02']);
  await rejects(f, ['rec', 'take', 'm6', 'rec-20261102-3'], /已经处理过/);
  await rejects(f, ['rec', 'take', 'm6', 'rec-20261102-9'], /没有 id 为 rec-20261102-9 的今日推荐/);
  await rejects(f, ['rec', 'take', 'm6', 'rec-20261102-2', 'src=手记'], /不收 status= \/ src=/);
});

test('import-po：默认预演不写；--write 按字段对照导入任务、目标、子目标（→ 关键结果）、进度快照；不重复导', async () => {
  setNow('02');
  const f = await page('m7');
  const po = path.join(dir, 'po');
  fs.mkdirSync(po, { recursive: true });
  const G = 'a'.repeat(32), K = 'b'.repeat(32);
  fs.writeFileSync(path.join(po, 'goals.json'), JSON.stringify({ items: [
    { id: G, title: '旁白上线', timeRange: '季度', status: '进行中', parentGoalId: null, metric: '跑通局数', baseline: 0, current: 1, target: 10, deadline: '2026-11-30', area: '工作', description: '' },
    { id: K, title: '27B 并发 2', timeRange: null, status: '进行中', parentGoalId: G, metric: null, baseline: null, current: 0, target: 2, deadline: null, area: null, description: '' },
  ] }));
  fs.writeFileSync(path.join(po, 'progress.json'), JSON.stringify({ items: [{ id: 'c'.repeat(32), goalId: G, date: '2026-10-31', current: 1, baselineSnapshot: 0, targetSnapshot: 10, note: '第一局' }] }));
  const task = (o) => ({ id: 'd'.repeat(31) + o.n, importance: null, urgency: null, energy: null, estimatedMinutes: null, deadline: null, goalIds: [], todayGroup: null, blockedBy: [], parentTaskId: null, description: '', completedAt: null, ...o, n: undefined });
  fs.writeFileSync(path.join(po, 'tasks.json'), JSON.stringify({ items: [
    task({ n: 1, title: '寅子管线', status: '进行中', importance: 'P0', urgency: '正常', energy: '中', estimatedMinutes: 120, deadline: '2026-10-27', todayGroup: '✅ 今天执行', goalIds: [G] }),
    task({ n: 2, title: '找 Tianyi', status: '待办', importance: 'P0', urgency: '紧急', energy: '低', estimatedMinutes: 10, todayGroup: '🤖 AI候选', description: 'AI 候选理由（10-28）：接口过期', goalIds: [K] }),
    task({ n: 3, title: '旧活', status: '已完成', estimatedMinutes: 90, todayGroup: '✅ 今天执行', completedAt: '2026-10-20T18:00:00+08:00' }),
  ] }));
  const snap = fs.readFileSync(f, 'utf8');
  const dry = await run('import-po', 'm7', '--dir', po);
  assert.match(dry, /^预演（没写入；加 --write 才写进页面）：personal-ops.*任务 3（待办 1、进行中 1、已完成 1、已取消 0），目标 2，进度快照 1/);
  assert.match(dry, /会加待办 3 条、目标 1 个/);
  assert.match(dry, /关键结果 g-[a-z0-9-]+\/k1 ← 子目标 27B 并发 2/);
  assert.match(await run('import-po', 'm7', '--dir', po, '--open-only'), /会加待办 2 条/);
  assert.equal(fs.readFileSync(f, 'utf8'), snap, '预演不改页面');
  assert.match(await run('import-po', 'm7', '--dir', po, '--write'), /导入了待办 3 条、目标 1 个/);
  const d = read(f);
  const g = d.goals[0];
  assert.deepEqual([g.title, g.range, g.metric, g.base, g.cur, g.target, g.due, g.why, g.kr], ['旁白上线', '季度', '跑通局数', 0, 1, 10, '2026-11-30', '领域：工作', [{ id: 'k1', title: '27B 并发 2', cur: 0, target: 2 }]]);
  assert.deepEqual(g.log, [{ at: '2026-10-31T00:00:00+08:00', cur: 1, note: '第一局' }]);
  const [a, b, c] = d.todos;
  assert.deepEqual([a.status, a.p, a.urg, a.energy, a.eta, a.due, a.today, a.goal, a.src], ['doing', 'P0', '正常', '中', '2h', '2026-10-27', '2026-11-02', [g.id], '导入']);
  assert.deepEqual([b.status, b.today, b.goal, b.why], ['open', undefined, [g.id], 'AI 候选理由（10-28）：接口过期']);
  assert.deepEqual([c.status, c.eta, c.ended, c.today], ['done', '1h30m', '2026-10-20T18:00:00+08:00', undefined]);
  assert.match(c.log[0].note, /从 personal-ops 导入（d+3）/);
  await rejects(f, ['import-po', 'm7', '--dir', po, '--write'], /已经有从 personal-ops 导入的待办/);
  // 有依赖 / 上级任务的不悟悟丢：报错
  const f8 = await page('m8');
  fs.writeFileSync(path.join(po, 'tasks.json'), JSON.stringify({ items: [task({ n: 4, title: '有依赖', status: '待办', blockedBy: ['e'.repeat(32)] })] }));
  await rejects(f8, ['import-po', 'm8', '--dir', po], /有依赖或上级任务/);
});

test('校验：手写坏的 todos / goals 整页拒读（和其它字段一样 fail-fast）；完成 / 放弃的多了保留 100 条', async () => {
  setNow('02');
  const f = await page('m9');
  await run('todo', 'add', 'm9', 'title=一条');
  const good = read(f);
  const bad = (mut, re) => { const d = structuredClone(good); mut(d); assert.throws(() => A.validate(d), re); };
  bad((d) => { d.todos[0].color = 'red'; }, /没有字段 color/);
  bad((d) => { d.todos[0].status = 'sent'; }, /已派出的待办要挂在页面上的一轮/);
  bad((d) => { d.todos[0].round = 'r1'; }, /待办 \/ 在做的不挂轮次/);
  bad((d) => { d.todos[0].status = 'done'; }, /完成 \/ 放弃的要有 ended/);
  bad((d) => { d.todos[0].src = '别处'; }, /src 只能是/);
  bad((d) => { d.todos[0].log = [{ at: 'x', ev: 'add' }]; }, /log 每条要有 at/);
  bad((d) => { d.todos = []; }, /todos 必须是非空数组/);
  bad((d) => { d.goals = [{ id: 'g-1', title: 'x', status: 'doing', created: at('02'), updated: at('02'), kr: [{ id: 'k1', title: 'y', cur: '3' }] }]; }, /关键结果 k1 的 cur 必须是数/);
  bad((d) => { d.goals = [{ id: 'g-1', title: 'x', status: 'doing', created: at('02'), updated: at('02'), projs: ['ws-zz'] }]; }, /项目 ws-zz 不在 projects 里/);
  // 裁剪：完成 / 放弃的留最新 100 条，没做完的都留
  const d = structuredClone(good);
  for (let i = 0; i < 105; i++) d.todos.push({ id: 't-old-' + i, title: '旧 ' + i, status: 'done', src: '导入', created: at('01'), updated: '2026-10-01T00:' + String(i % 60).padStart(2, '0') + ':' + String(Math.floor(i / 60)).padStart(2, '0') + '+08:00', ended: at('01') });
  fs.writeFileSync(f, A.render(d));
  await run('todo', 'add', 'm9', 'title=又一条');
  const after = read(f).todos;
  assert.equal(after.filter((t) => t.status === 'done').length, 100);
  assert.equal(after.filter((t) => t.status === 'open').length, 2);
});
