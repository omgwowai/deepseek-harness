// node --test plugins/dsh-alignment/cli/align.test.mjs  (在 ~/.dsh 下运行；ALIGN_STORE / ALIGN_WORKSPACES 指向临时目录)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-test-'));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, 'workspace.json');
// 会话一律经替身 dsh-threads（sid 校验、round show、dispatch）：不连 3080
process.env.ALIGN_THREADS_CLI = fileURLToPath(new URL('../test/fixtures/fake-threads.mjs', import.meta.url));
const A = await import('./align.mjs');
const file = path.join(dir, 'p.html');
const run = (cmd, ...rest) => A.main([cmd, ...rest]);
// 写 pauses 前的 3080 探测（api 15）：测试里不连真 3080，按「认得」走；旧插件的分支单独测
A.probes.pauseApi = async () => true;

test('init → add → set → done → del，每次一行输出', async () => {
  assert.match(await run('init', file, '--name', 't1', '--title', '测试页', '--owner', 'session-owner'), /^建了 t1 → /);
  assert.match(await run('add', 't1', 'decide', 'pick', 'title=选哪个', 'why=因为要选', 'opt=甲::后果甲', 'opt=乙::后果乙', 'rec=甲'), /^加了 decide\/pick → /);
  assert.match(await run('add', 't1', 'doing', 'job', 'title=一件事', 'state=做到一半', 'who=agent'), /^加了 doing\/job/);
  assert.match(await run('set', 't1', 'doing/job', 'state=做完了', 'next='), /^改了 doing\/job 的 state,next → /);
  assert.match(await run('done', 't1', 'job'), /^doing\/job → done\/job/);
  const data = A.parsePage(fs.readFileSync(file, 'utf8'));
  assert.equal(data.items.find((x) => x.id === 'job').result, '做完了');
  assert.equal(data.items.find((x) => x.id === 'pick').status, 'open');
  assert.match(await run('ls', 't1', 'decide'), /^decide\/pick \[其他\] \[open\] 选哪个/);
  assert.match(await run('del', 't1', 'job'), /^删了 done\/job/);
});

test('--help / -h / help:每条命令都打印用法、不做事;用法取自脚本头注释', async () => {
  // 命令清单取自「未知命令」的用法提示,新加命令自动覆盖
  const listed = (await run('nope').catch((e) => e.message)).match(/用法: ([^（]+)/)[1].split('|').map((s) => s.trim());
  assert.ok(listed.includes('dispatch') && listed.length > 20, listed.join(','));
  for (const c of [...listed, 'rule']) {
    const out = await A.main([c, '--help']);
    assert.match(out, new RegExp('^\\s*align ' + c + '\\s'), c + ' --help: ' + out.slice(0, 80));
    assert.doesNotMatch(out, /node align\.mjs/, c);
  }
  // 2026-10-31:dispatch --help 报「--help 需要一个值」
  const d = await A.main(['dispatch', '--help']);
  assert.match(d, /align dispatch <页> <id> --prompt-file/);
  assert.match(d, /派活 \+ 登记一步做完/, '带上缩进更深的续行');
  assert.doesNotMatch(d, /align round/, '只打印这条命令');
  // 子命令 + 别的参数:只看用法,不建轮次
  const before = fs.readFileSync(file, 'utf8');
  const rd = await A.main(['round', 'done', 't1', 'x', 'visual=true', '-h']);
  assert.match(rd, /^\s*align round done /);
  assert.doesNotMatch(rd, /align round add/);
  assert.equal(await A.main(['help', 'round', 'done']), rd);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '--help 不改页面');
  // 不带命令:整段头注释
  const all = await A.main(['--help']);
  assert.match(all, /^align\.mjs — 对齐页 CLI/);
  assert.match(all, /align dispatch /);
  assert.equal(await A.main(['help']), all);
  await assert.rejects(A.main(['help', 'nope']), /没有 nope 这条命令/);
  // 参数不当正则用:正则元字符、前缀、未知子命令都要报错
  await assert.rejects(A.main(['help', 'dispatc.']), /没有 dispatc\. 这条命令/);
  await assert.rejects(A.main(['help', '.*']), /没有 \.\* 这条命令/);
  await assert.rejects(A.main(['help', 'dispatc']), /没有 dispatc 这条命令/);
  await assert.rejects(A.main(['help', 'round', 'd.*']), /没有 round d\.\* 这条命令/);
  await assert.rejects(A.main(['round', 'nope', '--help']), /没有 round nope 这条命令/);
});

test('数据块每条一行，改一条只动一行', async () => {
  const before = fs.readFileSync(file, 'utf8').split('\n');
  await run('add', 't1', 'note', 'n1', 'title=须知一');
  await run('add', 't1', 'note', 'n2', 'title=须知二');
  const mid = fs.readFileSync(file, 'utf8').split('\n');
  await run('set', 't1', 'n1', 'body=多一句');
  const after = fs.readFileSync(file, 'utf8').split('\n');
  const changed = after.filter((l, i) => l !== mid[i]);
  const items = changed.filter((l) => l.startsWith('{"id"'));
  assert.equal(items.length, 1, '只动一条条目: ' + changed.join(' | '));
  assert.ok(changed.length <= 2, '最多再加一行页面 updated: ' + changed.join(' | '));
  assert.ok(before.length < mid.length);
});

test('出错 fail-fast，不改文件', async () => {
  const snap = fs.readFileSync(file, 'utf8');
  const bad = [
    ['set', 't1', 'nope', 'title=x'],
    ['set', 't1', 'n1', 'colour=red'],
    ['set', 't1', 'pick', 'rec=丙'],
    ['add', 't1', 'decide', 'p2', 'title=x', 'why=y', 'opt=只有一个::z', 'rec=只有一个'],
    ['add', 't1', 'note', 'n1', 'title=重复'],
    ['add', 't1', 'note', 'Bad_ID', 'title=x'],
    ['set', 't1', 'n1', 'href=javascript:alert(1)'],
    ['done', 't1', 'pick'],
    ['set', 't1', 'n1', 'id=n9'],
  ];
  for (const argv of bad) await assert.rejects(A.main(argv), A.UsageError, argv.join(' '));
  assert.equal(fs.readFileSync(file, 'utf8'), snap);
});

test('脚本注入：标题里的 </script> 不会截断数据块', async () => {
  await run('set', 't1', 'n2', 'title=</script><b>x</b>');
  assert.equal(A.parsePage(fs.readFileSync(file, 'utf8')).items.find((x) => x.id === 'n2').title, '</script><b>x</b>');
});

test('服务：点选项 → 发给会话 → status=sent；跨站请求被拒', async () => {
  const sent = [];
  const server = A.createServer({ port: 0, send: async (sid, prompt) => { sent.push({ sid, prompt }); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.close();
  const s2 = A.createServer({ port, send: async (sid, prompt) => { sent.push({ sid, prompt }); } });
  await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + port;
  const post = (headers, body) => fetch(base + '/p/t1/answer', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/p/t1')).status, 200);
    assert.equal((await post({ origin: 'https://evil.example' }, { id: 'pick', choice: '甲' })).status, 403);
    assert.equal((await post({ 'content-type': 'text/plain' }, { id: 'pick', choice: '甲' })).status, 415);
    assert.equal((await post({}, { id: 'pick', choice: '丙' })).status, 400);
    assert.equal(sent.length, 0);
    const ok = await (await post({}, { id: 'pick', choice: '乙', note: '尽快' })).json();
    assert.equal(ok.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sid, 'session-owner');
    assert.match(sent[0].prompt, /选择：乙\n备注：尽快/);
    const it = ok.data.items.find((x) => x.id === 'pick');
    assert.deepEqual([it.status, it.choice, it.reply], ['sent', '乙', '尽快']);
    assert.match(await run('done', 't1', 'pick'), /decide\/pick → done\/pick/);
    const d = A.parsePage(fs.readFileSync(file, 'utf8')).items.find((x) => x.id === 'pick');
    assert.deepEqual([d.sec, d.choice, d.reply], ['done', '乙', '尽快']);
  } finally { s2.close(); }
});

test('发送失败：报原始错误，页面不变', async () => {
  await run('add', 't1', 'decide', 'p3', 'title=再选', 'why=w', 'opt=甲::a', 'opt=乙::b', 'rec=乙');
  const snap = fs.readFileSync(file, 'utf8');
  const server = A.createServer({ port: 0, send: async () => { throw new Error('会话已归档'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  // port:0 时 Host 校验按 0 端口算，这里单独建一个按真实端口校验的服务
  server.close();
  const port = Number(base.split(':')[2]);
  const s2 = A.createServer({ port, send: async () => { throw new Error('会话已归档'); } });
  await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  try {
    const r = await fetch(base + '/p/t1/answer', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ id: 'p3', choice: '甲' }) });
    assert.equal(r.status, 500);
    assert.match((await r.json()).message, /会话已归档/);
    assert.equal(fs.readFileSync(file, 'utf8'), snap);
  } finally { s2.close(); }
});

test('旧版本(无项目字段)数据：读入自动补项目，写入后变成版本 2，原条目不丢', async () => {
  const f2 = path.join(dir, 'old.html');
  const v1 = { version: 1, name: 'old1', title: '旧页', updated: '2026-10-21T10:00:00+08:00', items: [
    { id: 'a', sec: 'doing', title: '旧任务', state: '在做', updated: '2026-10-21T10:00:00+08:00' },
    { id: 'b', sec: 'decide', title: '旧决定', why: 'w', opt: [{ label: '甲', effect: 'x' }, { label: '乙', effect: 'y' }], status: 'open', updated: '2026-10-21T10:00:00+08:00' },
  ] };
  const tpl = fs.readFileSync(new URL('./template-v2.html', import.meta.url), 'utf8');
  fs.writeFileSync(f2, tpl.replace('__ALIGN_DATA__', JSON.stringify(v1)));
  const d = A.parsePage(fs.readFileSync(f2, 'utf8'));
  assert.deepEqual([d.version, d.items[0].proj, d.items[1].proj], [2, '其他', '其他']);
  assert.match(await run('meta', f2, 'proj=~/.dsh'), /改了 页面 的 proj/);
  assert.match(await run('set', f2, 'a', 'proj=sims-overlay'), /改了 doing\/a 的 proj/);
  assert.match(await run('add', f2, 'note', 'n', 'title=新须知'), /加了 note\/n/);
  const after = A.parsePage(fs.readFileSync(f2, 'utf8'));
  assert.equal(after.version, 2);
  assert.deepEqual(after.items.map((x) => [x.id, x.proj]), [['a', 'sims-overlay'], ['b', '其他'], ['n', '~/.dsh']]);
  assert.match(await run('ls', f2, 'doing'), /^doing\/a \[sims-overlay\]/);
  assert.match(await run('done', f2, 'a'), /doing\/a → done\/a/);
  assert.equal(A.parsePage(fs.readFileSync(f2, 'utf8')).items.find((x) => x.id === 'a').proj, 'sims-overlay');
});

test('CRLF 模板（FM 仓库 checkout 后）渲染出的页面仍能读写', async () => {
  const f3 = path.join(dir, 'crlf.html');
  const tpl = fs.readFileSync(new URL('./template-v2.html', import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n');
  const data = { version: 2, name: 'crlf1', title: 'CRLF 页', updated: '2026-10-21T10:00:00+08:00', items: [] };
  fs.writeFileSync(f3, tpl.replace('__ALIGN_DATA__', A.serialize(data)));
  assert.match(await run('add', f3, 'note', 'x', 'title=一条'), /加了 note\/x/);
  assert.equal(A.parsePage(fs.readFileSync(f3, 'utf8')).items.length, 1);
});

// ---- 版本 3 ----------------------------------------------------------------------------------
const alpha = path.join(dir, 'alpha');
const fake = path.join(os.homedir(), '.align-test-fake');
fs.mkdirSync(alpha, { recursive: true });
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ tables: { workspaces: {
  'ws-a': { path: alpha, title: 'Alpha', sessionIds: ['session-712ba360-0000-4000-8000-a10000000000', 'session-742ba819-0000-4000-8000-a20000000000'] },
  'ws-h': { path: fake, title: 'HomeFake', sessionIds: ['session-fd152675-0000-4000-8000-100000000000'] },
  'ws-c': { path: path.join(dir, 'gamma'), title: 'gamma', sessionIds: [] },
} } }));
const handoff = path.join(dir, 'handoff.md');
fs.writeFileSync(handoff, '# 交接');
const f3 = path.join(dir, 'v3.html');
const E = ['eta=40m', 'eta75=1h', 'etaconf=中']; // round add 必带的预计用时
const RC = ['risk=中', 'cat=其他']; // open 决定必带的风险与类别（api 7）
const read3 = (f = f3) => A.parsePage(fs.readFileSync(f, 'utf8'));
const rejects = async (argv, re, f = f3) => {
  const snap = fs.readFileSync(f, 'utf8');
  await assert.rejects(A.main(argv), (e) => e instanceof A.UsageError && (!re || re.test(e.message)), argv.join(' '));
  assert.equal(fs.readFileSync(f, 'utf8'), snap, '出错不改文件: ' + argv.join(' '));
};

test('v3 init + project add / ls', async () => {
  assert.match(await run('init', f3, '--name', 'v3', '--title', '三版', '--owner', 'session-owner', '--version', '3'), /^建了 v3/);
  assert.equal(read3().version, 3);
  assert.match(await run('project', 'add', 'v3', '--cwd', alpha.toUpperCase() + path.sep), /^加了项目 Alpha（ws-a，/);
  await rejects(['project', 'add', 'v3', '--ws', 'ws-a'], /已存在/);
  await rejects(['project', 'add', 'v3', '--ws', 'ws-zzz'], /没有 id ws-zzz/);
  await rejects(['project', 'add', 'v3', '--cwd', path.join(dir, 'nope')], /workspace 表里没有/);
  await rejects(['project', 'add', 'v3'], /用法/);
  assert.match(await run('project', 'ls', 'v3'), /^project\/ws-a Alpha/);
  assert.deepEqual(read3().projects, [{ id: 'ws-a', title: 'Alpha', cwd: alpha }]);
});

test('v3 round add：项目解析、继承 sid、上一轮自动完成、新会话要交接', async () => {
  assert.equal(await run('round', 'add', 'v3', 'r1', '--mode', 'new', ...E, 'title=第一轮', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=新任务'), '项目 Alpha：新增一轮 r1（新会话） → ' + f3);
  assert.match(await run('round', 'add', 'v3', 'r2', '--mode', 'continue', '--prev', 'r1', ...E, 'title=第二轮', 'why=还在定位'), /^项目 Alpha：新增一轮 r2（续发，接 r1）；上一轮 r1 改为完成 → /);
  let d = read3();
  const r2 = d.rounds.find((x) => x.id === 'r2'), r1 = d.rounds.find((x) => x.id === 'r1');
  assert.deepEqual([r2.sid, r2.prev, r2.prevSid, r2.proj, r2.status, r1.status], ['session-712ba360-0000-4000-8000-a10000000000', 'r1', 'session-712ba360-0000-4000-8000-a10000000000', 'ws-a', 'doing', 'done']);
  assert.ok(r2.started && r2.updated);
  await rejects(['round', 'add', 'v3', 'r3', '--mode', 'new', '--prev', 'r2', ...E, 'title=t', 'sid=session-742ba819-0000-4000-8000-a20000000000', 'why=w'], /--handoff/);
  await rejects(['round', 'add', 'v3', 'r3', '--mode', 'new', '--prev', 'r2', '--handoff', path.join(dir, 'missing.md'), ...E, 'title=t', 'sid=session-742ba819-0000-4000-8000-a20000000000', 'why=w'], /交接文件不存在/);
  assert.match(await run('round', 'add', 'v3', 'r3', '--mode', 'new', '--prev', 'r2', '--handoff', path.relative(process.cwd(), handoff), ...E, 'title=第三轮', 'sid=session-742ba819-0000-4000-8000-a20000000000', 'why=阶段边界'), /新增一轮 r3（新会话，接 r2）；上一轮 r2 改为完成/);
  assert.equal(read3().rounds.find((x) => x.id === 'r3').handoff, handoff);
  // 按标题 / 目录（~）解析 workspace，命中后自动加进 projects
  assert.match(await run('round', 'add', 'v3', 'h1', '--mode', 'continue', '--proj', '~/.align-test-fake', ...E, 'title=家', 'sid=session-92517616-0000-4000-8000-000000000000', 'why=w'), /^项目 HomeFake：新增一轮 h1（续发）；新加项目 HomeFake/);
  assert.match(await run('round', 'add', 'v3', 'g1', '--mode', 'continue', '--proj', 'GAMMA', ...E, 'title=伽马', 'sid=session-8d516e37-0000-4000-8000-000000000000', 'why=上下文满'), /^项目 gamma：/);
  assert.match(await run('round', 'add', 'v3', 'h2', '--mode', 'continue', ...E, 'title=按 sid', 'sid=session-fd152675-0000-4000-8000-100000000000', 'why=w'), /^项目 HomeFake：/);
  d = read3();
  assert.deepEqual(d.projects.map((p) => p.id), ['ws-a', 'ws-h', 'ws-c']);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'continue', ...E, 'title=t', 'sid=session-7f2134e8-0000-4000-8000-000000000000', 'why=w'], /--proj/);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'continue', '--proj', 'nowhere', ...E, 'title=t', 'sid=session-5e5e5e5e-0000-4000-8000-000000000000', 'why=w'], /找不到项目 nowhere/);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'continue', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000'], /why/);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'new', ...E, 'title=t', 'why=w'], /sid/);
  await rejects(['round', 'add', 'v3', 'x1', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=w'], /--mode/);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'later', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=w'], /--mode continue \| new/);
  // 「压缩后续发」2026-10-23 取消：报错并指向 continue / new
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'compact', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=w'], /压缩后续发.*已于 2026-10-23 取消.*--mode continue.*--mode new/);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'new', '--prev', 'nope', ...E, 'title=t', 'sid=session-5e5e5e5e-0000-4000-8000-000000000000', 'why=w'], /--prev/);
  await rejects(['round', 'add', 'v3', 'r1', '--mode', 'new', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=w'], /已存在/);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'new', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=w', 'proj=ws-a'], /--proj/);
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'new', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=w', 'status=done'], /status/);
  // v8：「等你回答」取消，round add / set 都拒收 status=waiting，报错里给出不带 opt 的 decide add
  await rejects(['round', 'add', 'v3', 'x1', '--mode', 'new', ...E, 'title=t', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'why=w', 'status=waiting'], /status=waiting（等你回答）已取消.*decide add v3 <决定 id> --round x1 'title=<要问的话>'/);
  await rejects(['round', 'set', 'v3', 'r1', 'status=waiting'], /status=waiting（等你回答）已取消.*--round r1/);
});

test('v3 round set / done', async () => {
  assert.match(await run('round', 'set', 'v3', 'r3', 'state=写到一半', 'next=跑测试', 'stitle=三号会话'), /^改了 round\/r3 的 state,next,stitle → /);
  assert.match(await run('round', 'set', 'v3', 'r3', 'next=', '--proj', 'gamma'), /^改了 round\/r3 的 next,proj/);
  let r = read3().rounds.find((x) => x.id === 'r3');
  assert.deepEqual([r.next, r.proj], [undefined, 'ws-c']);
  await rejects(['round', 'set', 'v3', 'r3', 'status=later'], /status 只能是/);
  await rejects(['round', 'set', 'v3', 'r3', '--handoff', ''], /--handoff/);
  await rejects(['round', 'set', 'v3', 'r3', 'why='], /why 必填/);
  await rejects(['round', 'set', 'v3', 'nope', 'state=x'], /没有 id 为 nope 的 round/);
  await rejects(['round', 'set', 'v3', 'r3', '--mode', 'compact'], /压缩后续发.*已于 2026-10-23 取消/);
  await rejects(['round', 'set', 'v3', 'r3', '--mode', 'later'], /round set 要 --mode continue \| new/);
  // 页面上已有的 mode=compact 旧轮次：照常读写，mode 不动、不迁移
  {
    const data = read3();
    data.rounds.find((x) => x.id === 'g1').mode = 'compact';
    fs.writeFileSync(f3, A.render(data));
    assert.match(await run('round', 'set', 'v3', 'g1', 'state=旧轮次照常改'), /^改了 round\/g1 的 state/);
    assert.equal(read3().rounds.find((x) => x.id === 'g1').mode, 'compact');
    assert.match(await run('ls', 'v3'), /round\/g1 .*\[compact\]/);
    // 还原 g1，后面的用例还要用它
    await run('round', 'set', 'v3', 'g1', 'state=');
    const back = read3();
    back.rounds.find((x) => x.id === 'g1').mode = 'continue';
    fs.writeFileSync(f3, A.render(back));
  }
  await rejects(['round', 'set', 'v3', 'r3', 'started=x'], /CLI 维护/);
  assert.match(await run('round', 'done', 'v3', 'r3', 'result=合入了', 'visual=false'), /^round\/r3 → 完成/);
  r = read3().rounds.find((x) => x.id === 'r3');
  assert.deepEqual([r.status, r.result], ['done', '合入了']);
  await rejects(['round', 'done', 'v3', 'r3'], /已经完成/);
});

test('v3 decide / note / del / ls，id 全局唯一', async () => {
  assert.match(await run('decide', 'add', 'v3', 'd1', ...RC, 'title=选库', 'why=要定', 'opt=甲::快', 'opt=乙::稳', 'rec=甲', '--round', 'g1'), /^加了 decide\/d1（项目 gamma）/);
  assert.match(await run('decide', 'add', 'v3', 'd2', ...RC, 'title=无主', 'why=w', 'opt=甲::a', 'opt=乙::b'), /^加了 decide\/d2（项目 未归属）/);
  let d = read3();
  assert.deepEqual([d.decisions[0].round, d.decisions[0].proj, d.decisions[0].status, d.decisions[1].proj], ['g1', 'ws-c', 'open', undefined]);
  await rejects(['decide', 'add', 'v3', 'r1', ...RC, 'title=x', 'why=y', 'opt=a::b', 'opt=c::d'], /已存在/);
  await rejects(['decide', 'add', 'v3', 'd3', ...RC, 'title=x', 'why=y', 'opt=a::b'], /至少 2 个选项/);
  await rejects(['decide', 'add', 'v3', 'd3', ...RC, 'title=x', 'opt=a::b', 'opt=c::d'], /why/);
  await rejects(['decide', 'add', 'v3', 'd3', ...RC, 'title=x', 'why=y', 'opt=a::b', 'opt=c::d', 'rec=e'], /rec/);
  await rejects(['decide', 'add', 'v3', 'd3', ...RC, 'title=x', 'why=y', 'opt=a::b', 'opt=c::d', '--round', 'nope'], /轮次/);
  await rejects(['decide', 'add', 'v3', 'd3', ...RC, 'title=x', 'why=y', 'opt=a::b', 'opt=c::d', '--round', 'g1', '--proj', 'Alpha'], /不一致/);
  assert.match(await run('decide', 'set', 'v3', 'd2', '--proj', 'Alpha', 'ifnone=拖着'), /^改了 decide\/d2 的 ifnone,proj/);
  await rejects(['decide', 'done', 'v3', 'd2'], /还没有答复/);
  assert.match(await run('decide', 'done', 'v3', 'd2', 'choice=乙'), /^decide\/d2 → 完成/);
  assert.equal(read3().decisions.find((x) => x.id === 'd2').status, 'done');
  // 轮次改项目，挂在它上面的决定跟着改
  await run('round', 'set', 'v3', 'g1', '--proj', 'Alpha');
  assert.equal(read3().decisions.find((x) => x.id === 'd1').proj, 'ws-a');
  assert.match(await run('note', 'add', 'v3', 'n1', 'title=注意', 'level=warn', '--proj', 'ws-h'), /^加了 note\/n1（项目 HomeFake）/);
  await rejects(['note', 'add', 'v3', 'n2', 'title=x', 'level=loud'], /level/);
  assert.match(await run('note', 'set', 'v3', 'n1', 'body=细节', '--proj', ''), /^改了 note\/n1 的 body,proj/);
  assert.equal(read3().notes[0].proj, undefined);
  assert.match(await run('ls', 'v3', 'round', '--proj', 'Alpha'), /^round\/r1 \[Alpha\] \[done\] \[new\] 第一轮/);
  assert.match(await run('ls', 'v3', 'note', '--proj', '未归属'), /^note\/n1 \[未归属\] \[warn\] 注意/);
  assert.match(await run('ls', 'v3', 'decide', 'status=open'), /^decide\/d1 \[Alpha\] \[open\] 选库 · /);
  assert.match(await run('ls', 'v3', 'project'), /project\/ws-h HomeFake/);
  assert.equal((await run('ls', 'v3')).split('\n').length, 9);
  await rejects(['ls', 'v3', 'round', '--proj', 'nowhere'], /页面上没有项目/);
  assert.match(await run('note', 'del', 'v3', 'n1'), /^删了 note\/n1/);
  assert.match(await run('del', 'v3', 'h2'), /^删了 round\/h2/);
  await rejects(['note', 'del', 'v3', 'r1'], /没有 id 为 r1 的 note/);
  await rejects(['round', 'fly', 'v3', 'r1'], /用法: round add \| set \| done/);
});

test('v3 序列化：顶层每字段一行，每条一行，改一条只动一行', async () => {
  const before = fs.readFileSync(f3, 'utf8').split('\n');
  assert.ok(before.includes('"rounds":[') && before.includes('"decisions":[') && before.includes('"projects":['));
  await run('round', 'set', 'v3', 'h1', 'state=更新');
  const after = fs.readFileSync(f3, 'utf8').split('\n');
  const changed = after.filter((l, i) => l !== before[i]);
  assert.equal(changed.filter((l) => l.startsWith('{"id"')).length, 1, changed.join(' | '));
  assert.ok(changed.length <= 2, changed.join(' | '));
});

test('v3 裁剪：已通过（accepted）轮次留 40，done 决定留 20，未完成的不裁', async () => {
  const f = path.join(dir, 'prune.html');
  const data = { version: 3, name: 'prune', title: 'p', projects: [], rounds: [], decisions: [], notes: [] };
  const ts = (i) => '2026-10-01T00:00:' + p2(i) + '+08:00';
  const p2 = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 45; i++) data.rounds.push({ id: 'r' + i, title: 't', status: 'accepted', updated: ts(i) });
  data.rounds.push({ id: 'live', title: 't', status: 'doing', updated: ts(0) });
  for (let i = 0; i < 25; i++) data.decisions.push({ id: 'd' + i, title: 't', status: 'done', choice: 'x', updated: ts(i) });
  data.decisions.push({ id: 'open1', title: 't', why: 'w', opt: [{ label: 'a', effect: 'b' }, { label: 'c', effect: 'd' }], status: 'open', updated: ts(0) });
  fs.writeFileSync(f, A.render(data));
  await run('note', 'add', f, 'n', 'title=x');
  const d = read3(f);
  assert.equal(d.rounds.filter((x) => x.status === 'accepted').length, 40);
  assert.ok(d.rounds.some((x) => x.id === 'live') && !d.rounds.some((x) => x.id === 'r4') && d.rounds.some((x) => x.id === 'r5'));
  assert.equal(d.decisions.filter((x) => x.status === 'done').length, 20);
  assert.ok(d.decisions.some((x) => x.id === 'open1'));
});

test('版本 2 页面上用新命令：报错先 migrate，不改文件', async () => {
  for (const argv of [['round', 'add', 't1', 'z', '--mode', 'new', 'title=x', 'sid=session-5e5e5e5e-0000-4000-8000-000000000000', 'why=w', ...E], ['decide', 'add', 't1', 'z', 'title=x'], ['note', 'add', 't1', 'z', 'title=x'], ['project', 'add', 't1', '--ws', 'ws-a'], ['project', 'ls', 't1'], ['ls', 't1', 'round']]) {
    await rejects(argv, /页面还是版本 2，先运行 align migrate t1/, file);
  }
});

test('旧命令在版本 3 页面上兼容', async () => {
  // v8：旧命令的 who=you（= 等你回答）同样拒收
  await assert.rejects(run('add', 'v3', 'doing', 'odx', 'title=旧派活', 'sid=session-742ba819-0000-4000-8000-a20000000000', 'who=you'), /status=waiting（等你回答）已取消/);
  assert.match(await run('add', 'v3', 'doing', 'od', 'title=旧派活', 'state=已派', 'next=等', 'sid=session-742ba819-0000-4000-8000-a20000000000', 'src=某会话', 'who=agent'), /^加了 round\/od（项目 Alpha）/);
  let r = read3().rounds.find((x) => x.id === 'od');
  assert.deepEqual([r.status, r.stitle, r.proj, r.mode, r.state], ['doing', '某会话', 'ws-a', undefined, '已派']);
  assert.match(await run('add', 'v3', 'doing', 'od2', 'title=无主', 'state=x', 'sid=session-86496ca9-0000-4000-8000-bd0000000000'), /（项目 未归属）/);
  assert.match(await run('add', 'v3', 'decide', 'od3', ...RC, 'title=旧决定', 'why=w', 'opt=甲::a', 'opt=乙::b', 'proj=~/.align-test-fake', 'src=来源'), /^加了 decide\/od3（项目 HomeFake）/);
  assert.equal(read3().decisions.find((x) => x.id === 'od3').src, '来源');
  assert.match(await run('add', 'v3', 'note', 'on', 'title=旧须知', 'proj=Alpha'), /^加了 note\/on（项目 Alpha）/);
  assert.match(await run('add', 'v3', 'done', 'odn', 'title=做完的', 'result=好了', 'visual=false'), /^加了 round\/odn/);
  assert.equal(read3().rounds.find((x) => x.id === 'odn').status, 'done');
  assert.match(await run('set', 'v3', 'doing/od', 'who=agent', 'state=在做', 'proj=gamma'), /^改了 round\/od 的 status,state,proj/);
  r = read3().rounds.find((x) => x.id === 'od');
  assert.deepEqual([r.status, r.proj], ['doing', 'ws-c']);
  assert.match(await run('ls', 'v3', 'doing'), /round\/od \[gamma\] \[doing\] 旧派活/);
  assert.match(await run('ls', 'v3', 'done'), /decide\/d2/);
  assert.match(await run('done', 'v3', 'od', 'visual=false'), /^round\/od → 完成/);
  assert.equal(read3().rounds.find((x) => x.id === 'od').result, '在做');
  await rejects(['done', 'v3', 'od3'], /还没有答复/);
  assert.match(await run('done', 'v3', 'od3', 'choice=甲'), /^decide\/od3 → 完成/);
  await rejects(['done', 'v3', 'on'], /不能移到最近完成/);
  await rejects(['meta', 'v3', 'proj=x'], /没有默认项目/);
  assert.match(await run('meta', 'v3', 'next=插 USB'), /改了 页面 的 next/);
  await rejects(['add', 'v3', 'doing', 'bad', 'title=x', 'who=me'], /who 只能是/);
  await rejects(['add', 'v3', 'doing', 'bad', 'title=x', 'proj=nowhere'], /找不到项目/);
  assert.match(await run('del', 'v3', 'od2'), /^删了 round\/od2/);
});

test('legacyView：版本 3 投影成版本 2；版本 2 原样', () => {
  const v3 = read3();
  const v = A.legacyView(v3);
  assert.equal(v.version, 2);
  assert.deepEqual(Object.keys(v), ['version', 'name', 'title', 'next', 'owner', 'updated', 'items']);
  A.validate(v);
  const by = Object.fromEntries(v.items.map((x) => [x.id, x]));
  assert.deepEqual([by.d1.sec, by.d1.proj, by.d1.status], ['decide', 'Alpha', 'open']);
  assert.deepEqual([by.d2.sec, by.d2.choice], ['done', '乙']);
  assert.deepEqual([by.h1.sec, by.h1.who, by.h1.state, by.h1.proj], ['doing', 'agent', '更新', 'HomeFake']);
  // 旧数据里的 waiting（v8 起 CLI 不再写）照旧投影成手机的「等你回答」
  const old = A.legacyView({ version: 3, name: 'lv', title: 't', projects: [], rounds: [{ id: 'w', title: '旧的等你', status: 'waiting', next: '插手机' }], decisions: [], notes: [] });
  assert.deepEqual([old.items[0].sec, old.items[0].who], ['doing', 'you']);
  assert.deepEqual([by.g1.sec, by.g1.who, by.g1.state], ['doing', 'agent', '进行中']);
  assert.deepEqual([by.r3.sec, by.r3.result, by.r3.src, by.r3.proj], ['done', '待验收：合入了', '三号会话', 'gamma']);
  assert.deepEqual([by.on.sec, by.on.proj], ['note', 'Alpha']);
  assert.equal(by.r2.mode, undefined);
  const v2 = A.parsePage(fs.readFileSync(file, 'utf8'));
  assert.equal(A.legacyView(v2), v2);
});

test('v3 服务：listPages open 计数、点选项 → decisions sent、消息指引 decide done', async () => {
  const pages = A.listPages();
  assert.equal(pages.find((p) => p.name === 'v3').decisions, A.parsePage(fs.readFileSync(f3, 'utf8')).decisions.filter((x) => x.status === 'open').length);
  const sent = [];
  const r = await A.answerDecision('v3', { id: 'd1', choice: '乙', note: '就它' }, async (sid, prompt, card) => { sent.push({ sid, prompt, card }); });
  assert.equal(r.sid, 'session-owner');
  assert.match(sent[0].prompt, /^对齐页「三版」上，用户对这件事做了决定：选库/);
  assert.match(sent[0].prompt, /decide done v3 d1/);
  assert.match(sent[0].prompt, /decide set v3 d1 status=open/);
  // 第三个参数是卡片数据（3080 插件画卡片用）：只有页面标题和决定的标题 / 选项 / 补充，不带处理命令
  assert.deepEqual(sent[0].card, { page: '三版', decisions: [{ title: '选库', choice: '乙', note: '就它' }] });
  const d1 = r.data.decisions.find((x) => x.id === 'd1');
  assert.deepEqual([d1.status, d1.choice, d1.reply, r.data.version], ['sent', '乙', '就它', 3]);
  await assert.rejects(A.answerDecision('v3', { id: 'd2', choice: '甲' }, async () => {}), (e) => e.code === 'decision-not-found');
  await assert.rejects(A.answerDecision('v3', { id: 'r1', choice: '甲' }, async () => {}), (e) => e.code === 'decision-not-found');
  assert.equal(A.pageData('v3').version, 3);
  assert.equal(A.API_VERSION, 19);
});

test('v3 服务：一次发出多个决定 → 合并成一条消息发给页面 owner，逐条附 decide done，全部改成 sent', async () => {
  assert.match(await run('decide', 'add', 'v3', 'b1', ...RC, 'title=批一', 'why=w', 'opt=甲::a', 'opt=乙::b'), /加了 decide\/b1/);
  assert.match(await run('decide', 'add', 'v3', 'b2', ...RC, 'title=批二', 'why=w', 'opt=甲::a', 'opt=乙::b', 'sid=session-864f50b8-0000-4000-8000-e00000000000'), /加了 decide\/b2/);
  const sent = [];
  const r = await A.answerBatch('v3', { answers: [{ id: 'b1', choice: '甲' }, { id: 'b2', choice: '乙', note: '尽快' }] }, async (sid, prompt, card) => { sent.push({ sid, prompt, card }); });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, 'session-owner');
  assert.match(sent[0].prompt, /用户一次做了 2 个决定/);
  assert.match(sent[0].prompt, /1\. 批一\n {3}选择：甲/);
  assert.match(sent[0].prompt, /2\. 批二\n {3}选择：乙\n {3}备注：尽快/);
  assert.match(sent[0].prompt, /decide done v3 b1/);
  assert.match(sent[0].prompt, /decide done v3 b2/);
  assert.match(sent[0].prompt, /session-864f50b8-0000-4000-8000-e00000000000/);
  assert.deepEqual(sent[0].card, { page: '三版', decisions: [{ title: '批一', choice: '甲', note: '' }, { title: '批二', choice: '乙', note: '尽快' }] });
  const by = Object.fromEntries(r.data.decisions.map((x) => [x.id, x]));
  assert.deepEqual([by.b1.status, by.b1.choice, by.b2.status, by.b2.choice, by.b2.reply], ['sent', '甲', 'sent', '乙', '尽快']);
  const none = async () => { throw new Error('不该发送'); };
  await assert.rejects(A.answerBatch('v3', { answers: [] }, none), (e) => e.code === 'empty-answer');
  await assert.rejects(A.answerBatch('v3', { answers: [{ id: 'b1', choice: '丙' }] }, none), (e) => e.code === 'unknown-option');
  await assert.rejects(A.answerBatch('v3', { answers: [{ id: 'b1', choice: '甲' }, { id: 'b1', choice: '乙' }] }, none), (e) => e.code === 'bad-request');
  await assert.rejects(A.answerBatch('v3', { answers: [{ id: 'b1', choice: '甲' }, { id: 'nope', choice: '甲' }] }, none), (e) => e.code === 'decision-not-found');
  await assert.rejects(A.answerBatch('v3', { answers: [{ id: 'b1', choice: '甲' }] }, async () => { throw new Error('断了'); }), (e) => e.code === 'send-failed');
  assert.equal(A.pageData('v3').decisions.find((x) => x.id === 'b1').choice, '甲');
});

test('api 9 answerBatch：用户留言单独成一项「用户留言：…」，不带命令、不写文件；只有留言也能发', async () => {
  await run('decide', 'add', 'v3', 'm1', ...RC, 'title=留一', 'why=w', 'opt=甲::a', 'opt=乙::b');
  await run('decide', 'add', 'v3', 'm2', ...RC, 'title=留二', 'why=w', 'opt=甲::a', 'opt=乙::b');
  const cmd = 'align ', pf = A.readRegistry().v3;
  const sent = [], rec = async (sid, prompt, card) => { sent.push({ sid, prompt, card }); };
  const r = await A.answerBatch('v3', { answers: [{ id: 'm1', choice: '甲' }, { id: 'm2', choice: '乙', note: '尽快' }, { kind: 'message', text: '  周五前要上线\r\n别动数据库  ' }] }, rec);
  assert.equal(sent[0].sid, 'session-owner');
  assert.equal(sent[0].prompt, [
    '对齐页「三版」上，用户一次发来 3 项，请逐条处理：', '',
    '1. 留一', '   选择：甲', '   处理完运行 ' + cmd + 'decide done v3 m1', '',
    '2. 留二', '   选择：乙', '   备注：尽快', '   处理完运行 ' + cmd + 'decide done v3 m2', '',
    '3. 用户留言：周五前要上线', '   别动数据库', '',
    '某一条处理不了，运行 ' + cmd + 'decide set v3 <决定 id> status=open 改回待决定，并在 why 里写明原因。',
  ].join('\n'));
  assert.deepEqual(sent[0].card.decisions[2], { title: '用户留言', choice: '', note: '周五前要上线\n别动数据库' });
  assert.deepEqual(['m1', 'm2'].map((id) => r.data.decisions.find((x) => x.id === id).status), ['sent', 'sent']);
  // 只有留言：照样发给 owner，页面内容不变
  const snap = A.pageData('v3');
  const r2 = await A.answerBatch('v3', { answers: [{ kind: 'message', text: '有空看看日志' }] }, rec);
  assert.equal(sent[1].prompt, '对齐页「三版」上，用户一次发来 1 项，请逐条处理：\n\n1. 用户留言：有空看看日志');
  assert.deepEqual(sent[1].card, { page: '三版', decisions: [{ title: '用户留言', choice: '', note: '有空看看日志' }] });
  assert.equal(r2.sid, 'session-owner');
  const strip = (d) => ({ ...d, updated: undefined });
  assert.deepEqual(strip(A.pageData('v3')), strip(snap));
  assert.ok(fs.existsSync(pf));
  const none = async () => { throw new Error('不该发送'); };
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: '   ' }] }, none), (e) => e.code === 'empty-answer');
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message' }] }, none), (e) => e.code === 'empty-answer');
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: 'x'.repeat(A.MESSAGE_MAX + 1) }] }, none), (e) => e.code === 'too-long');
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: 'a' }, { kind: 'message', text: 'b' }] }, none), (e) => e.code === 'bad-request');
});

// ---- 留言图片（api 14）：上传存成文件、消息里带本机路径、超限 / 不是图片 / 路径不对都拒 ----
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
test('api 14 留言图片：POST /image 存到 memo-images/<日期>/，按内容去重；只收图片、单张 ≤ 20 MB；/file 给回原图', async () => {
  const h = A.createHandler({ prefix: '', send: async () => {}, guard: () => null, live: null });
  const srv = http.createServer(h);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/p/v3';
  try {
    const up = (body, type = 'image/png') => fetch(base + '/image', { method: 'POST', headers: { 'content-type': type }, body });
    const r1 = await up(PNG1);
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.ok, true);
    assert.equal(j1.type, 'image/png');
    assert.equal(j1.bytes, PNG1.length);
    assert.ok(path.isAbsolute(j1.path));
    const day = A.nowIso().slice(0, 10);
    assert.equal(path.basename(path.dirname(j1.path)), day, '按天分目录');
    assert.equal(fs.realpathSync.native(path.dirname(path.dirname(j1.path))), fs.realpathSync.native(path.join(dir, 'memo-images')), '在插件数据目录下');
    assert.match(path.basename(j1.path), /^[0-9a-f]{16}\.png$/);
    assert.deepEqual(fs.readFileSync(j1.path), PNG1, '原样存下');
    // 同一张图再传一次：同一个文件
    assert.equal((await (await up(PNG1, 'application/octet-stream')).json()).path, j1.path);
    // 声明的类型不算，按文件头认：jpg 头存成 .jpg
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
    assert.match((await (await up(jpg)).json()).path, /\.jpg$/);
    // 不是图片
    const bad = await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { ok: false, code: 'not-image', message: '仅支持 PNG、JPG、WebP、GIF 格式的图片' });
    assert.equal((await up(Buffer.from('{}'), 'application/json')).status, 415);
    // 太大：读完再回 413，一句人话
    const big = await up(Buffer.concat([PNG1, Buffer.alloc(A.MEMO_IMAGE_BYTES)]));
    assert.equal(big.status, 413);
    assert.equal((await big.json()).message, '图片超过 20 MB');
    // 没登记的页面
    assert.equal((await fetch('http://127.0.0.1:' + srv.address().port + '/p/nope/image', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG1 })).status, 404);
    // /file 给回留言图片（不用挂在条目上）；memo-images 外面、穿越出去的不给
    const f = await fetch(base + '/file?path=' + encodeURIComponent(j1.path));
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'image/png');
    assert.match(f.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await f.arrayBuffer()), PNG1);
    const esc = path.join(dir, 'memo-images', day, '..', '..', 'pages.json');
    assert.equal((await fetch(base + '/file?path=' + encodeURIComponent(esc))).status, 403, '穿越出 memo-images 按普通附件查：没挂在页面上');
    const gone = path.join(dir, 'memo-images', day, '0000000000000000.png');
    const g = await fetch(base + '/file?path=' + encodeURIComponent(gone));
    assert.equal(g.status, 404);
    assert.equal((await g.json()).code, 'file-missing');
  } finally { srv.close(); }
});

test('api 14 留言带图：消息里逐行列出本机路径（read_image 能读），卡片写「附图 N 张」；只有图片也能发；超过 5 张、路径不是留言图片都拒', async () => {
  const a = A.saveMemoImage(PNG1).path;
  const b = A.saveMemoImage(Buffer.concat([PNG1, Buffer.from([0])])).path;
  const sent = [], rec = async (sid, prompt, card) => { sent.push({ sid, prompt, card }); };
  await A.answerBatch('v3', { answers: [{ kind: 'message', text: '看这两张\n第二张是报错', images: [a, b, a] }] }, rec);
  assert.equal(sent[0].prompt, [
    '对齐页「三版」上，用户一次发来 1 项，请逐条处理：', '',
    '1. 用户留言：看这两张', '   第二张是报错',
    '   附图 2 张（本机路径，用 read_image 看）：', '   ' + a, '   ' + b,
  ].join('\n'), '路径去重、原样列出');
  assert.deepEqual(sent[0].card.decisions[0], { title: '用户留言', choice: '', note: '看这两张\n第二张是报错\n附图 2 张' });
  // 只有图片
  await A.answerBatch('v3', { answers: [{ kind: 'message', text: '', images: [b] }] }, rec);
  assert.equal(sent[1].prompt, '对齐页「三版」上，用户一次发来 1 项，请逐条处理：\n\n1. 用户留言：（没写字，只有图片）\n   附图 1 张（本机路径，用 read_image 看）：\n   ' + b);
  assert.deepEqual(sent[1].card.decisions[0], { title: '用户留言', choice: '', note: '附图 1 张' });
  const none = async () => { throw new Error('不该发送'); };
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: 'x', images: Array(A.MEMO_IMAGES_MAX + 1).fill(a) }] }, none), (e) => e.code === 'too-many-images' && /最多 5 张/.test(e.message));
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: 'x', images: [path.join(dir, 'pages.json')] }] }, none), (e) => e.code === 'bad-image');
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: 'x', images: [path.join(path.dirname(a), 'ffffffffffffffff.png')] }] }, none), (e) => e.code === 'bad-image');
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: 'x', images: 'a.png' }] }, none), (e) => e.code === 'bad-request');
  await assert.rejects(A.answerBatch('v3', { answers: [{ kind: 'message', text: ' ', images: [] }] }, none), (e) => e.code === 'empty-answer');
});

test('留言图片清理：日期目录比今天早 30 天以上整个删掉（目录里最晚的图也满 30 天）；只删 memo-images 下一层 YYYY-MM-DD 名字的真目录，不跟 junction / 符号链接', () => {
  const root = path.join(dir, 'memo-images');
  const mk = (name, file = 'a.png') => { fs.mkdirSync(path.join(root, name), { recursive: true }); fs.writeFileSync(path.join(root, name, file), PNG1); };
  process.env.ALIGN_NOW = '2026-10-24T12:00:00'; // 不带时区 = 本机时间：哪个时区跑「今天」都是 10-24
  try {
    mk('2026-10-24'); mk('2026-09-24'); mk('2026-09-23'); mk('2025-01-01'); mk('notes');
    fs.mkdirSync(path.join(root, '2026-09-23', 'sub')); fs.writeFileSync(path.join(root, '2026-09-23', 'sub', 'b.png'), PNG1);
    fs.writeFileSync(path.join(root, '2020-01-01'), 'a file named like a day');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'align-memo-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.png'), PNG1);
    fs.symlinkSync(outside, path.join(root, '2020-01-02'), 'junction');
    assert.deepEqual(A.pruneMemoImages().sort(), ['2025-01-01', '2026-09-23']);
    for (const kept of ['2026-10-24', '2026-09-24', 'notes']) assert.ok(fs.existsSync(path.join(root, kept, 'a.png')), kept + ' 留着');
    for (const gone of ['2026-09-23', '2025-01-01']) assert.equal(fs.existsSync(path.join(root, gone)), false, gone + ' 整个删掉（含子目录）');
    assert.ok(fs.statSync(path.join(root, '2020-01-01')).isFile(), '同名文件不动');
    assert.ok(fs.lstatSync(path.join(root, '2020-01-02')).isSymbolicLink(), 'junction 不删');
    assert.ok(fs.existsSync(path.join(outside, 'keep.png')), 'junction 指向的外面目录不动');
    assert.deepEqual(A.pruneMemoImages(), [], '再跑一次没有可删的');
    assert.equal(A.MEMO_KEEP_DAYS, 30);
    fs.rmSync(path.join(root, '2020-01-02')); fs.rmSync(outside, { recursive: true, force: true });
  } finally { delete process.env.ALIGN_NOW; }
});

test('留言图片清理由上传触发：POST /image 存好图、回复之后删过期日期目录，日志记一行 image prune', async () => {
  const root = path.join(dir, 'memo-images');
  fs.mkdirSync(path.join(root, '2026-08-01'), { recursive: true });
  fs.writeFileSync(path.join(root, '2026-08-01', 'old.png'), PNG1);
  const logs = [];
  const h = A.createHandler({ prefix: '', send: async () => {}, guard: () => null, live: null, log: (s) => logs.push(s) });
  const srv = http.createServer(h);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.ALIGN_NOW = '2026-10-24T12:00:00';
  try {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/p/v3/image', { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.concat([PNG1, Buffer.from('prune')]) });
    assert.equal(r.status, 200);
    assert.equal(path.basename(path.dirname((await r.json()).path)), '2026-10-24');
    assert.equal(fs.existsSync(path.join(root, '2026-08-01')), false, '过期目录删掉了');
    assert.ok(logs.includes('image prune 2026-08-01'), logs.join(' | '));
  } finally { delete process.env.ALIGN_NOW; srv.close(); }
});

// ---- 迁移 -------------------------------------------------------------------------------------
const fakeDsh = async (api) => {
  const s = http.createServer((req, res) => {
    if (req.url !== '/alignment/health') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(api === undefined ? { ok: true, app: 'alignment-page' } : { ok: true, app: 'alignment-page', api }));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s;
};
const mkV2 = () => {
  const f = path.join(dir, 'mig.html');
  const u = '2026-10-20T10:00:00+08:00';
  const opt = [{ label: '甲', effect: 'a' }, { label: '乙', effect: 'b' }];
  const data = { version: 2, name: 'mig', title: '迁移页', proj: '其他', owner: 'session-owner', next: '做点事', updated: u, items: [
    { id: 'm-sid', sec: 'doing', title: '按 sid', state: 's', next: 'n', who: 'you', sid: 'session-712ba360-0000-4000-8000-a10000000000', src: '会话甲', proj: '其他', updated: u },
    { id: 'm-title', sec: 'decide', title: '按标题', why: 'w', opt, status: 'sent', choice: '甲', answered: u, proj: 'alpha', src: '会话甲', updated: u },
    { id: 'm-path', sec: 'note', title: '按路径', body: 'b', level: 'warn', proj: '~/.align-test-fake/', updated: u },
    { id: 'm-done-c', sec: 'done', title: '决定完成', choice: '乙', reply: 'r', proj: 'gamma', src: 'x', updated: u },
    { id: 'm-done', sec: 'done', title: '任务完成', result: 'ok', proj: '没有这个项目', src: '会话乙', updated: u },
    { id: 'm-none', sec: 'decide', title: '无主决定', why: 'w', opt, status: 'open', proj: '其他', updated: u },
  ] };
  fs.writeFileSync(f, A.render(data));
  const reg = A.readRegistry();
  reg.mig = f;
  fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify(reg));
  return f;
};

test('migrate --dry-run：汇总 + 逐条列出未归属，不写文件', async () => {
  const f = mkV2();
  const snap = fs.readFileSync(f, 'utf8');
  const out = await run('migrate', 'mig', '--dry-run');
  const lines = out.split('\n');
  assert.match(lines[0], /^预演（没写入）：项目 3 个（Alpha、HomeFake、gamma），轮次 2（进行中 0，等你 1，完成 1），决定 3（open 1，sent 1，done 1），须知 1；未归属 2 条$/);
  assert.deepEqual(lines.slice(1), ['未归属 done/m-done [没有这个项目] 任务完成', '未归属 decide/m-none [其他] 无主决定',
    '补挂轮次：挂上 1 条，挂不上 1 条', '挂上 decide/m-title 按标题 → round/m-sid 按 sid（按会话标题）', '挂不上 decide/m-none 无主决定：没有 sid / src']);
  assert.equal(fs.readFileSync(f, 'utf8'), snap);
});

test('migrate 探测门：3080 api 2 / 无 api / 不通 → 拒绝；api 3 → 写入；--force 跳过', async () => {
  const f = mkV2();
  const snap = fs.readFileSync(f, 'utf8');
  for (const api of [2, undefined]) {
    const s = await fakeDsh(api);
    process.env.DSH_WEB_URL = 'http://127.0.0.1:' + s.address().port;
    try { await rejects(['migrate', 'mig'], /旧插件代码/, f); } finally { s.close(); }
  }
  process.env.DSH_WEB_URL = 'http://127.0.0.1:1';
  await rejects(['migrate', 'mig'], /探测 .* 失败/, f);
  const s = await fakeDsh(3);
  process.env.DSH_WEB_URL = 'http://127.0.0.1:' + s.address().port;
  try {
    const out = await run('migrate', 'mig');
    assert.match(out.split('\n')[0], /^迁移到版本 3：项目 3 个.*未归属 2 条 → /);
  } finally { s.close(); delete process.env.DSH_WEB_URL; }
  const d = read3(f);
  assert.notEqual(fs.readFileSync(f, 'utf8'), snap);
  assert.deepEqual([d.version, d.owner, d.next, d.proj], [3, 'session-owner', '做点事', undefined]);
  const all = Object.fromEntries([...d.rounds, ...d.decisions, ...d.notes].map((x) => [x.id, x]));
  assert.deepEqual([all['m-sid'].proj, all['m-sid'].status, all['m-sid'].stitle, all['m-sid'].started, all['m-sid'].who], ['ws-a', 'waiting', '会话甲', '2026-10-20T10:00:00+08:00', undefined]);
  assert.deepEqual([all['m-title'].proj, all['m-title'].status, all['m-title'].choice, all['m-title'].round], ['ws-a', 'sent', '甲', 'm-sid']);
  assert.deepEqual([all['m-path'].proj, all['m-path'].level], ['ws-h', 'warn']);
  assert.ok(d.decisions.includes(all['m-done-c']) && all['m-done-c'].status === 'done' && all['m-done-c'].proj === 'ws-c');
  assert.ok(d.rounds.includes(all['m-done']) && all['m-done'].status === 'done' && all['m-done'].result === 'ok' && all['m-done'].proj === undefined);
  assert.equal(all['m-none'].proj, undefined);
  await rejects(['migrate', 'mig', '--force'], /已经是版本 3/, f);
  // --force 跳过探测
  mkV2();
  process.env.DSH_WEB_URL = 'http://127.0.0.1:1';
  try { assert.match(await run('migrate', 'mig', '--force'), /^迁移到版本 3/); } finally { delete process.env.DSH_WEB_URL; }
});

test('resolvePageUrl：3080 api >= 页面数据版本才用 3080', async () => {
  for (const [api, version, via] of [[3, 3, /3080/], [3, 2, /3080/], [2, 3, /3390/], [2, 2, /3080/]]) {
    const s = await fakeDsh(api);
    try { assert.match((await A.resolvePageUrl('x', 'http://127.0.0.1:' + s.address().port, version)).via, via, api + '/' + version); } finally { s.close(); }
  }
});

test('workspace 表读不到或形状不对：报错', async () => {
  const keep = process.env.ALIGN_WORKSPACES;
  try {
    process.env.ALIGN_WORKSPACES = path.join(dir, 'nope.json');
    await rejects(['project', 'add', 'v3', '--ws', 'ws-a'], /读不到 workspace 表/);
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ tables: {} }));
    process.env.ALIGN_WORKSPACES = path.join(dir, 'bad.json');
    await rejects(['migrate', 'mig', '--dry-run'], /形状不对/, path.join(dir, 'mig.html'));
  } finally { process.env.ALIGN_WORKSPACES = keep; }
});

// ---- 决定挂轮次：link / 待处理决定 / pending / stale / openDecisionsForSession ----------------------
const cmds = (page, id) => [`align decide done ${page} ${id} 'result=…'`, `align decide set ${page} ${id} 'why=…'`].join(' | ');
const promote = (page, id) => `align decide set ${page} ${id} 'why=…' 'opt=…::…' 'opt=…::…' status=open`;
const fl = path.join(dir, 'link.html');
const O = ['opt=甲::a', 'opt=乙::b'];
const readL = () => read3(fl);

test('link：按 sid / 会话标题 / 轮次标题补挂，歧义和挂不上逐条列出；--dry-run 不写', async () => {
  process.env.ALIGN_NOW = '2026-10-21T08:00:00+08:00'; // 夹具早于后面的 round done，免得被当成「这一轮的产出」
  await run('init', fl, '--name', 'lk', '--title', '补挂页', '--version', '3');
  await run('round', 'add', 'lk', 'a1', '--mode', 'new', ...E, 'title=甲一', 'sid=session-712ba360-0000-4000-8000-a10000000000', 'stitle=会话甲', 'why=w');
  await run('round', 'add', 'lk', 'a2', '--prev', 'a1', '--mode', 'continue', ...E, 'title=甲二', 'why=w');
  await run('round', 'add', 'lk', 'b1', '--mode', 'new', ...E, 'title=乙一', 'sid=session-742ba819-0000-4000-8000-a20000000000', 'stitle=会话乙', 'why=w');
  await run('round', 'add', 'lk', 'c1', '--mode', 'new', '--proj', 'gamma', ...E, 'title=丙一', 'sid=session-05267c2e-0000-4000-8000-c10000000000', 'stitle=重名', 'why=w');
  await run('round', 'add', 'lk', 'c2', '--mode', 'new', '--proj', 'gamma', ...E, 'title=丙二', 'sid=session-04267a9b-0000-4000-8000-c20000000000', 'stitle=重名', 'why=w');
  process.env.ALIGN_NOW = '2026-10-21T09:00:00+08:00'; // 决定比轮次晚 1 小时：不在「这一轮的产出」窗口里
  await run('decide', 'add', 'lk', 'k-sid', ...RC, 'title=按 sid', 'why=w', ...O, 'sid=session-712ba360-0000-4000-8000-a10000000000');
  await run('decide', 'add', 'lk', 'k-src', ...RC, 'title=按会话标题', 'why=w', ...O, 'src=会话乙', '--proj', 'HomeFake');
  await run('decide', 'add', 'lk', 'k-title', ...RC, 'title=按轮次标题', 'why=w', ...O, 'src=乙一');
  await run('decide', 'add', 'lk', 'k-amb', ...RC, 'title=重名', 'why=w', ...O, 'src=重名');
  await run('decide', 'add', 'lk', 'k-none', ...RC, 'title=没对上', 'why=w', ...O, 'src=没这个会话');
  await run('decide', 'add', 'lk', 'k-bare', ...RC, 'title=光秃', 'why=w', ...O);
  await run('decide', 'add', 'lk', 'k-has', ...RC, 'title=已挂', 'why=w', ...O, 'src=会话甲', '--round', 'b1');
  await run('decide', 'add', 'lk', 'k-done', ...RC, 'title=已处理', 'why=w', ...O, 'sid=session-712ba360-0000-4000-8000-a10000000000');
  await run('decide', 'done', 'lk', 'k-done', 'choice=甲');
  const snap = fs.readFileSync(fl, 'utf8');
  assert.deepEqual((await run('link', 'lk', '--dry-run')).split('\n'), [
    '预演（没写入）：补挂轮次：挂上 3 条，挂不上 3 条（其中歧义 1 条）',
    '挂上 decide/k-sid 按 sid → round/a2 甲二（按 sid）',
    '挂上 decide/k-src 按会话标题 → round/b1 乙一（按会话标题）',
    '挂上 decide/k-title 按轮次标题 → round/b1 乙一（按轮次标题）',
    '挂不上 decide/k-amb 重名：歧义：候选 round/c1、round/c2 不在同一条链上',
    '挂不上 decide/k-none 没对上：没有匹配的轮次（src=没这个会话）',
    '挂不上 decide/k-bare 光秃：没有 sid / src',
  ]);
  assert.equal(fs.readFileSync(fl, 'utf8'), snap);
  const before = Object.fromEntries(readL().decisions.map((x) => [x.id, x.updated]));
  assert.match(await run('link', 'lk'), /^补挂轮次：挂上 3 条，挂不上 3 条（其中歧义 1 条） → .*link\.html\n挂上 decide\/k-sid /);
  const d = Object.fromEntries(readL().decisions.map((x) => [x.id, x]));
  assert.deepEqual(['k-sid', 'k-src', 'k-title', 'k-has', 'k-amb', 'k-none', 'k-bare', 'k-done'].map((k) => d[k].round), ['a2', 'b1', 'b1', 'b1', undefined, undefined, undefined, undefined]);
  assert.deepEqual([d['k-sid'].proj, d['k-src'].proj], ['ws-a', 'ws-a'], 'proj 跟着轮次');
  for (const x of Object.values(d)) assert.equal(x.updated, before[x.id], '补挂不改决定的 updated: ' + x.id);
  const snap2 = fs.readFileSync(fl, 'utf8');
  assert.equal((await run('link', 'lk')).split('\n')[0], '补挂轮次：挂上 0 条，挂不上 3 条（其中歧义 1 条）');
  assert.equal(fs.readFileSync(fl, 'utf8'), snap2, '没有可挂的就不写');
  await rejects(['link', 't1'], /先运行 align migrate t1/, file);
});

test('round add --prev / round done：追加该轮及前序轮次上待处理的决定', async () => {
  await run('decide', 'add', 'lk', 'k-a1', ...RC, 'title=挂第一轮', 'why=w', ...O, '--round', 'a1');
  await run('decide', 'set', 'lk', 'k-title', 'status=sent', 'choice=甲');
  delete process.env.ALIGN_NOW;
  const add = (await run('round', 'add', 'lk', 'a3', '--prev', 'a2', '--mode', 'continue', ...E, 'title=甲三', 'why=w')).split('\n');
  assert.match(add[0], /^项目 Alpha：新增一轮 a3（续发，接 a2）；上一轮 a2 改为完成 → /);
  assert.deepEqual(add.slice(1), ['待处理决定 k-sid [open] 按 sid → ' + cmds('lk', 'k-sid'), '待处理决定 k-a1 [open] 挂第一轮 → ' + cmds('lk', 'k-a1')]);
  const done = (await run('round', 'done', 'lk', 'round/b1', 'result=好了', 'visual=false')).split('\n');
  assert.match(done[0], /^round\/b1 → 完成 → /);
  assert.deepEqual(done.slice(1), ['待处理决定 k-src [open] 按会话标题 → ' + cmds('lk', 'k-src'), '待处理决定 k-title [sent] 按轮次标题 → ' + cmds('lk', 'k-title'), '待处理决定 k-has [open] 已挂 → ' + cmds('lk', 'k-has')]);
  assert.equal((await run('round', 'done', 'lk', 'c1', 'visual=false')).split('\n').length, 1, '没有待处理决定就不追加');
  assert.equal((await run('round', 'add', 'lk', 'c3', '--prev', 'c2', '--mode', 'continue', ...E, 'title=丙三', 'why=w')).split('\n').length, 1);
});

test('pending（等信息）：可缺 why/opt、提升时校验、不计数、手机不给、round done 提示提升命令', async () => {
  const openN = () => A.listPages().find((p) => p.name === 'lk').decisions;
  const n0 = openN();
  process.env.ALIGN_NOW = '2026-10-21T08:00:00+08:00';
  assert.match(await run('decide', 'add', 'lk', 'p1', 'title=跑完再定', '--pending', '--round', 'a3'), /^加了 decide\/p1（项目 Alpha）/);
  const p1 = readL().decisions.find((x) => x.id === 'p1');
  assert.deepEqual([p1.status, p1.why, p1.opt, p1.round, p1.proj], ['pending', undefined, undefined, 'a3', 'ws-a']);
  assert.match(await run('decide', 'add', 'lk', 'p2', 'title=无主等信息', 'status=pending', 'why=还在查', ...O), /^加了 decide\/p2/);
  await rejects(['decide', 'add', 'lk', 'p3', 'title=x', '--pending', 'opt=只有一个::z'], /至少 2 个选项/, fl);
  await rejects(['decide', 'add', 'lk', 'p3', 'title=x', '--pending', 'status=open'], /冲突/, fl);
  await rejects(['decide', 'set', 'lk', 'p1', 'status=open', ...RC], /缺必填字段 why/, fl);
  await rejects(['decide', 'set', 'lk', 'p1', 'status=open', ...RC, 'why=齐了', 'opt=甲::a'], /至少 2 个选项/, fl);
  assert.equal(openN(), n0, 'pending 不算待决定');
  const v = A.legacyView(readL());
  assert.ok(!v.items.some((x) => x.id === 'p1' || x.id === 'p2'), '手机不给 pending');
  await assert.rejects(A.answerDecision('lk', { id: 'p1', choice: '甲' }, async () => {}), (e) => e.code === 'decision-not-found');
  const pendLine = '待补信息的决定 p1 跑完再定 → 补全选项后提升：' + promote('lk', 'p1');
  delete process.env.ALIGN_NOW;
  const add = (await run('round', 'add', 'lk', 'a4', '--prev', 'a3', '--mode', 'continue', ...E, 'title=甲四', 'why=w')).split('\n');
  assert.deepEqual(add.slice(1), ['待处理决定 k-sid [open] 按 sid → ' + cmds('lk', 'k-sid'), '待处理决定 k-a1 [open] 挂第一轮 → ' + cmds('lk', 'k-a1'), pendLine]);
  const done = (await run('round', 'done', 'lk', 'a4', 'result=跑完', 'visual=false')).split('\n');
  assert.equal(done[3], pendLine);
  assert.match(await run('decide', 'set', 'lk', 'p1', 'status=open', ...RC, 'why=齐了', ...O), /^改了 decide\/p1 的 opt,status,risk,cat,why/);
  assert.equal(openN(), n0 + 1, '提升后进决定栏');
});

const fs5 = path.join(dir, 'stale.html');
const T = (h) => '2026-10-21T' + h + ':00:00+08:00';
test('stale：轮次已完成 / 之后有新一轮 / 会话在决定之后收到用户直接消息；pending 也查', async () => {
  const opt = [{ label: '甲', effect: 'a' }, { label: '乙', effect: 'b' }];
  const dec = (id, extra) => ({ id, title: '决定 ' + id, why: 'w', opt, status: 'open', updated: T('12'), ...extra });
  fs.writeFileSync(fs5, A.render({ version: 3, name: 'sp', title: '过时页', updated: T('12'), projects: [], rounds: [
    { id: 's1', title: '一', status: 'done', sid: 'session-854e551e-0000-4000-8000-100000000000', started: T('09'), updated: T('11') },
    { id: 's2', title: '二', status: 'doing', sid: 'session-844e538b-0000-4000-8000-200000000000', started: T('10'), updated: T('10') },
    { id: 's3', title: '三', status: 'doing', sid: 'session-834e51f8-0000-4000-8000-300000000000', prev: 's2', prevSid: 'session-844e538b-0000-4000-8000-200000000000', started: T('13'), updated: T('13') },
    { id: 's4', title: '四', status: 'doing', sid: 'session-8a4e5cfd-0000-4000-8000-400000000000', started: T('10'), updated: T('10') },
  ], decisions: [
    dec('x-done', { round: 's1', updated: T('10') }), dec('x-next', { round: 's2' }), dec('x-early', { round: 's2', updated: T('14') }),
    dec('x-user', { round: 's4' }), dec('x-old', { sid: 'session-894e5b6a-0000-4000-8000-500000000000', updated: T('14') }), dec('x-chain', { round: 's3', status: 'sent', updated: T('14') }),
    dec('x-gone', { round: 'gone' }), { id: 'x-pend', title: '决定 x-pend', status: 'pending', round: 's1', updated: T('10') },
    dec('x-result', { round: 's1', updated: T('11') }), // 轮次 11:00 完成时刚写的：这一轮的产出，不算过时
    dec('x-closed', { round: 's1', status: 'done', choice: '甲' }),
  ], notes: [] }));
  const reg = A.readRegistry();
  fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify({ ...reg, sp: fs5 }));
  assert.deepEqual((await run('stale', 'sp')).split('\n'), [
    '过时决定 x-done [open] 决定 x-done：轮次 s1 已完成 → ' + cmds('sp', 'x-done'),
    '过时决定 x-next [open] 决定 x-next：轮次 s2 之后有新一轮 s3（10-21 13:00 开始） → ' + cmds('sp', 'x-next'),
    '过时决定 x-gone [open] 决定 x-gone：轮次 gone 已不在页面上 → ' + cmds('sp', 'x-gone'),
    `过时决定 x-pend [pending] 决定 x-pend：轮次 s1 已完成 → align decide done sp x-pend 'result=…' | ` + promote('sp', 'x-pend'),
  ]);
  const out = (await run('stale', 'sp', '--since-user', 'session-8a4e5cfd-0000-4000-8000-400000000000=' + T('13') + ',session-894e5b6a-0000-4000-8000-500000000000=' + T('13') + ', session-844e538b-0000-4000-8000-200000000000=' + T('15'))).split('\n');
  assert.deepEqual(out.map((l) => l.split(' ')[1]), ['x-done', 'x-next', 'x-early', 'x-user', 'x-chain', 'x-gone', 'x-pend']);
  assert.match(out[1], /：轮次 s2 之后有新一轮 s3（10-21 13:00 开始）；会话 session-844e538b-0000-4000-8000-200000000000 在决定更新后收到过用户直接消息 → /);
  assert.match(out[3], /^过时决定 x-user \[open\] 决定 x-user：会话 session-8a4e5cfd-0000-4000-8000-400000000000 在决定更新后收到过用户直接消息 → /);
  assert.match(out[4], /^过时决定 x-chain \[sent\] 决定 x-chain：会话 session-844e538b-0000-4000-8000-200000000000 在决定更新后收到过用户直接消息 → /);
  await rejects(['stale', 'sp', '--since-user', 'session-8a4e5cfd-0000-4000-8000-400000000000'], /--since-user 要写成/, fs5);
  await rejects(['stale', 'sp', '--since-user', 'session-8a4e5cfd-0000-4000-8000-400000000000=昨天'], /--since-user 要写成/, fs5);
  await rejects(['stale', 't1'], /先运行 align migrate t1/, file);
  await run('init', path.join(dir, 'empty.html'), '--name', 'emp', '--title', '空页', '--version', '3');
  assert.equal(await run('stale', 'emp'), '没有过时的决定');
});

test('openDecisionsForSession：按 sid / 轮次 prev 链关联，含 pending，跳过版本 2，读页面出错直接抛', async () => {
  await run('add', 't1', 'decide', 'ofd-v2', 'title=v2 决定', 'why=w', ...O, 'sid=session-8a4e5cfd-0000-4000-8000-400000000000');
  const ids = (sid) => A.openDecisionsForSession(sid).map((x) => x.page + '/' + x.id);
  assert.deepEqual(ids('session-844e538b-0000-4000-8000-200000000000'), ['sp/x-next', 'sp/x-early', 'sp/x-chain'], '轮次 sid 与后续轮的 prevSid 都算');
  assert.deepEqual(ids('session-834e51f8-0000-4000-8000-300000000000'), ['sp/x-chain']);
  assert.deepEqual(ids('session-8a4e5cfd-0000-4000-8000-400000000000'), ['sp/x-user'], '版本 2 页面跳过');
  assert.deepEqual(A.openDecisionsForSession('session-894e5b6a-0000-4000-8000-500000000000'), [{ page: 'sp', pageTitle: '过时页', id: 'x-old', title: '决定 x-old', status: 'open', cmds: cmds('sp', 'x-old').split(' | ') }]);
  assert.deepEqual(A.openDecisionsForSession('session-854e551e-0000-4000-8000-100000000000'), [
    { page: 'sp', pageTitle: '过时页', id: 'x-done', title: '决定 x-done', status: 'open', round: 's1', cmds: cmds('sp', 'x-done').split(' | ') },
    { page: 'sp', pageTitle: '过时页', id: 'x-pend', title: '决定 x-pend', status: 'pending', round: 's1', cmds: [`align decide done sp x-pend 'result=…'`, promote('sp', 'x-pend')] },
    { page: 'sp', pageTitle: '过时页', id: 'x-result', title: '决定 x-result', status: 'open', round: 's1', cmds: cmds('sp', 'x-result').split(' | ') }, // 这一轮的产出照样要提醒
  ]);
  assert.deepEqual(A.openDecisionsForSession('session-86496ca9-0000-4000-8000-bd0000000000'), []);
  assert.throws(() => A.openDecisionsForSession(''), A.UsageError);
  const reg = A.readRegistry();
  fs.writeFileSync(path.join(dir, 'broken.html'), '<html>没有数据块</html>');
  fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify({ ...reg, broken: path.join(dir, 'broken.html') }));
  try { assert.throws(() => A.openDecisionsForSession('session-844e538b-0000-4000-8000-200000000000'), /align-data/); } finally { fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify(reg)); }
});

test('这一轮的产出：调研轮次完成前刚建的决定，round done 不列为待处理、stale 不算过时', async () => {
  const f = path.join(dir, 'result.html');
  await run('init', f, '--name', 'rs', '--title', '产出页', '--version', '3');
  await run('round', 'add', 'rs', 'r1', '--mode', 'new', '--proj', 'HomeFake', ...E, 'title=调研', 'sid=session-814c103b-0000-4000-8000-100000000000', 'why=w');
  await run('decide', 'add', 'rs', 'pick', ...RC, 'title=选哪个', 'why=调研结果', 'opt=甲::a', 'opt=乙::b', '--round', 'r1');
  assert.equal((await run('round', 'done', 'rs', 'r1', 'result=查完了', 'visual=false')).split('\n').length, 1, '刚建的决定不算待处理');
  assert.equal(await run('stale', 'rs'), '没有过时的决定');
});

// ---- api 5：轮次 eta / paused / dropped、页面发来的轮次操作与须知已了解 ----------------------------
const f6 = path.join(dir, 'v5.html');
const R6 = (id) => read3(f6).rounds.find((x) => x.id === id);
const N6 = (id) => read3(f6).notes.find((x) => x.id === id);
const at = (h) => '2026-10-22T' + h + ':00:00+08:00';
const setNow = (h) => { process.env.ALIGN_NOW = at(h); };
const none = async () => { throw new Error('不该发送'); };

test('api 5 round add：eta / eta75 / etaconf 必填，时长格式校验；round set 可改', async () => {
  await run('init', f6, '--name', 'v5', '--title', '五版', '--owner', 'session-owner', '--version', '3');
  const base = ['round', 'add', 'v5', 'e1', '--mode', 'new', '--proj', 'HomeFake', 'title=估时', 'sid=session-09358d04-0000-4000-8000-e10000000000', 'why=w'];
  await rejects([...base, 'eta75=1h', 'etaconf=中'], /缺 eta=.*40m、1h15m、2h/, f6);
  await rejects([...base, 'eta=40m', 'etaconf=中'], /缺 eta75=/, f6);
  await rejects([...base, 'eta=40m', 'eta75=1h'], /缺 etaconf=/, f6);
  for (const bad of ['40', '1h15', 'h', '40min', '1.5h', 'm40']) await rejects([...base, 'eta=' + bad, 'eta75=1h', 'etaconf=中'], /eta 要写成时长/, f6);
  await rejects([...base, 'eta=40m', 'eta75=90', 'etaconf=中'], /eta75 要写成时长/, f6);
  await rejects([...base, ...E, 'etaadj=半小时'], /etaadj 要写成时长/, f6);
  await rejects([...base, 'eta=40m', 'eta75=1h', 'etaconf=很高'], /etaconf 只能是 高 \| 中 \| 低/, f6);
  await rejects([...base, ...E, 'status=paused'], /新一轮的 status 只能是 doing（/, f6);
  assert.match(await run(...base, 'eta=1h15m', 'eta75=2h', 'etaconf=低', 'etaadj=90m', 'etanote=上次同类多花了一倍'), /^项目 HomeFake：新增一轮 e1/);
  let r = R6('e1');
  assert.deepEqual([r.eta, r.eta75, r.etaconf, r.etaadj, r.etanote, r.ended], ['1h15m', '2h', '低', '90m', '上次同类多花了一倍', undefined]);
  assert.match(await run('round', 'set', 'v5', 'e1', 'eta=50m', 'etaconf=高', 'etaadj=', 'etanote='), /^改了 round\/e1 的 eta,etaconf,etaadj,etanote/);
  r = R6('e1');
  assert.deepEqual([r.eta, r.eta75, r.etaconf, r.etaadj, r.etanote], ['50m', '2h', '高', undefined, undefined]);
  await rejects(['round', 'set', 'v5', 'e1', 'eta75=2小时'], /eta75 要写成时长/, f6);
  await rejects(['round', 'set', 'v5', 'e1', 'ended=' + at('10')], /CLI 维护/, f6);
  await rejects(['round', 'set', 'v5', 'e1', 'ask=done'], /由页面写入/, f6);
});

test('api 5 paused / dropped：进入 done|dropped 写 ended，改回删掉；--prev 不动已放弃的上一轮；旧命令同样维护', async () => {
  setNow('10');
  try {
    await run('round', 'add', 'v5', 's1', '--mode', 'new', '--proj', 'HomeFake', 'title=一', 'sid=session-854e551e-0000-4000-8000-100000000000', 'why=w', ...E);
    setNow('11');
    assert.match(await run('round', 'set', 'v5', 's1', 'status=paused'), /^改了 round\/s1 的 status/);
    assert.deepEqual([R6('s1').status, R6('s1').ended, R6('s1').pauses], ['paused', undefined, [{ from: at('11') }]], '进入暂缓开一段 pauses');
    setNow('12');
    await run('round', 'set', 'v5', 's1', 'status=dropped', 'result=不做了');
    assert.deepEqual([R6('s1').status, R6('s1').ended, R6('s1').result, R6('s1').pauses], ['dropped', at('12'), '不做了', [{ from: at('11'), to: at('12') }]], '暂缓中直接放弃：这一段在 ended 收尾');
    await rejects(['round', 'done', 'v5', 's1'], /已经放弃/, f6);
    setNow('13');
    await run('round', 'set', 'v5', 's1', 'status=done', 'visual=false');
    assert.equal(R6('s1').ended, at('12'), 'done 与 dropped 之间互换不改 ended');
    await run('round', 'set', 'v5', 's1', 'status=doing');
    assert.deepEqual([R6('s1').status, R6('s1').ended], ['doing', undefined]);
    setNow('14');
    assert.match(await run('round', 'done', 'v5', 's1', 'result=好了', 'visual=false'), /^round\/s1 → 完成/);
    assert.deepEqual([R6('s1').status, R6('s1').ended], ['done', at('14')]);
    await run('round', 'add', 'v5', 's2', '--mode', 'new', '--proj', 'HomeFake', 'title=二', 'sid=session-844e538b-0000-4000-8000-200000000000', 'why=w', ...E);
    setNow('15');
    assert.match(await run('round', 'add', 'v5', 's3', '--prev', 's2', '--mode', 'continue', 'title=三', 'why=w', ...E), /上一轮 s2 改为完成/);
    assert.deepEqual([R6('s2').status, R6('s2').ended], ['done', at('15')]);
    await run('round', 'set', 'v5', 's3', 'status=dropped');
    assert.doesNotMatch(await run('round', 'add', 'v5', 's4', '--prev', 's3', '--mode', 'continue', 'title=四', 'why=w', ...E), /改为完成/);
    assert.deepEqual([R6('s3').status, R6('s3').ended], ['dropped', at('15')]);
    await run('round', 'set', 'v5', 's4', 'status=paused');
    await run('add', 'v5', 'done', 's5', 'title=旧命令完成', 'proj=HomeFake', 'visual=false');
    assert.deepEqual([R6('s5').status, R6('s5').ended], ['done', at('15')]);
    await run('set', 'v5', 's5', 'who=agent');
    assert.deepEqual([R6('s5').status, R6('s5').ended], ['doing', undefined]);
    assert.deepEqual((await run('ls', 'v5', 'doing')).split('\n').map((l) => l.split(' ')[0]), ['round/e1', 'round/s4', 'round/s5']);
    assert.deepEqual((await run('ls', 'v5', 'done')).split('\n').map((l) => l.split(' ')[0]), ['round/s1', 'round/s2', 'round/s3']);
    assert.match(await run('project', 'ls', 'v5'), /轮次 6（未完成 3）/);
  } finally { delete process.env.ALIGN_NOW; }
});

test('api 15 pauses：进出暂缓记时段，--prev 收尾一起收；不能手写；校验格式；3080 是旧插件时不记并说明', async () => {
  setNow('10');
  try {
    await run('round', 'add', 'v5', 'q1', '--mode', 'new', '--proj', 'HomeFake', 'title=暂缓过', 'sid=session-f1537c50-0000-4000-8000-100000000000', 'why=w', ...E);
    setNow('11');
    await run('round', 'set', 'v5', 'q1', 'status=paused');
    setNow('12');
    await run('round', 'set', 'v5', 'q1', 'status=paused', 'state=还在等');
    assert.deepEqual(R6('q1').pauses, [{ from: at('11') }], '已经暂缓时再改 paused 不另开一段');
    setNow('13');
    await run('round', 'set', 'v5', 'q1', 'status=doing');
    setNow('14');
    await run('round', 'set', 'v5', 'q1', 'state=又做了一点');
    assert.deepEqual(R6('q1').pauses, [{ from: at('11'), to: at('13') }], '恢复时收尾，其他修改不动');
    setNow('15');
    await run('round', 'set', 'v5', 'q1', 'status=paused');
    setNow('16');
    assert.match(await run('round', 'add', 'v5', 'q2', '--prev', 'q1', '--mode', 'continue', 'title=接着做', 'why=w', ...E), /上一轮 q1 改为完成/);
    assert.deepEqual(R6('q1').pauses, [{ from: at('11'), to: at('13') }, { from: at('15'), to: at('16') }], '--prev 收尾暂缓中的上一轮：暂缓段在 ended 收尾');
    assert.equal(R6('q2').pauses, undefined);
    await rejects(['round', 'set', 'v5', 'q2', 'pauses=x'], /由 CLI 维护/, f6);
    await rejects(['round', 'set', 'v5', 'q2', 'untimed=true'], /由 CLI 维护/, f6);
    // 校验：只有暂缓中的轮次最后一段可以没有 to；按时间排序；只有 from / to
    const page = read3(f6), bad = (r) => { const d = structuredClone(page); Object.assign(d.rounds.find((x) => x.id === 'q2'), r); return () => A.validate(d); };
    assert.throws(bad({ pauses: [{ from: at('16') }] }), /只有暂缓中的轮次/);
    assert.throws(bad({ pauses: [{ from: at('16'), to: at('15') }] }), /按时间排序/);
    assert.throws(bad({ pauses: [{ from: at('13'), to: at('14') }, { from: at('11'), to: at('12') }] }), /按时间排序/);
    assert.throws(bad({ pauses: [{ from: at('11'), to: at('12'), why: 'x' }] }), /pauses 没有字段 why/);
    assert.throws(bad({ pauses: [] }), /非空数组/);
    assert.throws(bad({ untimed: 'yes' }), /untimed 只能是 true/);
    bad({ status: 'paused', pauses: [{ from: at('11'), to: at('12') }, { from: at('15') }], untimed: 'true' })();
    // 3080 里是旧插件：status 照改、不写 pauses，输出说明怎么补
    A.probes.pauseApi = async () => false;
    try {
      setNow('17');
      const out = await run('round', 'set', 'v5', 'q2', 'status=paused');
      assert.match(out, /\n没记暂缓时刻：3080 里的对齐页插件还是旧版（api < 15）.*backfill-pauses\.mjs <页>/);
      assert.deepEqual([R6('q2').status, R6('q2').pauses], ['paused', undefined]);
      assert.doesNotMatch(await run('round', 'set', 'v5', 'q2', 'status=doing'), /没记暂缓/, '不是改成 paused 的命令不探测、不说明');
    } finally { A.probes.pauseApi = async () => true; }
  } finally { delete process.env.ALIGN_NOW; }
});

test('api 5 裁剪：accepted 与 dropped 合计留 40（按 updated），paused 不裁', async () => {
  const f = path.join(dir, 'prune5.html');
  const ts = (i) => '2026-10-01T00:00:' + String(i).padStart(2, '0') + '+08:00';
  const data = { version: 3, name: 'prune5', title: 'p', projects: [], rounds: [], decisions: [], notes: [] };
  for (let i = 0; i < 45; i++) data.rounds.push({ id: 'r' + i, title: 't', status: i % 3 ? 'accepted' : 'dropped', updated: ts(i) });
  for (let i = 0; i < 5; i++) data.rounds.push({ id: 'p' + i, title: 't', status: 'paused', updated: ts(i) });
  fs.writeFileSync(f, A.render(data));
  await run('note', 'add', f, 'n', 'title=x');
  const d = read3(f);
  assert.equal(d.rounds.filter((x) => x.status === 'accepted' || x.status === 'dropped').length, 40);
  assert.deepEqual(['r3', 'r4', 'r5', 'r6'].map((id) => d.rounds.some((x) => x.id === id)), [false, false, true, true]);
  assert.equal(d.rounds.filter((x) => x.status === 'paused').length, 5);
});

test('api 5 dropped 和 done 一样算已结束：stale、待处理决定、这一轮的产出', async () => {
  const f = path.join(dir, 'drop.html');
  const opt = [{ label: '甲', effect: 'a' }, { label: '乙', effect: 'b' }];
  fs.writeFileSync(f, A.render({ version: 3, name: 'dp', title: '放弃页', updated: T('12'), projects: [], rounds: [
    { id: 'q1', title: '一', status: 'dropped', sid: 'session-f1537c50-0000-4000-8000-100000000000', started: T('09'), updated: T('11'), ended: T('11') },
  ], decisions: [
    { id: 'q-old', title: '旧', why: 'w', opt, status: 'open', round: 'q1', updated: T('09') },
    { id: 'q-res', title: '产出', why: 'w', opt, status: 'open', round: 'q1', updated: T('11') },
  ], notes: [] }));
  fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify({ ...A.readRegistry(), dp: f }));
  assert.deepEqual((await run('stale', 'dp')).split('\n'), ['过时决定 q-old [open] 旧：轮次 q1 已放弃 → ' + cmds('dp', 'q-old')]);
  assert.deepEqual(A.pendingLines(A.pageData('dp'), 'q1', 'dp'), ['待处理决定 q-old [open] 旧 → ' + cmds('dp', 'q-old')]);
});

test('api 5 legacyView：paused → 进行中「已暂缓」，dropped → 最近完成「已放弃：…」', () => {
  const v = A.legacyView({ version: 3, name: 'lv', title: 'lv', projects: [], rounds: [
    { id: 'pa', title: '暂缓的', status: 'paused', state: '做到一半', sid: 's', updated: T('10') },
    { id: 'dr', title: '放弃的', status: 'dropped', result: '不需要了', updated: T('11'), ended: T('11') },
    { id: 'dn', title: '光放弃', status: 'dropped', updated: T('12'), ended: T('12') },
  ], decisions: [], notes: [{ id: 'nt', title: '须知', acked: T('10') }] });
  A.validate(v);
  const by = Object.fromEntries(v.items.map((x) => [x.id, x]));
  assert.deepEqual([by.pa.sec, by.pa.state, by.pa.who, by.pa.sid], ['doing', '已暂缓', 'agent', 's']);
  assert.deepEqual([by.dr.sec, by.dr.result], ['done', '已放弃：不需要了']);
  assert.deepEqual([by.dn.sec, by.dn.result], ['done', '已放弃']);
  assert.equal(by.nt.sec, 'note');
});

test('api 5 answerBatch：决定 + 轮次操作 + 须知已了解合成一条消息（全文与卡片）；轮次只记 ask 不改 status，CLI 改 status 时清掉', async () => {
  setNow('16');
  try {
    await run('round', 'add', 'v5', 'w1', '--mode', 'new', '--proj', 'HomeFake', 'title=等你', 'sid=session-fd580c62-0000-4000-8000-100000000000', 'why=w', ...E);
    await run('decide', 'add', 'v5', 'a-d', ...RC, 'title=批决定', 'why=w', ...O);
    await run('decide', 'add', 'v5', 'a-p', 'title=等信息', '--pending', '--round', 'w1');
    await run('note', 'add', 'v5', 'a-n1', 'title=须知一');
    await run('note', 'add', 'v5', 'a-n2', 'title=须知二');
    setNow('17');
    const sent = [];
    const r = await A.answerBatch('v5', { answers: [
      { id: 'a-d', choice: '甲', note: '就它' },
      { kind: 'round', id: 'e1', action: 'done', note: ' 我看过了 ' },
      { kind: 'round', id: 'w1', action: 'dropped' },
      { kind: 'round', id: 's4', action: 'resume' },
      { kind: 'note', id: 'a-n1', ack: true, note: '这条以后别提' },
      { kind: 'note', id: 'a-n2', ack: true },
    ] }, async (sid, prompt, card) => { sent.push({ sid, prompt, card }); });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sid, 'session-owner');
    const cmd = 'align ';
    assert.equal(sent[0].prompt, [
      '对齐页「五版」上，用户一次发来 5 项，请逐条处理：', '',
      '1. 批决定', '   选择：甲', '   备注：就它', '   处理完运行 ' + cmd + 'decide done v5 a-d', '',
      '2. 轮次「估时」（e1）', '   用户选择：已完成', '   备注：我看过了', '   处理完运行 ' + cmd + 'round done v5 e1 result=… visual=true|false', '',
      '3. 轮次「等你」（w1）', '   用户选择：放弃', '   处理完运行 ' + cmd + 'round set v5 w1 status=dropped result=<放弃原因>', '',
      '4. 轮次「四」（s4）', '   用户选择：恢复', '   处理完运行 ' + cmd + 'round set v5 s4 status=doing', '',
      '5. 须知「须知一」', '   用户已了解', '   备注：这条以后别提', '   需要时 note set 或 note del 处理（' + cmd + 'note set v5 a-n1 … / note del v5 a-n1）', '',
      '某一条处理不了：决定运行 ' + cmd + 'decide set v5 <决定 id> status=open 改回待决定，并在 why 里写明原因；轮次运行 ' + cmd + 'round set v5 <轮次 id> status=<原状态> 恢复原状态，并在 state 里写明原因。',
    ].join('\n'));
    assert.deepEqual(sent[0].card, { page: '五版', decisions: [
      { title: '批决定', choice: '甲', note: '就它' }, { title: '轮次：估时', choice: '已完成', note: '我看过了' },
      { title: '轮次：等你', choice: '放弃', note: '' }, { title: '轮次：四', choice: '恢复', note: '' },
      { title: '须知：须知一', choice: '已了解', note: '这条以后别提' },
    ] });
    const rd = (id) => r.data.rounds.find((x) => x.id === id), nt = (id) => r.data.notes.find((x) => x.id === id);
    assert.deepEqual([r.sid, r.data.decisions.find((x) => x.id === 'a-d').status], ['session-owner', 'sent']);
    assert.deepEqual(['e1', 'w1', 's4'].map((id) => [rd(id).status, rd(id).ask, rd(id).asknote, rd(id).asked, rd(id).updated]), [
      ['doing', 'done', '我看过了', at('17'), at('17')], ['doing', 'dropped', undefined, at('17'), at('17')], ['paused', 'resume', undefined, at('17'), at('17')]]);
    assert.deepEqual(['a-n1', 'a-n2'].map((id) => [nt(id).acked, nt(id).updated]), [[at('17'), at('16')], [at('17'), at('16')]]);
    setNow('18');
    await run('round', 'set', 'v5', 's4', 'state=接着做');
    assert.equal(R6('s4').ask, 'resume', '不改 status 的 round set 不清 ask');
    await run('round', 'set', 'v5', 's4', 'status=doing');
    await run('round', 'done', 'v5', 'e1', 'result=验过了', 'visual=false');
    await run('round', 'set', 'v5', 'w1', 'status=dropped', 'result=不需要了');
    for (const id of ['s4', 'e1', 'w1']) assert.deepEqual([R6(id).ask, R6(id).asknote, R6(id).asked], [undefined, undefined, undefined], id);
    assert.deepEqual([R6('e1').ended, R6('w1').ended, R6('s4').ended], [at('18'), at('18'), undefined]);
    assert.match(await run('note', 'set', 'v5', 'a-n1', 'acked='), /^改了 note\/a-n1 的 acked/);
    assert.equal(N6('a-n1').acked, undefined);
    await rejects(['note', 'set', 'v5', 'a-n1', 'acked=' + at('18')], /acked= 清掉/, f6);
  } finally { delete process.env.ALIGN_NOW; }
});

test('api 5 answerBatch：只有不带备注的已了解时不发消息、不要 owner；只有轮次时首末行；恢复为未读', async () => {
  const fo = path.join(dir, 'v5n.html');
  await run('init', fo, '--name', 'v5n', '--title', '无主页', '--version', '3');
  await run('note', 'add', 'v5n', 'k1', 'title=看一眼');
  await run('round', 'add', 'v5n', 'k-r', '--mode', 'new', '--proj', 'HomeFake', 'title=无主轮', 'sid=session-81515b53-0000-4000-8000-000000000000', 'why=w', ...E);
  setNow('19');
  try {
    let r = await A.answerBatch('v5n', { answers: [{ kind: 'note', id: 'k1', ack: true, note: '  ' }] }, none);
    assert.deepEqual([r.sid, r.data.notes[0].acked], [undefined, at('19')]);
    r = await A.answerBatch('v5n', { answers: [{ kind: 'note', id: 'k1', ack: false }] }, none);
    assert.equal(r.data.notes[0].acked, undefined);
    const snap = fs.readFileSync(fo, 'utf8');
    await assert.rejects(A.answerBatch('v5n', { answers: [{ kind: 'note', id: 'k1', ack: true, note: '有话说' }] }, none), (e) => e.code === 'no-target-session' && e.status === 400);
    await assert.rejects(A.answerBatch('v5n', { answers: [{ kind: 'round', id: 'k-r', action: 'paused' }] }, none), (e) => e.code === 'no-target-session');
    assert.equal(fs.readFileSync(fo, 'utf8'), snap);
    r = await A.answerBatch('v5', { answers: [{ kind: 'note', id: 'a-n2', ack: false }] }, none);
    assert.equal(r.data.notes.find((x) => x.id === 'a-n2').acked, undefined, '有 owner 的页面只取消已了解也不发');
  } finally { delete process.env.ALIGN_NOW; }
  await run('round', 'add', 'v5', 'p1', '--mode', 'new', '--proj', 'HomeFake', 'title=要暂缓', 'sid=session-8d50a04d-0000-4000-8000-100000000000', 'why=w', ...E);
  const sent = [];
  await A.answerBatch('v5', { answers: [{ kind: 'round', id: 'p1', action: 'paused', note: '先放放' }, { kind: 'note', id: 'a-n1', ack: false, note: '还没看懂' }] }, async (sid, prompt, card) => { sent.push({ prompt, card }); });
  const cmd = 'align ';
  assert.deepEqual(sent[0].prompt.split('\n'), [
    '对齐页「五版」上，用户一次发来 2 项，请逐条处理：', '',
    '1. 轮次「要暂缓」（p1）', '   用户选择：暂缓', '   备注：先放放', '   处理完运行 ' + cmd + 'round set v5 p1 status=paused', '',
    '2. 须知「须知一」', '   用户把它恢复为未读', '   备注：还没看懂', '   需要时 note set 或 note del 处理（' + cmd + 'note set v5 a-n1 … / note del v5 a-n1）', '',
    '某一条处理不了，运行 ' + cmd + 'round set v5 <轮次 id> status=<原状态> 恢复原状态，并在 state 里写明原因。',
  ]);
  assert.deepEqual(sent[0].card.decisions.map((x) => [x.title, x.choice, x.note]), [['轮次：要暂缓', '暂缓', '先放放'], ['须知：须知一', '恢复为未读', '还没看懂']]);
  assert.deepEqual([R6('p1').status, R6('p1').ask, R6('p1').asknote, N6('a-n1').acked], ['doing', 'paused', '先放放', undefined]);
});

test('api 5 answerBatch 校验：找不到 404、动作或状态不符 400 bad-action、重复 400；一项不过就全不写不发；发送失败不写', async () => {
  await run('round', 'set', 'v5', 'p1', 'status=paused');
  const snap = fs.readFileSync(f6, 'utf8');
  const bad = (answers, code, status) => assert.rejects(A.answerBatch('v5', { answers }, none), (e) => e.code === code && e.status === status, code + ' ' + JSON.stringify(answers).slice(0, 120));
  await bad([{ kind: 'round', id: 'nope', action: 'done' }], 'round-not-found', 404);
  await bad([{ kind: 'note', id: 'nope', ack: true }], 'note-not-found', 404);
  await bad([{ id: 'nope', choice: '甲' }], 'decision-not-found', 404);
  await bad([{ kind: 'decision', id: 'a-p', choice: '甲' }], 'decision-not-found', 404);
  await bad([{ kind: 'round', id: 'e1', action: 'done' }], 'bad-action', 400);
  await bad([{ kind: 'round', id: 'w1', action: 'resume' }], 'bad-action', 400);
  await bad([{ kind: 'round', id: 's4', action: 'resume' }], 'bad-action', 400);
  await bad([{ kind: 'round', id: 'p1', action: 'paused' }], 'bad-action', 400);
  await bad([{ kind: 'round', id: 'p1', action: 'done' }], 'bad-action', 400);
  await bad([{ kind: 'round', id: 's4', action: 'finish' }], 'bad-action', 400);
  await bad([{ kind: 'round', id: 's4' }], 'bad-action', 400);
  await bad([{ kind: 'note', id: 'a-n1', ack: 'yes' }], 'bad-request', 400);
  await bad([{ kind: 'task', id: 's4' }], 'bad-request', 400);
  await bad([{ kind: 'round', id: 's4', action: 'done' }, { kind: 'round', id: 's4', action: 'paused' }], 'bad-request', 400);
  await bad([{ kind: 'note', id: 'a-n1', ack: true }, { kind: 'note', id: 'a-n1', ack: false }], 'bad-request', 400);
  await bad([], 'empty-answer', 400);
  await bad(Array.from({ length: 51 }, (_, i) => ({ kind: 'note', id: 'x' + i, ack: true })), 'bad-request', 400);
  await bad([{ kind: 'round', id: 's4', action: 'done' }, { kind: 'note', id: 'a-n1', ack: true }, { kind: 'note', id: 'nope', ack: true }], 'note-not-found', 404);
  await assert.rejects(A.answerBatch('v5', { answers: [{ kind: 'round', id: 's4', action: 'done' }, { kind: 'note', id: 'a-n1', ack: true }] }, async () => { throw new Error('断了'); }),
    (e) => e.code === 'send-failed' && e.status === 500 && /断了/.test(e.message));
  assert.equal(fs.readFileSync(f6, 'utf8'), snap, '失败时页面不变');
  const sent = [];
  await A.answerBatch('v5', { answers: [{ kind: 'round', id: 'p1', action: 'resume' }] }, async (sid, prompt) => { sent.push(prompt); });
  assert.match(sent[0], /round set v5 p1 status=doing/);
  assert.deepEqual([R6('p1').status, R6('p1').ask], ['paused', 'resume']);
});

test('api 7：API_VERSION 7，/health 报 7；HTTP 上只 ack 不发消息', async () => {
  assert.equal(A.API_VERSION, 19);
  const probe = A.createServer({ port: 0, send: none });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  probe.close();
  const logs = [];
  const s = A.createServer({ port, send: none, log: (l) => logs.push(l) });
  await new Promise((r) => s.listen(port, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + port;
  const post = (answers) => fetch(base + '/p/v5/answer', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ answers }) });
  try {
    assert.equal((await (await fetch(base + '/health')).json()).api, 19);
    const res = await post([{ kind: 'note', id: 'a-n2', ack: true }]);
    assert.equal(res.status, 200);
    assert.ok((await res.json()).data.notes.find((x) => x.id === 'a-n2').acked);
    assert.equal(logs.at(-1), 'answer-batch v5 note/a-n2 -> （只写文件，没发消息）');
    assert.equal((await post([{ kind: 'round', id: 'nope', action: 'done' }])).status, 404);
  } finally { s.close(); }
});

// ---- 页面里「新 / 更新」的判定（template.html 的 @fresh 段，抽出来单独测）----
const freshLib = () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('// @fresh-begin'), src.indexOf('// @fresh-end'));
  return new Function('ms', body + '\nreturn { freshState, markSnaps, changeOf };')((iso) => (iso ? Date.parse(iso) : 0));
};

test('页面新变化计数：只算活跃条目；看过不再算；刷新不变；CLI 改字段算更新并列出字段；只改时间不算；移入已处理不算', () => {
  const F = freshLib();
  const t0 = '2026-10-22T10:00:00+08:00', t1 = '2026-10-22T11:00:00+08:00', t2 = '2026-10-22T12:00:00+08:00';
  const seen = '2026-10-22T10:30:00+08:00';
  const data = {
    decisions: [{ id: 'd-old', status: 'open', title: '旧', updated: t0 }, { id: 'd-new', status: 'open', title: '新决定', updated: t1 }, { id: 'd-done', status: 'done', title: '已决定', updated: t1 }],
    rounds: [{ id: 'r1', status: 'doing', title: '一轮', state: 'A', updated: t1 }, { id: 'r-end', status: 'done', title: '完成的', updated: t1 }],
    notes: [{ id: 'n-ack', title: '已了解', acked: t1, updated: t1 }],
  };
  let snaps = {};
  let st = F.freshState(data, seen, snaps);
  assert.deepEqual(Object.keys(st.changes).sort(), ['d-new', 'r1']); // 已处理区（done / acked）的不算
  assert.deepEqual(Object.keys(st.baseline), ['d-old']); // 没变化的记基线
  Object.assign(snaps, st.baseline);
  // 悬停看过 r1
  F.markSnaps(data, snaps, 'r1');
  st = F.freshState(data, seen, snaps);
  assert.deepEqual(Object.keys(st.changes), ['d-new']);
  // 刷新（同样的数据再算一次）不变
  assert.deepEqual(Object.keys(F.freshState(JSON.parse(JSON.stringify(data)), seen, snaps).changes), ['d-new']);
  // CLI 改了 r1 的现状和下一步
  data.rounds[0] = { ...data.rounds[0], state: 'B', next: '接着做', updated: t2 };
  st = F.freshState(data, seen, snaps);
  assert.deepEqual(st.changes.r1, { type: 'upd', fields: ['下一步', '现状'] });
  // 只改了时间戳：不算，静默更新基线
  F.markSnaps(data, snaps, 'r1');
  data.rounds[0] = { ...data.rounds[0], updated: '2026-10-22T12:30:00+08:00' };
  st = F.freshState(data, seen, snaps);
  assert.equal(st.changes.r1, undefined);
  assert.equal(st.baseline.r1.u, '2026-10-22T12:30:00+08:00');
  // r1 完成（移入已处理）：不再计数
  data.rounds[0] = { ...data.rounds[0], status: 'done', result: '好了', updated: '2026-10-22T13:00:00+08:00' };
  assert.equal(F.freshState(data, seen, snaps).changes.r1, undefined);
  // 全部标为已看
  F.markSnaps(data, snaps);
  assert.deepEqual(F.freshState(data, seen, snaps).changes, {});
});

test('批量回复遇到版本 2 页面：400 needs-migrate，消息里带 migrate 命令', async () => {
  await run('init', path.join(dir, 'old-v2.html'), '--name', 'oldv2', '--title', '旧版页');
  assert.equal(A.pageData('oldv2').version, 2);
  await assert.rejects(A.answerBatch('oldv2', { answers: [{ id: 'x', choice: 'a' }] }, async () => { throw new Error('不该发送'); }), (e) => e.code === 'needs-migrate' && /migrate oldv2/.test(e.message));
});

// ---- api 6：附件 img / link、轮次 fault、/file 只读提供本地附件 ----------------------------------------
test('api 6 附件：img / link 追加、带说明、删单个、清空；本地文件要存在；格式和重复校验', async () => {
  const f = path.join(dir, 'att.html');
  await run('init', f, '--name', 'att', '--title', '附件页', '--owner', 'session-owner', '--version', '3');
  const shot = path.join(dir, 'shot.png'); fs.writeFileSync(shot, 'png');
  const rep = path.join(dir, 'report.md'); fs.writeFileSync(rep, '# 报告');
  await run('round', 'add', 'att', 'r1', '--mode', 'new', '--proj', 'gamma', 'title=一轮', 'sid=session-aaaa1111-0000-4000-8000-000000000000', 'why=新开', 'eta=10m', 'eta75=20m', 'etaconf=中',
    'img=' + shot + '::主界面', 'link=' + rep + '::报告', 'link=https://example.com/x', 'link=session-0123abcd-9999::原会话');
  await run('decide', 'add', 'att', 'd1', ...RC, 'title=选', 'why=w', 'opt=甲::a', 'opt=乙::b', 'img=https://example.com/a.png', '--proj', 'gamma');
  const R = () => A.pageData('att').rounds.find((x) => x.id === 'r1');
  assert.deepEqual(R().img, [{ src: shot, cap: '主界面' }]);
  assert.deepEqual(R().link.map((l) => l.href), [rep, 'https://example.com/x', 'session-0123abcd-9999']);
  assert.match(await run('round', 'set', 'att', 'r1', 'link=-https://example.com/x'), /link/);
  assert.equal(R().link.length, 2);
  await run('round', 'set', 'att', 'r1', 'img=');
  assert.equal(R().img, undefined);
  await run('round', 'set', 'att', 'r1', 'fault=429 上游限流，回合中断');
  assert.equal(R().fault, '429 上游限流，回合中断');
  const snap = fs.readFileSync(f, 'utf8');
  const bad = [
    ['round', 'set', 'att', 'r1', 'img=' + path.join(dir, 'nope.png')],
    ['round', 'set', 'att', 'r1', 'img=relative/x.png::相对路径解析后不存在'],
    ['round', 'set', 'att', 'r1', 'link=' + rep],
    ['round', 'set', 'att', 'r1', 'link=-https://example.com/none'],
    ['round', 'set', 'att', 'r1', 'img=session-0123abcd-9999'],
  ];
  for (const argv of bad) await assert.rejects(A.main(argv), A.UsageError, argv.join(' '));
  assert.equal(fs.readFileSync(f, 'utf8'), snap);
  // 手工改坏的附件过不了校验
  const data = A.pageData('att');
  for (const broken of [[{ src: 'x.png' }], [{ src: shot, cap: '' }], [{ src: shot, extra: 1 }], [], 'x']) {
    const d2 = structuredClone(data); d2.rounds[0].img = broken;
    assert.throws(() => A.validate(d2), A.UsageError, JSON.stringify(broken));
  }
});

test('api 6 /file：只给登记过、在可读目录里、不像密钥的文件；路径穿越、未登记、目录外都拒绝', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-out-'));
  const outside = path.join(outsideDir, 'leak.md'); fs.writeFileSync(outside, 'secret');
  const key = path.join(dir, 'api-token.txt'); fs.writeFileSync(key, 'tok');
  const exe = path.join(dir, 'tool.exe'); fs.writeFileSync(exe, 'MZ');
  const shot = path.join(dir, 'shot.png');
  const rep = path.join(dir, 'report.md');
  for (const a of ['link=' + outside, 'link=' + key, 'link=' + exe, 'img=' + shot]) await run('round', 'set', 'att', 'r1', a);
  const probe = A.createServer({ port: 0, send: async () => {} });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  probe.close();
  const s = A.createServer({ port, send: async () => {} });
  await new Promise((r) => s.listen(port, '127.0.0.1', r));
  const get = (p) => fetch('http://127.0.0.1:' + port + '/p/att/file?path=' + encodeURIComponent(p));
  try {
    const img = await get(shot);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
    const md = await get(rep);
    assert.equal(md.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await md.text(), '# 报告');
    assert.equal((await get(path.join(dir, 'p.html'))).status, 403, '没登记的文件');
    assert.equal((await get(dir + path.sep + 'x' + path.sep + '..' + path.sep + 'report.md')).status, 403, '没规范化的路径不算登记过');
    assert.equal((await get(outside)).status, 403, '可读目录外');
    assert.equal((await get(key)).status, 403, '像密钥的文件名');
    assert.equal((await get(exe)).status, 403, '不提供的类型');
    assert.equal((await get('report.md')).status, 400, '相对路径');
    const raw = await fetch('http://127.0.0.1:' + port + '/p/att/file?path=' + encodeURIComponent(dir) + '%2F..%2F..%2Fwindows%2Fwin.ini');
    assert.equal(raw.status, 403);
    const evil = await new Promise((ok) => http.get({ host: '127.0.0.1', port, path: '/p/att/file?path=' + encodeURIComponent(shot), headers: { host: 'evil.example' } }, (res) => { res.resume(); ok(res.statusCode); }));
    assert.equal(evil, 403, 'Host 校验照常');
  } finally { s.close(); }
});

// ---- api 7：轮次 accepted（完成要通过才结束）、四栏 columnOf、会话实时状态 live、停了没下一步 ----------------
const opt7 = [{ label: '甲', effect: 'a' }, { label: '乙', effect: 'b' }];
const t7 = (h) => '2026-10-23T' + h + ':00:00+08:00';
/** 写一个版本 3 页面并登记（不走 CLI，好造出任意状态）。 */
const page7 = (name, extra = {}) => {
  const f = path.join(dir, name + '.html');
  fs.writeFileSync(f, A.render({ version: 3, name, title: '页 ' + name, owner: 'session-owner', updated: t7('08'), projects: [], rounds: [], decisions: [], notes: [], ...extra }));
  fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify({ ...A.readRegistry(), [name]: f }));
  return f;
};

test('api 7 columnOf：已结束 / 完成 / 阻塞（按优先级带全部原因）/ 进行中；会话空闲不给进行中；live 未知不猜', () => {
  const dec = (round, status) => ({ id: 'd-' + round + '-' + status, round, status });
  const data = { decisions: [dec('o', 'open'), dec('wf', 'open'), dec('po', 'open'), dec('p', 'pending'), dec('pr', 'pending'), dec('snt', 'sent'), dec('dn', 'open'), dec('x', 'done')] };
  const L = { 's-run': 'running', 's-idle': 'idle', 's-unk': 'unknown' };
  const col = (r, live = L) => A.columnOf(data, { title: 't', ...r }, live);
  assert.deepEqual(col({ id: 'a', status: 'accepted', sid: 's-run' }), { col: 'closed' });
  assert.deepEqual(col({ id: 'b', status: 'dropped', sid: 's-idle' }), { col: 'closed' });
  assert.deepEqual(col({ id: 'dn', status: 'done', sid: 's-run' }), { col: 'done' }, 'done 进「完成」，挂着的决定嵌在卡里');
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-idle' }), { col: 'blocked', reason: 'stopped', reasons: ['stopped'], open: 0 }, '会话已停、没有下一步');
  assert.deepEqual(col({ id: 'snt', status: 'doing', sid: 's-idle' }), { col: 'blocked', reason: 'stopped', reasons: ['stopped'], open: 0 }, 'sent 的决定不挡 stopped');
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-run' }), { col: 'doing', open: 0 });
  assert.deepEqual(col({ id: 'o', status: 'doing', sid: 's-run' }), { col: 'doing', open: 1 }, 'v8：会话在跑，挂着 open 决定仍是进行中');
  assert.deepEqual(col({ id: 'o', status: 'doing', sid: 's-idle' }), { col: 'blocked', reason: 'decide', reasons: ['decide'], open: 1 }, 'v8：会话停了、在等决定 = 阻塞·等你决定');
  assert.deepEqual(col({ id: 'x', status: 'waiting', sid: 's-run' }), { col: 'doing', open: 0 }, 'v8：「等你回答」取消，waiting 按 doing 算');
  assert.deepEqual(col({ id: 'x', status: 'waiting', sid: 's-idle' }), { col: 'blocked', reason: 'stopped', reasons: ['stopped'], open: 0 });
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-idle', fault: '429 限流' }), { col: 'blocked', reason: 'fault', reasons: ['fault'], open: 0 });
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-run', fault: '429 限流' }), { col: 'doing', open: 0, warn: 'fault' }, '在跑：fault 是旧的');
  assert.deepEqual(col({ id: 'p', status: 'doing', sid: 's-idle' }), { col: 'blocked', reason: 'info', reasons: ['info'], open: 0 });
  assert.deepEqual(col({ id: 'p', status: 'doing', sid: 's-run' }), { col: 'doing', open: 0 }, '在跑、等信息');
  assert.deepEqual(col({ id: 'x', status: 'paused', sid: 's-idle' }), { col: 'blocked', reason: 'paused', reasons: ['paused'], open: 0 });
  assert.deepEqual(col({ id: 'po', status: 'paused', sid: 's-idle' }), { col: 'blocked', reason: 'decide', reasons: ['decide', 'paused'], open: 1 });
  assert.deepEqual(col({ id: 'wf', status: 'waiting', sid: 's-idle', fault: '断网' }), { col: 'blocked', reason: 'decide', reasons: ['decide', 'fault'], open: 1 });
  assert.deepEqual(col({ id: 'pr', status: 'paused', sid: 's-idle', fault: 'f' }), { col: 'blocked', reason: 'fault', reasons: ['fault', 'info', 'paused'], open: 0 });
  for (const [live, sid] of [[null, 's-unk'], [L, 's-unk'], [L, 's-missing'], [L, undefined]]) {
    assert.deepEqual(col({ id: 'x', status: 'doing', sid }, live), { col: 'doing', open: 0, unknown: true }, 'live 未知：' + JSON.stringify([live && 'map', sid]));
  }
  assert.deepEqual(col({ id: 'p', status: 'doing', sid: 's-unk' }), { col: 'doing', open: 0, unknown: true }, '不知道在不在跑：不判 info');
  assert.deepEqual(col({ id: 'o', status: 'doing', sid: 's-unk' }), { col: 'doing', open: 1, unknown: true }, '不知道在不在跑：不判「等你决定」');
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-unk', fault: 'f' }), { col: 'blocked', reason: 'fault', reasons: ['fault'], open: 0 });
  assert.deepEqual(col({ id: 'x', status: 'waiting' }, null), { col: 'doing', open: 0, unknown: true });
  // 2026-10-24：回合结束、在等子 agent / 后台任务的会话是进行中（带 wait），不是已停；子 agent 都结束（live 回到 idle）才判已停。
  const BG = { 's-sub': 'subagent', 's-job': 'job' };
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-sub' }, BG), { col: 'doing', open: 0, wait: 'subagent' }, '等子 agent：进行中');
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-job' }, BG), { col: 'doing', open: 0, wait: 'job' }, '等后台任务：进行中');
  assert.deepEqual(col({ id: 'o', status: 'doing', sid: 's-sub' }, BG), { col: 'doing', open: 1, wait: 'subagent' }, '在等子 agent，挂着决定也是进行中');
  assert.deepEqual(col({ id: 'p', status: 'doing', sid: 's-sub' }, BG), { col: 'doing', open: 0, wait: 'subagent' });
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-sub', fault: 'f' }, BG), { col: 'doing', open: 0, warn: 'fault', wait: 'subagent' }, '子 agent 还在跑：fault 是旧的');
  assert.deepEqual(col({ id: 'x', status: 'paused', sid: 's-sub' }, BG), { col: 'blocked', reason: 'paused', reasons: ['paused'], open: 0 });
  assert.deepEqual(col({ id: 'x', status: 'doing', sid: 's-sub' }, { 's-sub': 'idle' }), { col: 'blocked', reason: 'stopped', reasons: ['stopped'], open: 0 }, '子 agent 都结束：已停');
  assert.equal(A.isFinished({ status: 'done' }) && A.isFinished({ status: 'accepted' }) && A.isFinished({ status: 'dropped' }) && !A.isFinished({ status: 'paused' }), true);
  assert.equal(A.isClosed({ status: 'accepted' }) && A.isClosed({ status: 'dropped' }) && !A.isClosed({ status: 'done' }), true);
});

test('api 7 round accept：只接 done → accepted，ended 不变、清 ask；其他状态报错并给出该用的命令', async () => {
  const f = page7('acc', { rounds: [
    { id: 'a1', title: '交了', status: 'done', sid: 's', started: t7('08'), ended: t7('10'), updated: t7('10'), ask: 'accept', asked: t7('11') },
    { id: 'a3', title: '在做', status: 'doing', sid: 's', updated: t7('08') },
    { id: 'a5', title: '放弃了', status: 'dropped', sid: 's', ended: t7('09'), updated: t7('09') },
    { id: 'a6', title: '暂缓', status: 'paused', sid: 's', updated: t7('08') },
    { id: 'a7', title: '等你', status: 'waiting', sid: 's', updated: t7('08') },
  ] });
  process.env.ALIGN_NOW = t7('12');
  try {
    assert.equal(await run('round', 'accept', 'acc', 'a1', 'result=验过了'), 'round/a1 → 通过 → ' + f);
    const r = read3(f).rounds.find((x) => x.id === 'a1');
    assert.deepEqual([r.status, r.ended, r.updated, r.result, r.ask, r.asked], ['accepted', t7('10'), t7('12'), '验过了', undefined, undefined]);
    await rejects(['round', 'accept', 'acc', 'a1'], /已经通过/, f);
    await rejects(['round', 'accept', 'acc', 'a3'], /还没完成.*round done acc a3/, f);
    await rejects(['round', 'accept', 'acc', 'a7'], /还没完成.*round done acc a7/, f);
    await rejects(['round', 'accept', 'acc', 'a6'], /暂缓.*round set acc a6 status=doing/, f);
    await rejects(['round', 'accept', 'acc', 'a5'], /已放弃.*round set acc a5 status=done/, f);
    await rejects(['round', 'accept', 'acc'], /用法/, f);
    await rejects(['round', 'accept', 'acc', 'nope'], /没有 id 为 nope 的 round/, f);
    // done ↔ accepted 互换不改 ended；round done 拒绝已通过的
    await run('round', 'set', 'acc', 'a1', 'status=done', 'visual=false');
    assert.equal(read3(f).rounds.find((x) => x.id === 'a1').ended, t7('10'));
    await run('round', 'accept', 'acc', 'a1');
    await rejects(['round', 'done', 'acc', 'a1'], /已经通过/, f);
  } finally { delete process.env.ALIGN_NOW; }
});

test('round accept 沿 prev 链一起结束前面停在「完成」的轮次；dropped / paused 不动', async () => {
  const f = page7('accc', { rounds: [
    { id: 'c1', title: '第一轮', status: 'done', sid: 's1', ended: t7('08'), updated: t7('08'), ask: 'accept', asked: t7('08') },
    { id: 'c2', title: '第二轮', status: 'done', sid: 's1', prev: 'c1', ended: t7('09'), updated: t7('09') },
    { id: 'c3', title: '第三轮', status: 'done', sid: 's1', prev: 'c2', ended: t7('10'), updated: t7('10') },
    { id: 'd1', title: '更早', status: 'done', sid: 's2', ended: t7('07'), updated: t7('07') },
    { id: 'd2', title: '放弃了', status: 'dropped', sid: 's2', prev: 'd1', ended: t7('08'), updated: t7('08') },
    { id: 'd3', title: '暂缓', status: 'paused', sid: 's2', prev: 'd2', updated: t7('08') },
    { id: 'd4', title: '最新', status: 'done', sid: 's2', prev: 'd3', ended: t7('10'), updated: t7('10') },
    { id: 'e1', title: '别的链', status: 'done', sid: 's3', ended: t7('09'), updated: t7('09') },
  ] });
  process.env.ALIGN_NOW = t7('12');
  try {
    // 三轮链只验收最后一轮：前两轮一起 accepted，ended / updated 不变，页面操作清掉
    assert.equal(await run('round', 'accept', 'accc', 'c3'), 'round/c3 → 通过；同一条链上停在完成的前序轮次一起结束：c2、c1 → ' + f);
    const by = (id) => read3(f).rounds.find((x) => x.id === id);
    assert.deepEqual([by('c1').status, by('c1').ended, by('c1').updated, by('c1').ask, by('c1').asked], ['accepted', t7('08'), t7('08'), undefined, undefined]);
    assert.deepEqual([by('c2').status, by('c2').ended, by('c2').updated], ['accepted', t7('09'), t7('09')]);
    assert.equal(by('c3').status, 'accepted');
    assert.equal(by('e1').status, 'done', '别的链不动');
    // 中间有 dropped / paused：它们不动，更前面停在完成的照样结束
    assert.equal(await run('round', 'accept', 'accc', 'd4'), 'round/d4 → 通过；同一条链上停在完成的前序轮次一起结束：d1 → ' + f);
    assert.deepEqual(['d1', 'd2', 'd3', 'd4'].map((id) => by(id).status), ['accepted', 'dropped', 'paused', 'accepted']);
    assert.equal(by('d2').ended, t7('08'));
    // 链上没有别的 done：消息与原来一样
    assert.equal(await run('round', 'accept', 'accc', 'e1'), 'round/e1 → 通过 → ' + f);
  } finally { delete process.env.ALIGN_NOW; }
});

test('api 7 round accept --before：ended（没有就用 updated）早于该时刻的 done 批量改 accepted；--dry-run 只列', async () => {
  const f = page7('accb', { rounds: [
    { id: 'b1', title: '早', status: 'done', ended: t7('10'), updated: t7('10') },
    { id: 'b2', title: '晚', status: 'done', ended: t7('12'), updated: t7('12') },
    { id: 'b3', title: '迁移来的', status: 'done', updated: t7('09') },
    { id: 'b4', title: '在做', status: 'doing', updated: t7('08') },
    { id: 'b5', title: '放弃', status: 'dropped', ended: t7('08'), updated: t7('08') },
  ] });
  const snap = fs.readFileSync(f, 'utf8');
  assert.deepEqual((await run('round', 'accept', 'accb', '--before', t7('11'), '--dry-run')).split('\n'), [
    '预演（没写入）：ended 早于 ' + t7('11') + ' 的 done 轮次 2 条会改为 accepted', 'round/b1 早 · ended ' + t7('10'), 'round/b3 迁移来的 · ended ' + t7('09') + '（没有 ended，按 updated）']);
  assert.equal(fs.readFileSync(f, 'utf8'), snap, '--dry-run 不写');
  assert.equal(await run('round', 'accept', 'accb', '--before', t7('11')), '2 条 done 改为 accepted（ended 早于 ' + t7('11') + '） → ' + f);
  const st = Object.fromEntries(read3(f).rounds.map((x) => [x.id, x.status + ':' + (x.ended || '-')]));
  assert.deepEqual(st, { b1: 'accepted:' + t7('10'), b2: 'done:' + t7('12'), b3: 'accepted:-', b4: 'doing:-', b5: 'dropped:' + t7('08') });
  const snap2 = fs.readFileSync(f, 'utf8');
  assert.equal(await run('round', 'accept', 'accb', '--before', t7('11')), '0 条 done 改为 accepted（ended 早于 ' + t7('11') + '） → ' + f);
  assert.equal(fs.readFileSync(f, 'utf8'), snap2, '一条都没有就不写');
  await rejects(['round', 'accept', 'accb', '--before', '昨天'], /--before 要写成 ISO 时间/, f);
  await rejects(['round', 'accept', 'accb', 'b2', '--before', t7('13')], /--before 不和轮次 id 一起用/, f);
});

test('暂缓的轮次能放弃：answerBatch 收 paused → dropped，网页 ACT_FROM 同口径（2026-10-27 手机放弃暂缓轮次被拒）', async () => {
  const f = page7('dp7', { rounds: [{ id: 'p1', title: '暂缓了', status: 'paused', sid: 's', updated: t7('10') }] });
  const sent = [];
  const r = await A.answerBatch('dp7', { answers: [{ kind: 'round', id: 'p1', action: 'dropped', note: '不做了' }] }, async (sid, prompt) => { sent.push(prompt); });
  assert.match(sent[0], /用户选择：放弃[\s\S]*round set dp7 p1 status=dropped/);
  const x = r.data.rounds.find((y) => y.id === 'p1');
  assert.deepEqual([x.status, x.ask, x.asknote], ['paused', 'dropped', '不做了']);
  await run('round', 'set', 'dp7', 'p1', 'status=dropped', 'result=不做了');
  assert.equal(read3(f).rounds.find((y) => y.id === 'p1').status, 'dropped');
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(src, /dropped: \['doing', 'waiting', 'paused', 'done'\]/, '网页 ACT_FROM：暂缓的轮次也能放弃');
});

test('api 7 answerBatch accept：done 轮次可「通过」或「放弃」（不能暂缓），消息带 round accept 命令；只记 ask，round accept 后清掉', async () => {
  const f = page7('ab7', { rounds: [
    { id: 'c1', title: '交了', status: 'done', sid: 's', ended: t7('10'), updated: t7('10') },
    { id: 'c2', title: '交了二', status: 'done', sid: 's', ended: t7('10'), updated: t7('10') },
    { id: 'c3', title: '在做', status: 'doing', sid: 's', updated: t7('10') },
  ] });
  const sent = [];
  const r = await A.answerBatch('ab7', { answers: [{ kind: 'round', id: 'c1', action: 'accept', note: '好' }, { kind: 'round', id: 'c2', action: 'dropped' }] }, async (sid, prompt, card) => { sent.push({ sid, prompt, card }); });
  const cmd = 'align ';
  assert.equal(sent[0].prompt, ['对齐页「页 ab7」上，用户一次发来 2 项，请逐条处理：', '',
    '1. 轮次「交了」（c1）', '   用户选择：确认', '   备注：好', '   处理完运行 ' + cmd + 'round accept ab7 c1', '',
    '2. 轮次「交了二」（c2）', '   用户选择：放弃', '   处理完运行 ' + cmd + 'round set ab7 c2 status=dropped result=<放弃原因>', '',
    '某一条处理不了，运行 ' + cmd + 'round set ab7 <轮次 id> status=<原状态> 恢复原状态，并在 state 里写明原因。'].join('\n'));
  assert.deepEqual(sent[0].card.decisions, [{ title: '轮次：交了', choice: '确认', note: '好' }, { title: '轮次：交了二', choice: '放弃', note: '' }]);
  assert.deepEqual(['c1', 'c2'].map((id) => { const x = r.data.rounds.find((y) => y.id === id); return [x.status, x.ask]; }), [['done', 'accept'], ['done', 'dropped']]);
  await assert.rejects(A.answerBatch('ab7', { answers: [{ kind: 'round', id: 'c3', action: 'accept' }] }, none), (e) => e.code === 'bad-action' && /要求 done/.test(e.message));
  await assert.rejects(A.answerBatch('ab7', { answers: [{ kind: 'round', id: 'c1', action: 'paused' }] }, none), (e) => e.code === 'bad-action');
  await assert.rejects(A.answerBatch('ab7', { answers: [{ kind: 'round', id: 'c1', action: 'finish' }] }, none), (e) => e.code === 'bad-action' && /accept/.test(e.message));
  await run('round', 'accept', 'ab7', 'c1');
  const c1 = read3(f).rounds.find((x) => x.id === 'c1');
  assert.deepEqual([c1.status, c1.ask], ['accepted', undefined]);
});

test('api 7 裁剪：只裁已结束（accepted + dropped）合计留 40；done 在等验收，不裁', async () => {
  const f = path.join(dir, 'prune7.html');
  const data = { version: 3, name: 'prune7', title: 'p', projects: [], rounds: [], decisions: [], notes: [] };
  const ts = (i) => '2026-10-01T00:00:' + String(i).padStart(2, '0') + '+08:00';
  for (let i = 0; i < 45; i++) data.rounds.push({ id: 'c' + i, title: 't', status: i % 2 ? 'accepted' : 'dropped', updated: ts(i) });
  for (let i = 0; i < 45; i++) data.rounds.push({ id: 'd' + i, title: 't', status: 'done', updated: ts(i) });
  fs.writeFileSync(f, A.render(data));
  await run('note', 'add', f, 'n', 'title=x');
  const d = read3(f);
  assert.equal(d.rounds.filter((x) => x.status === 'accepted' || x.status === 'dropped').length, 40);
  assert.equal(d.rounds.filter((x) => x.status === 'done').length, 45);
  assert.deepEqual(['c4', 'c5'].map((id) => d.rounds.some((x) => x.id === id)), [false, true]);
});

test('api 7 listPages：open = 要你处理的卡数（轮次去重；没挂轮次的按项目去重）、decisions = open 决定数；forget 掉的页不再算', async () => {
  const projects = [{ id: 'p1', title: 'P1', cwd: path.join(dir, 'p1') }, { id: 'p2', title: 'P2', cwd: path.join(dir, 'p2') }];
  const d = (id, extra) => ({ id, title: id, why: 'w', opt: opt7, status: 'open', updated: t7('09'), ...extra });
  page7('cnt1', { projects, rounds: [
    { id: 'w1', title: '等你', status: 'waiting', proj: 'p1' }, { id: 'o1', title: '两个决定', status: 'doing', proj: 'p1' },
    { id: 'w2', title: '等你又有决定', status: 'waiting', proj: 'p2' }, { id: 'q1', title: '在跑', status: 'doing', proj: 'p2' },
    { id: 'f1', title: '完成待验收', status: 'done', proj: 'p1' },
  ], decisions: [
    d('k1', { round: 'o1', proj: 'p1' }), d('k2', { round: 'o1', proj: 'p1' }), d('k3', { round: 'w2', proj: 'p2' }),
    d('u1', { proj: 'p1' }), d('u2', { proj: 'p1' }), d('g1', { round: 'gone', proj: 'p1' }), d('u3', { proj: 'p2' }), d('u4'), d('u5'),
    d('s1', { round: 'q1', proj: 'p2', status: 'sent', choice: '甲' }), { id: 'pd', title: 'pd', status: 'pending', round: 'q1', proj: 'p2' },
  ] });
  page7('cnt2', { rounds: [{ id: 'z1', title: '等你', status: 'waiting' }] });
  const pick = () => Object.fromEntries(A.listPages().filter((p) => p.name.startsWith('cnt')).map((p) => [p.name, [p.open, p.decisions]]));
  // cnt1：w1、o1、w2 三张轮次卡 + 项目卡 P1（u1 u2 g1）、P2（u3）、未归属（u4 u5）= 6
  assert.deepEqual(pick(), { cnt1: [6, 9], cnt2: [1, 0] });
  assert.match(await run('forget', 'cnt2'), /^注销了 cnt2/);
  assert.deepEqual(pick(), { cnt1: [6, 9] }, '红点只算已登记页面');
});

test('api 7 legacyView：done → 最近完成「待验收：…」，accepted → 最近完成原样', () => {
  const v = A.legacyView({ version: 3, name: 'lv7', title: 'lv7', projects: [], rounds: [
    { id: 'dn', title: '交了', status: 'done', result: '合入了', updated: t7('10'), ended: t7('10') },
    { id: 'd0', title: '没写结果', status: 'done', updated: t7('09'), ended: t7('09') },
    { id: 'ac', title: '通过了', status: 'accepted', result: '合入了', updated: t7('11'), ended: t7('10') },
  ], decisions: [], notes: [] });
  A.validate(v);
  const by = Object.fromEntries(v.items.map((x) => [x.id, x]));
  assert.deepEqual([by.dn.sec, by.dn.result], ['done', '待验收：合入了']);
  assert.deepEqual([by.d0.sec, by.d0.result], ['done', '待验收']);
  assert.deepEqual([by.ac.sec, by.ac.result], ['done', '合入了']);
  assert.deepEqual(v.items.map((x) => x.id), ['ac', 'dn', 'd0']);
});

test('api 7 停了没下一步：stuckRoundsForSession 列 doing、无 fault、无 open/pending 决定的轮次；stale --idle 同样列出', async () => {
  page7('st7', { rounds: [
    { id: 'k1', title: '第三阶段', status: 'doing', sid: 'session-81515b53-0000-4000-8000-000000000000' },
    { id: 'k2', title: '出错', status: 'doing', sid: 'session-81515b53-0000-4000-8000-000000000000', fault: '429' },
    { id: 'k3', title: '等决定', status: 'doing', sid: 'session-81515b53-0000-4000-8000-000000000000' },
    { id: 'k4', title: '等信息', status: 'doing', sid: 'session-81515b53-0000-4000-8000-000000000000' },
    { id: 'k5', title: '等你', status: 'waiting', sid: 'session-81515b53-0000-4000-8000-000000000000' },
    { id: 'k6', title: '别的会话', status: 'doing', sid: 'session-864f50b8-0000-4000-8000-e00000000000' },
    { id: 'k7', title: '决定已回', status: 'doing', sid: 'session-81515b53-0000-4000-8000-000000000000' },
    { id: 'k8', title: '交了', status: 'done', sid: 'session-81515b53-0000-4000-8000-000000000000' },
  ], decisions: [
    { id: 'kd3', title: 'x', why: 'w', opt: opt7, status: 'open', round: 'k3', updated: t7('09') },
    { id: 'kd4', title: 'y', status: 'pending', round: 'k4', updated: t7('09') },
    { id: 'kd7', title: 'z', why: 'w', opt: opt7, status: 'sent', choice: '甲', round: 'k7', updated: t7('09') },
  ] });
  const stuck = (id, title) => ({ page: 'st7', pageTitle: '页 st7', id, title, cmds: [
    'align round done st7 ' + id + " 'result=…' visual=true|false",
    'align decide add st7 <决定 id> --round ' + id + " 'title=<要问的话>' 'why=…'",
    'align round set st7 ' + id + " 'fault=…'",
  ] });
  const k1 = stuck('k1', '第三阶段'), k6 = stuck('k6', '别的会话'), k7 = stuck('k7', '决定已回');
  assert.deepEqual(A.stuckRoundsForSession('session-81515b53-0000-4000-8000-000000000000').filter((x) => x.page === 'st7'), [k1, k7], '别的页上同名会话的轮次也会列出，这里只看本页');
  assert.deepEqual(A.stuckRoundsForSession('session-86496ca9-0000-4000-8000-bd0000000000'), []);
  assert.throws(() => A.stuckRoundsForSession(''), A.UsageError);
  const line = (x, sid) => '已停没有下一步 round/' + x.id + ' ' + x.title + '（会话 ' + sid + '） → ' + x.cmds.join(' | ');
  assert.deepEqual((await run('stale', 'st7', '--idle', 'session-81515b53-0000-4000-8000-000000000000, session-864f50b8-0000-4000-8000-e00000000000')).split('\n'), ['没有过时的决定', line(k1, 'session-81515b53-0000-4000-8000-000000000000'), line(k6, 'session-864f50b8-0000-4000-8000-e00000000000'), line(k7, 'session-81515b53-0000-4000-8000-000000000000')]);
  assert.deepEqual((await run('stale', 'st7', '--idle', 'session-86496ca9-0000-4000-8000-bd0000000000')).split('\n'), ['没有过时的决定', '--idle 的会话上没有已停没有下一步的轮次']);
  assert.equal(await run('stale', 'st7'), '没有过时的决定', '不给 --idle 照旧');
});

test('2026-11-02 已停提醒：stuckReminders 只列会话 idle、停满 10 分钟的 stuckRound；First Mate 改过轮次或决定就重新计时；同一次回合结束只提醒一次', () => {
  const sid = (n) => 'session-5e0' + n + '0000-0000-4000-8000-000000000000';
  const at = (hm) => Date.parse('2026-10-23T' + hm + ':00+08:00');
  const data = { title: '页 sr', rounds: [
    { id: 'a', title: '交了', status: 'doing', sid: sid(1), updated: t7('09') },
    { id: 'b', title: '在跑', status: 'doing', sid: sid(2), updated: t7('09') },
    { id: 'c', title: '等后台', status: 'doing', sid: sid(3), updated: t7('09') },
    { id: 'd', title: '刚改过', status: 'doing', sid: sid(4), updated: '2026-10-23T10:05:00+08:00' },
    { id: 'e', title: '挂决定', status: 'doing', sid: sid(5), updated: t7('09') },
    { id: 'f', title: '暂缓', status: 'paused', sid: sid(6), updated: t7('09') },
    { id: 'g', title: '出错', status: 'doing', sid: sid(7), fault: '429', updated: t7('09') },
    { id: 'h', title: '被切断', status: 'doing', sid: sid(8), updated: t7('09') },
    { id: 'i', title: '决定刚关', status: 'doing', sid: sid(9), updated: t7('09') },
  ], decisions: [
    { id: 'de', round: 'e', status: 'open', updated: t7('09') },
    { id: 'di', round: 'i', status: 'done', updated: '2026-10-23T10:08:00+08:00' },
  ] };
  const live = { [sid(1)]: 'idle', [sid(2)]: 'running', [sid(3)]: 'job', [sid(4)]: 'idle', [sid(5)]: 'idle', [sid(6)]: 'idle', [sid(7)]: 'idle', [sid(8)]: 'idle', [sid(9)]: 'idle' };
  const ended = { at: at('10:00'), kind: 'completed' };
  const turns = { [sid(1)]: ended, [sid(4)]: ended, [sid(5)]: ended, [sid(6)]: ended, [sid(7)]: ended, [sid(8)]: null, [sid(9)]: ended };
  const now = at('10:12');
  const got = A.stuckReminders(data, now, live, turns, new Set());
  assert.deepEqual(got.map((x) => [x.id, x.since, x.end, x.key]), [['a', at('10:00'), 'completed', 'a@' + at('10:00')], ['h', Date.parse(t7('09')), null, 'h@cut']],
    '在跑 / 等后台 / 挂着 open 决定 / 暂缓 / 出错的不提醒；轮次 10:05 改过、决定 10:08 关掉的从那时起算，还不到 10 分钟');
  assert.deepEqual(A.stuckReminders(data, at('10:09'), live, turns, new Set()).map((x) => x.id), ['h'], '不到 10 分钟不提醒');
  assert.deepEqual(A.stuckReminders(data, at('10:30'), live, turns, new Set(['a@' + at('10:00'), 'h@cut'])).map((x) => x.id), ['d', 'i'], '提醒过的不再提醒');
  assert.deepEqual(A.stuckReminders(data, at('10:30'), live, { ...turns, [sid(1)]: { at: at('10:15'), kind: 'error' } }, new Set(['a@' + at('10:00')])).map((x) => x.key)[0], 'a@' + at('10:15'), '会话又跑了一回合、停下后再提醒');
  assert.deepEqual(A.stuckReminders(data, now, null, turns, new Set()), [], 'live 未知不提醒');
  assert.throws(() => A.stuckReminders(data, now, live, {}, new Set()), /缺会话/, 'idle 会话缺回合时间就报错，不猜');
  // 提醒全文：第一行 [fm] + 标题、第二行 sid（dsh-thread-message 按 dsh-fm 通知画卡、链到会话），再写停了多久和三条命令
  const text = A.stuckReminderText(data, 'sr', got[0], now).split('\n');
  assert.equal(text[0], '[fm] 轮次待登记');
  assert.equal(text[1], 'sid: ' + sid(1));
  assert.match(text[2], /^对齐页「页 sr」轮次 a「交了」：会话\d\d:\d\d 回合正常结束，之后 12 分钟没有动静/);
  assert.match(text[3], /align round done sr a 'result=…' visual=true\|false \| align decide add sr <决定 id> --round a .* \| align round set sr a 'fault=…'/);
  assert.match(text[4], /不挂暂缓/);
  assert.equal(A.stuckSummary(got[1]), '轮次已停', '回合没收尾的叫已停');
  assert.match(A.stuckReminderText(data, 'sr', got[1], now).split('\n')[2], /会话回合没有收尾/);
  assert.equal(A.stuckSummary({ end: 'error' }), '轮次已停');
});

test('2026-11-02 decide done：决定挂的轮次还是 doing、没有别的待决定时，输出里提示收轮（不自动改）', async () => {
  page7('dd', { rounds: [{ id: 'q1', title: '要不要做', status: 'doing', sid: 'session-dd000000-0000-4000-8000-000000000000' }, { id: 'q2', title: '另一个', status: 'doing' }],
    decisions: [{ id: 'qa', title: '做不做', why: 'w', opt: opt7, status: 'sent', choice: '乙', round: 'q1', updated: t7('09') },
      { id: 'qb', title: '还有', why: 'w', opt: opt7, status: 'sent', choice: '甲', round: 'q2', updated: t7('09') }, { id: 'qc', title: '开着', why: 'w', opt: opt7, status: 'open', round: 'q2', updated: t7('09') }] });
  const out = (await run('decide', 'done', 'dd', 'qa', 'choice=不做')).split('\n');
  assert.match(out[0], /^decide\/qa → 完成/);
  assert.equal(out[1], "轮次 q1 还是进行中，没有别的待决定：会话要接着做就把答复转给它；不做了 align round set dd q1 status=dropped 'result=<原因>'；已经交了结果 align round done dd q1 'result=…' visual=true|false");
  assert.equal(A.pageData('dd').rounds.find((r) => r.id === 'q1').status, 'doing', '只提示，不改轮次');
  assert.equal((await run('decide', 'done', 'dd', 'qb', 'choice=甲')).split('\n').length, 1, '还挂着 open 决定的轮次不提示');
});

test('api 7 /data 带 live：3390 是 null；3080 的 live(sids) 按页面上轮次的 sid 查，形状不对 500；createHandler 必须给 live；版本 2 页面不加', async () => {
  page7('lv7', { rounds: [
    { id: 'l1', title: '一', status: 'doing', sid: 's-a' }, { id: 'l2', title: '二', status: 'done', sid: 's-b', ended: t7('09') },
    { id: 'l3', title: '三', status: 'doing', sid: 's-a' }, { id: 'l4', title: '四', status: 'waiting' },
  ] });
  const sent = [];
  const probe = A.createServer({ port: 0, send: none });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  probe.close();
  const s = A.createServer({ port, send: async (sid, prompt) => { sent.push(prompt); } });
  await new Promise((r) => s.listen(port, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + port;
  try {
    const j = await (await fetch(base + '/p/lv7/data')).json();
    assert.equal(j.live, null, '3390 没有会话状态');
    assert.deepEqual(j.text, A.textOf(A.pageData('lv7')), '手机接口版本 6：版本 3 页面带服务端拆好的正文 text');
    delete j.live; delete j.text;
    assert.deepEqual(j, A.pageData('lv7'));
    const res = await fetch(base + '/p/lv7/answer', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ answers: [{ kind: 'round', id: 'l2', action: 'accept' }] }) });
    assert.equal(res.status, 200);
    const after = (await res.json()).data;
    assert.equal(after.live, null, '回复后的数据同样带 live');
    assert.deepEqual(after.text, A.textOf(A.pageData('lv7')), '回复后的数据同样带 text');
    const v2 = await (await fetch(base + '/p/t1/data')).json();
    assert.equal('live' in v2 || 'text' in v2, false, '版本 2 页面原样');
  } finally { s.close(); }
  const asked = [];
  let answer = (sids) => Object.fromEntries(sids.map((x) => [x, x === 's-a' ? 'running' : 'idle']));
  const h = http.createServer(A.createHandler({ prefix: '/alignment', send: none, guard: () => null, live: async (sids) => { asked.push(sids); return answer(sids); } }));
  await new Promise((r) => h.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + h.address().port + '/alignment/p/lv7/data';
  try {
    const j = await (await fetch(url)).json();
    assert.deepEqual(j.live, { 's-a': 'running', 's-b': 'idle' });
    assert.deepEqual(asked, [['s-a', 's-b']], '去重、跳过没有 sid 的轮次');
    assert.deepEqual(A.columnOf(j, j.rounds[0], j.live), { col: 'doing', open: 0 });
    answer = () => ({ 's-a': 'running' });
    const miss = await fetch(url);
    assert.equal(miss.status, 500);
    assert.match((await miss.json()).message, /live.*s-b/);
    answer = (sids) => Object.fromEntries(sids.map((x) => [x, 'busy']));
    assert.equal((await fetch(url)).status, 500);
  } finally { h.close(); }
  assert.throws(() => A.createHandler({ prefix: '', send: none, guard: () => null }), /live/);
});

// ---- api 7 决策卡：风险 risk/cat、作用范围 scope + 长期规则、超时 timeout ------------------------------------
const ms = (iso) => Date.parse(iso);

test('api 7 risk / cat：open 决定必须带，取值和组合校验；pending 提升时才要；旧数据缺了照常读', async () => {
  const f = page7('rk', { decisions: [{ id: 'old', title: '旧决定', why: 'w', opt: opt7, status: 'open', updated: t7('08') }] });
  assert.equal(A.pageData('rk').decisions[0].risk, undefined, '旧数据没有 risk/cat 不报错');
  const base = ['decide', 'add', 'rk', 'n1', 'title=选', 'why=w', ...O];
  await rejects(base, /缺 risk= cat=.*高\|中\|低.*花钱\|不可逆\|对外发消息\|线上配置\|方向取舍\|其他/, f);
  await rejects([...base, 'risk=中'], /缺 cat=/, f);
  await rejects([...base, 'risk=很高', 'cat=其他'], /risk 只能是 高 \| 中 \| 低/, f);
  await rejects([...base, 'risk=中', 'cat=杂项'], /cat 只能是/, f);
  for (const cat of ['不可逆', '对外发消息', '线上配置']) await rejects([...base, 'risk=低', 'cat=' + cat], /risk 不能是 低/, f);
  await rejects(['decide', 'add', 'rk', 'n1', 'title=买', 'why=要买服务器', ...O, 'risk=中', 'cat=花钱'], /cat=花钱.*金额/, f);
  assert.match(await run('decide', 'add', 'rk', 'n1', 'title=买', 'why=要买服务器 ¥1200', ...O, 'risk=高', 'cat=花钱'), /^加了 decide\/n1/);
  assert.match(await run('decide', 'add', 'rk', 'n2', 'title=买', 'why=每月 300 元', ...O, 'risk=中', 'cat=花钱'), /^加了 decide\/n2/);
  assert.match(await run('decide', 'add', 'rk', 'pd', 'title=等信息', '--pending'), /^加了 decide\/pd/);
  await rejects(['decide', 'set', 'rk', 'pd', 'status=open', 'why=齐了', ...O], /缺 risk= cat=/, f);
  assert.match(await run('decide', 'set', 'rk', 'pd', 'status=open', 'why=齐了', ...O, ...RC), /^改了 decide\/pd/);
});

test('api 7 opened / timeout / due：进入 open 记 opened，due = opened + timeout（缺省 8h），改 timeout 重算；CLI 维护的字段不能写', async () => {
  const f = page7('to');
  process.env.ALIGN_NOW = t7('09');
  try {
    await run('decide', 'add', 'to', 'a', 'title=甲', 'why=w', ...O, ...RC);
    await run('decide', 'add', 'to', 'b', 'title=乙', 'why=w', ...O, ...RC, 'timeout=2h');
    const D = (id) => read3(f).decisions.find((x) => x.id === id);
    assert.deepEqual([D('a').opened, D('a').due, D('a').timeout], [t7('09'), t7('17'), undefined]);
    assert.deepEqual([D('b').opened, D('b').due], [t7('09'), t7('11')]);
    process.env.ALIGN_NOW = t7('10');
    await run('decide', 'set', 'to', 'b', 'timeout=30m');
    assert.deepEqual([D('b').opened, D('b').due], [t7('09'), '2026-10-23T09:30:00+08:00'], '从 opened 算');
    await run('decide', 'set', 'to', 'b', 'timeout=');
    assert.equal(D('b').due, t7('17'));
    await rejects(['decide', 'set', 'to', 'b', 'timeout=半天'], /timeout 要写成时长/, f);
    for (const k of ['opened', 'due', 'auto', 'autoAt', 'overdue', 'revoked', 'revokeAsked']) await rejects(['decide', 'set', 'to', 'b', k + '=x'], /CLI 维护|由页面写入/, f);
    // sent → 改回 open：重新开始计时
    await run('decide', 'set', 'to', 'a', 'status=sent', 'choice=甲');
    process.env.ALIGN_NOW = t7('12');
    await run('decide', 'set', 'to', 'a', 'status=open');
    assert.deepEqual([D('a').opened, D('a').due], [t7('12'), t7('20')]);
    assert.match(await run('meta', 'to', 'timeoutHigh=auto'), /timeoutHigh/);
    assert.equal(read3(f).timeoutHigh, 'auto');
    await rejects(['meta', 'to', 'timeoutHigh=sometimes'], /timeoutHigh 只能是 remind \| auto/, f);
  } finally { delete process.env.ALIGN_NOW; }
});

test('api 7 sortDecisions / sortBlocked：按风险高→低、同级等得久的在前；阻塞栏先放要你答的卡（超时的最前），再按原因', () => {
  const now = ms(t7('20'));
  const d = (id, risk, opened, extra = {}) => ({ id, status: 'open', ...(risk ? { risk } : {}), ...(opened ? { opened } : {}), updated: t7('05'), ...extra });
  const list = [d('l1', '低', t7('08')), d('m-late', '中', t7('12')), d('h1', '高', t7('15')), d('m-old', undefined, undefined), d('m-early', '中', t7('09'))];
  assert.deepEqual(A.sortDecisions(list, now).map((x) => x.id), ['h1', 'm-old', 'm-early', 'm-late', 'l1'], '缺 risk 算中，缺 opened 用 updated');
  assert.deepEqual(list.map((x) => x.id)[0], 'l1', '不改原数组');
  const cards = [
    { id: 'paused', reason: 'paused', decisions: [] },
    { id: 'stopped', reason: 'stopped', decisions: [] },
    { id: 'ans', reason: 'answer', decisions: [], answer: t7('07') },
    { id: 'low', reason: 'decide', decisions: [d('x1', '低', t7('06'))] },
    { id: 'high', reason: 'decide', decisions: [d('x2', '低', t7('10')), d('x3', '高', t7('11'))] },
    { id: 'mid-old', reason: 'decide', decisions: [d('x4', '中', t7('06'))] },
    { id: 'fault', reason: 'fault', decisions: [] },
    { id: 'info', reason: 'info', decisions: [] },
    { id: 'late', reason: 'decide', decisions: [d('x5', '低', t7('11'), { overdue: t7('19') })] },
  ];
  assert.deepEqual(A.sortBlocked(cards, now).map((c) => c.id), ['late', 'high', 'mid-old', 'ans', 'low', 'stopped', 'fault', 'info', 'paused']);
});

test('api 7 作用范围 scope + like：opt 第三段、always 要 like；答复带 scope 时消息多两行和写规则的指引；没有 like 拒绝', async () => {
  const f = page7('sc', { projects: [{ id: 'pa', title: '项目甲', cwd: path.join(dir, 'pa') }] });
  await rejects(['decide', 'add', 'sc', 'a1', 'title=调参', 'why=w', 'opt=调::小幅::always', 'opt=不调::维持', ...RC], /like/, f);
  assert.match(await run('decide', 'add', 'sc', 'a1', 'title=调参', 'why=w', 'opt=调::小幅::always', 'opt=不调::维持::once', 'opt=只这个项目::x::project', 'like=Hindsight 运维参数的小幅调整', ...RC, '--proj', 'pa'), /^加了 decide\/a1/);
  const a1 = read3(f).decisions.find((x) => x.id === 'a1');
  assert.deepEqual(a1.opt, [{ label: '调', effect: '小幅', scope: 'always' }, { label: '不调', effect: '维持' }, { label: '只这个项目', effect: 'x', scope: 'project' }], 'once 是缺省，不存');
  assert.match(await run('decide', 'add', 'sc', 'a2', 'title=无同类', 'why=w', ...O, ...RC), /加了/);
  await rejects(['decide', 'set', 'sc', 'a1', 'like=' + 'x'.repeat(81)], /like 最多 80 字/, f);
  const bad = (answers, code) => assert.rejects(A.answerBatch('sc', { answers }, none), (e) => e.code === code, JSON.stringify(answers));
  await bad([{ id: 'a2', choice: '甲', scope: 'always' }], 'needs-like');
  await bad([{ id: 'a1', choice: '调', scope: 'forever' }], 'bad-request');
  await bad([{ id: 'a1', note: '随便', scope: 'always' }], 'needs-choice');
  await bad([{ id: 'a1', choice: '调', scope: 'always', like: 'y'.repeat(81) }], 'bad-request');
  const sent = [];
  const send = async (sid, prompt, card) => { sent.push({ sid, prompt, card }); };
  const r = await A.answerBatch('sc', { answers: [{ id: 'a1', choice: '不调', scope: 'always', like: '运维参数小改' }, { id: 'a2', choice: '乙', scope: 'project', like: '本项目的依赖升级' }] }, send);
  const cmd = 'align ';
  const lines = sent[0].prompt.split('\n');
  assert.deepEqual(lines.slice(2, 7), ['1. 调参', '   选择：不调', '   作用范围：以后同类都这样（scope=always）', '   同类：运维参数小改',
    '   先把这条规则写进 First Mate AGENTS.md 授权段（同类：运维参数小改 → 不调），再运行 ' + cmd + "decide done sc a1 'choice=不调' scope=always 'like=运维参数小改'"]);
  assert.deepEqual(lines.slice(8, 13), ['2. 无同类', '   选择：乙', '   作用范围：这个项目（scope=project）', '   同类：本项目的依赖升级',
    '   先把这条规则写进 First Mate AGENTS.md 授权段（只对项目 未归属 生效；同类：本项目的依赖升级 → 乙），再运行 ' + cmd + "decide done sc a2 'choice=乙' scope=project 'like=本项目的依赖升级'"]);
  assert.deepEqual(sent[0].card.decisions.map((x) => x.choice), ['不调（以后同类都这样）', '乙（这个项目都这样）']);
  const D = (id) => r.data.decisions.find((x) => x.id === id);
  assert.deepEqual([D('a1').status, D('a1').scope, D('a1').like], ['sent', 'always', '运维参数小改']);
  // 选了自带 always 的选项、没勾升级：按选项的作用范围
  await run('decide', 'set', 'sc', 'a1', 'status=open');
  sent.length = 0;
  await A.answerBatch('sc', { answers: [{ id: 'a1', choice: '调' }] }, send);
  assert.match(sent[0].prompt, /作用范围：以后同类都这样（scope=always）\n   同类：运维参数小改/);
  // 改成「本次」：scope 删掉
  await run('decide', 'set', 'sc', 'a1', 'status=open');
  await A.answerBatch('sc', { answers: [{ id: 'a1', choice: '不调', scope: 'once' }] }, send);
  assert.equal(read3(f).decisions.find((x) => x.id === 'a1').scope, undefined);
});

test('api 7 长期规则：decide done scope=always 成规则；rule ls / rule revoke；页面撤销是批量项 kind:rule；规则不裁', async () => {
  const f = page7('rl', { decisions: [
    { id: 'restart', title: '什么时候再重启一次 3080', why: 'w', opt: [{ label: '现在', effect: 'a' }, { label: '等早上 06:30 自动升级', effect: 'b' }], status: 'sent', choice: '等早上 06:30 自动升级', risk: '中', cat: '线上配置', like: '需要重启 3080 才生效的改动', updated: t7('08') },
    { id: 'plain', title: '普通', why: 'w', opt: opt7, status: 'done', choice: '甲', updated: t7('08') },
  ] });
  assert.equal(await run('rule', 'ls', 'rl'), '（没有长期规则）');
  await rejects(['decide', 'done', 'rl', 'plain', 'scope=always'], /已经完成/, f);
  assert.match(await run('decide', 'done', 'rl', 'restart', 'choice=等早上 06:30 自动升级', 'scope=always'), /^decide\/restart → 完成/);
  assert.match(await run('rule', 'ls', 'rl'), /^rule\/restart 同类：需要重启 3080 才生效的改动 → 等早上 06:30 自动升级 · /);
  const sent = [];
  await assert.rejects(A.answerBatch('rl', { answers: [{ kind: 'rule', id: 'plain', action: 'revoke' }] }, none), (e) => e.code === 'rule-not-found');
  await assert.rejects(A.answerBatch('rl', { answers: [{ kind: 'rule', id: 'restart', action: 'keep' }] }, none), (e) => e.code === 'bad-action');
  const r = await A.answerBatch('rl', { answers: [{ kind: 'rule', id: 'restart', action: 'revoke', note: '以后都问我' }] }, async (sid, prompt, card) => { sent.push({ prompt, card }); });
  const cmd = 'align ';
  assert.deepEqual(sent[0].prompt.split('\n').slice(2), ['1. 长期规则「需要重启 3080 才生效的改动 → 等早上 06:30 自动升级」（restart）', '   用户选择：撤销', '   备注：以后都问我',
    '   先从 First Mate AGENTS.md 授权段删掉这条规则，再运行 ' + cmd + 'rule revoke rl restart']);
  assert.deepEqual(sent[0].card.decisions, [{ title: '长期规则：需要重启 3080 才生效的改动', choice: '撤销', note: '以后都问我' }]);
  assert.ok(r.data.decisions.find((x) => x.id === 'restart').revokeAsked);
  assert.match(await run('rule', 'revoke', 'rl', 'restart'), /^rule\/restart → 已撤销/);
  const d = read3(f).decisions.find((x) => x.id === 'restart');
  assert.ok(d.revoked && !d.revokeAsked);
  await rejects(['rule', 'revoke', 'rl', 'restart'], /已经撤销/, f);
  await rejects(['rule', 'revoke', 'rl', 'plain'], /不是长期规则/, f);
  assert.equal(await run('rule', 'ls', 'rl'), '（没有长期规则）');
  // 裁剪：done 决定留 20，但没撤销的长期规则不算在内、不裁
  const fp = page7('rlp', { decisions: [
    { id: 'rule1', title: 'r', status: 'done', choice: 'x', scope: 'always', like: '同类', updated: '2026-01-01T00:00:00+08:00' },
    ...Array.from({ length: 25 }, (_, i) => ({ id: 'dd' + i, title: 't', status: 'done', choice: 'x', updated: t7('09') })),
  ] });
  await run('note', 'add', 'rlp', 'n', 'title=x');
  const left = read3(fp).decisions;
  assert.ok(left.some((x) => x.id === 'rule1'));
  assert.equal(left.filter((x) => x.id.startsWith('dd')).length, 20);
});

test('api 7 超时：timeoutCheck 分类；有推荐且非高风险按推荐自动作答（只一次）；高风险 / 无推荐 / 超时超 24 小时只提醒（只一次）', async () => {
  const dec = (id, extra) => ({ id, title: '决定 ' + id, why: 'w', opt: opt7, status: 'open', risk: '中', cat: '其他', rec: '甲', opened: t7('01'), due: t7('09'), updated: t7('01'), ...extra });
  const data = { version: 3, name: 'tm', title: '超时页', owner: 'session-owner', updated: t7('01'), projects: [], rounds: [], notes: [], decisions: [
    dec('auto'), dec('norec', { rec: undefined }), dec('high', { risk: '高' }), dec('stale', { due: '2026-10-22T08:00:00+08:00' }),
    dec('notyet', { due: t7('11') }), dec('nodue', { due: undefined }), dec('reminded', { rec: undefined, overdue: t7('09') }), dec('sent', { status: 'sent', choice: '乙' }),
  ] };
  for (const d of data.decisions) for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  const f = page7('tm', data);
  const now = ms(t7('10'));
  assert.deepEqual(A.timeoutCheck(A.pageData('tm'), now), [
    { id: 'auto', action: 'auto' }, { id: 'norec', action: 'remind', why: 'no-rec' }, { id: 'high', action: 'remind', why: 'high' }, { id: 'stale', action: 'remind', why: 'stale' },
  ]);
  const hi = A.pageData('tm'); hi.timeoutHigh = 'auto';
  assert.deepEqual(A.timeoutCheck(hi, now).find((x) => x.id === 'high'), { id: 'high', action: 'auto' }, 'timeoutHigh=auto 时高风险也自动');
  process.env.ALIGN_NOW = t7('10');
  try {
    const sent = [];
    const send = async (sid, prompt, card) => { sent.push({ sid, prompt, card }); };
    await A.answerTimeout('tm', 'auto', send);
    const cmd = 'align ';
    assert.equal(sent[0].sid, 'session-owner');
    assert.deepEqual(sent[0].prompt.split('\n'), ['对齐页「超时页」上一条决定超时，已按推荐处理：决定 auto（auto）', '原截止：10-23 09:00', '已按推荐「甲」发出（风险 中）。用户可以在页面上改主意，改选会再发一条消息。',
      '请按推荐落实（需要时转给负责的会话），处理完运行 ' + cmd + 'decide done tm auto']);
    assert.deepEqual(sent[0].card, { page: '超时页', decisions: [{ title: '决定 auto', choice: '甲（超时按推荐）', note: '' }] });
    const D = (id) => read3(f).decisions.find((x) => x.id === id);
    assert.deepEqual([D('auto').status, D('auto').choice, D('auto').auto, D('auto').autoAt, D('auto').answered], ['sent', '甲', 'timeout', t7('10'), t7('10')]);
    await assert.rejects(A.answerTimeout('tm', 'auto', send), (e) => e.code === 'not-due', '只处理一次');
    await assert.rejects(A.answerTimeout('tm', 'high', send), (e) => e.code === 'not-due', '高风险不自动');
    await assert.rejects(A.answerTimeout('tm', 'norec', send), (e) => e.code === 'not-due');
    await A.remindOverdue('tm', 'high', send);
    assert.deepEqual(sent[1].prompt.split('\n').slice(0, 3), ['对齐页「超时页」上一条决定已超时，没有自动处理：决定 high（high）', '原截止：10-23 09:00', '原因：风险高，页面设置高风险超时只提醒（timeoutHigh=remind）']);
    assert.match(sent[1].prompt, /decide done tm high 'result=…'/);
    assert.deepEqual(sent[1].card.decisions[0].choice, '已超时，等你定');
    await A.remindOverdue('tm', 'stale', send);
    assert.match(sent[2].prompt, /原因：超时超过 24 小时（多半是 3080 停机期间超时），推荐可能已过时，再问一次/);
    await A.remindOverdue('tm', 'norec', send);
    assert.match(sent[3].prompt, /原因：没有推荐选项/);
    assert.equal(D('high').overdue, t7('10'));
    await assert.rejects(A.remindOverdue('tm', 'high', send), (e) => e.code === 'not-due', '每条只提醒一次');
    await assert.rejects(A.remindOverdue('tm', 'auto', send), (e) => e.code === 'not-due');
    assert.equal(sent.length, 4);
    // 用户改主意：普通答复，消息注明推翻，auto 记录清掉
    process.env.ALIGN_NOW = t7('11');
    await A.answerBatch('tm', { answers: [{ id: 'auto', choice: '乙' }] }, send);
    assert.match(sent[4].prompt, /   推翻超时自动选择（原来按推荐「甲」自动发出）/);
    assert.deepEqual([D('auto').choice, D('auto').auto, D('auto').autoAt], ['乙', undefined, undefined]);
  } finally { delete process.env.ALIGN_NOW; }
});

test('api 7 改截止：批量项 kind:due 只写文件不发消息，清掉 overdue；必须晚于现在、只对 open 决定', async () => {
  const f = page7('du', { decisions: [
    { id: 'o', title: 'o', why: 'w', opt: opt7, status: 'open', risk: '中', cat: '其他', opened: t7('01'), due: t7('09'), overdue: t7('09'), updated: t7('01') },
    { id: 's', title: 's', why: 'w', opt: opt7, status: 'sent', choice: '甲', updated: t7('01') },
  ] });
  process.env.ALIGN_NOW = t7('10');
  try {
    const bad = (answers, code) => assert.rejects(A.answerBatch('du', { answers }, none), (e) => e.code === code, JSON.stringify(answers));
    await bad([{ kind: 'due', id: 'o', due: t7('09') }], 'bad-due');
    await bad([{ kind: 'due', id: 'o', due: '明天' }], 'bad-due');
    await bad([{ kind: 'due', id: 's', due: t7('12') }], 'decision-not-found');
    const r = await A.answerBatch('du', { answers: [{ kind: 'due', id: 'o', due: '2026-10-23T04:00:00Z' }] }, none);
    const o = r.data.decisions.find((x) => x.id === 'o');
    assert.deepEqual([o.due, o.overdue, o.status], [t7('12'), undefined, 'open']);
    assert.equal(r.sid, undefined, '不发消息');
  } finally { delete process.env.ALIGN_NOW; }
});


// ---- 留言框下面的短标签：认出会话 ID、路径、提交号（template.html 的 @text 段）----
test('留言里的会话 ID / 路径 / 提交号：认得出、不误认，发出去的仍是原文', async () => {
  // 正文拆分 2026-10-24 从模板的 @text 段搬进 text-split.mjs（render() 注入页面，同一份代码）
  const { marksOf, tokens } = await import('./text-split.mjs');
  const sid = 'session-c0ffee01-0000-4000-8000-000000000001';
  const msg = '看下 ' + sid + ' 的结果，日志在 D:\\fm-home\\docs\\notes.md, 改动是 08d4c867。另外 ~/.dsh/plugins/dsh-alignment/ 也看看';
  assert.deepEqual(marksOf(msg), [
    { t: 'sid', v: sid },
    { t: 'path', v: 'D:\\fm-home\\docs\\notes.md' },
    { t: 'hash', v: '08d4c867' },
    { t: 'path', v: '~/.dsh/plugins/dsh-alignment/' },
  ]);
  assert.deepEqual(marksOf('只写前缀 session-c0ffee01 也认'), [{ t: 'sid', v: 'session-c0ffee01' }]);
  assert.deepEqual(marksOf(sid + ' 和 ' + sid), [{ t: 'sid', v: sid }], '同一个只出一个标签');
  // 不该认的：普通英文词、纯数字、颜色值、带前缀的 id、太短的十六进制、相对路径、网址
  for (const s of ['deadbeef 是个词', '编号 12345678', '颜色 #2f62d6', 'xabc1234y 夹在词里', 'xsession-c0ffee01-0000-4000-8000-000000000001', 'my-session-c0ffee01', 'session-6d38', '提交 a1b2c3', '文件 src/app.js', '见 https://example.com/a/b', 'ffffffff']) {
    assert.deepEqual(marksOf(s), [], s);
  }
  assert.deepEqual(marksOf('deadbeef'), [], '没有数字的 8 位十六进制是普通词');
  assert.deepEqual(marksOf('cafe1234beef 和 1234abcd'), [{ t: 'hash', v: 'cafe1234beef' }, { t: 'hash', v: '1234abcd' }], '7–12 位且字母数字都有才是提交号');
  // 括号、引号里的也认；路径末尾的英文标点不算路径
  assert.deepEqual(marksOf('（在 C:\\a\\b.txt）和「' + sid + '」'), [{ t: 'path', v: 'C:\\a\\b.txt' }, { t: 'sid', v: sid }]);
  assert.deepEqual(marksOf('见 C:\\a\\b.md.'), [{ t: 'path', v: 'C:\\a\\b.md' }]);
  // 显示成标签不改原文：所有切片拼回去等于原文
  const flat = (ts) => ts.map((x) => (x.t === 'aside' ? '（' + flat(x.v) + '）' : x.v)).join('');
  for (const s of [msg, '（在 C:\\a\\b.txt）', '见 C:\\a\\b.md.']) assert.equal(flat(tokens(s, true)), s);
});

test('留言输入区就地分段：标签和文字拼回去就是原文；光标紧跟着的那个还在打，先不变标签', async () => {
  const { memoSegs } = await import('./text-split.mjs');
  const sid = 'session-c0ffee02-0000-4000-8000-000000000002';
  const s = '看下 ' + sid + ' 为什么停了\n日志 D:\\a\\b.md，提交 08d4c867';
  const g = memoSegs(s);
  assert.deepEqual(g.map((x) => x.t === 'mark' ? x.tk.t : 'text'), ['text', 'sid', 'text', 'path', 'text', 'hash']);
  assert.equal(g.map((x) => (x.t === 'mark' ? x.tk.v : x.v)).join(''), s, '拼回去等于原文');
  assert.deepEqual(memoSegs('普通一句话，没有标签'), [{ t: 'text', v: '普通一句话，没有标签' }]);
  assert.deepEqual(memoSegs(''), []);
  // 正在打路径：光标在路径末尾时不变标签（否则打到一半就锁成一个标签），光标离开后变
  const p = '日志 D:\\fm-home\\do';
  assert.deepEqual(memoSegs(p, p.length).map((x) => x.t), ['text']);
  assert.deepEqual(memoSegs(p, 2).map((x) => x.t), ['text', 'mark']);
  const pd = '日志 D:\\docs\\progress.';
  assert.deepEqual(memoSegs(pd, pd.length).map((x) => x.t), ['text'], '打到扩展名的点号时还算在打');
  assert.deepEqual(memoSegs(pd).map((x) => x.t), ['text', 'mark', 'text'], '光标走开后点号是句末');
  const hc = '修了 abc1234,';
  assert.deepEqual(memoSegs(hc, hc.length).map((x) => x.t), ['text', 'mark', 'text'], '提交号后面打了逗号就成标签（点号规则只对路径）');
  assert.deepEqual(memoSegs(sid + ' ', sid.length + 1).map((x) => x.t), ['mark', 'text'], '打了空格就变标签');
  // 已经是标签的保持原子：紧挨着打字母不拆开、不并进别的词
  const x = 'A X' + sid;
  assert.deepEqual(memoSegs(x).map((g) => g.t), ['text'], '不带位置时「Xsession-…」不是会话 ID');
  const kept = memoSegs(x, null, [{ a: 3, b: 3 + sid.length, t: 'sid' }]);
  assert.deepEqual(kept.map((g) => g.t), ['text', 'mark']);
  assert.equal(kept[1].tk.v, sid);
  assert.equal(kept.map((g) => (g.t === 'mark' ? g.tk.v : g.v)).join(''), x, '拼回去仍是原文');
});

test('留言发出去的是原文：完整会话 ID、完整路径都在，不是短标签', () => {
  const { queueOf, withMemo } = tplSeg('queue', 'queueOf, withMemo');
  const sid = 'session-c0ffee01-0000-4000-8000-000000000001';
  const text = '看下 ' + sid + '\n日志 D:\\fm-home\\docs\\notes.md 提交 08d4c867';
  const q = queueOf(withMemo({}, text), { dec: () => null, round: () => null, act: () => '', from: () => [] });
  assert.deepEqual(q.map((x) => x.answer), [{ kind: 'message', text }]);
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(src, /<span class="qt">' \+ markText\(x\.title\)/, '发送条列表的标题用同样的标签');
  assert.doesNotMatch(src, /id="mks"/, '输入框下面不再另起一排标签');
  assert.match(src, /id="memo-in" contenteditable="true" role="textbox" aria-multiline="true"/, '标签就地显示在输入区里');
  assert.match(src, /@supports not \(\(backdrop-filter:blur\(1px\)\) or \(-webkit-backdrop-filter:blur\(1px\)\)\)\{\.memo,\.memo:has\(\.mi\.empty\),\.mbtn,\.sendbar,\.sendbar:has\(\.blockmsg\)\{background:#fbfbfc\}\.memo:focus-within,\.memo:has\(\.mi\.empty\):focus-within,\.mbtn:hover\{background:#fff\}\}/, '不支持毛玻璃时用不透明浅色底（聚焦 / 悬停也不透明）');
  // 毛玻璃要看得出来，对比度不靠玻璃扛（2026-10-25：0.72 + 20px 在浅色看板上像白底；改 0.5 后背后是墨色块时蓝字只有 2.1:1）
  const glass = /\.memo,\.mbtn,\.sendbar\{background:rgba\(255,255,255,(\.\d+)\);[^}]*backdrop-filter:blur\((\d+)px\)/.exec(src);
  assert.ok(glass, '发送条和留言框同一种毛玻璃');
  assert.ok(+glass[1] >= 0.72 && +glass[2] <= 12, '留言按钮 / 发送条的灰字和图标在墨色背景上也够对比：alpha ' + glass[1] + '，blur ' + glass[2] + 'px');
  const memoA = /\n\.memo\{background:rgba\(255,255,255,(\.\d+)\)\}/.exec(src), emptyA = /\.memo:has\(\.mi\.empty\)\{background:rgba\(255,255,255,(\.\d+)\)\}/.exec(src), focusA = /\.memo:focus-within\{background:rgba\(255,255,255,(\.\d+)\)/.exec(src);
  assert.ok(memoA && +memoA[1] >= 0.5 && +memoA[1] <= 0.6, '有字的留言框透得出背后（正文在最暗背景上仍 ≥4.5:1 要求 ≥0.5）');
  assert.ok(focusA && +focusA[1] <= 0.6, '打字时也还是毛玻璃，不变回白底');
  assert.ok(emptyA && +emptyA[1] >= 0.72, '空框只有占位字，底抬高保对比');
  assert.match(src, /\.mi \.tk\{[^}]*background:#eef0f4/, '框里的短标签是不透明底，蓝字对比和背后无关');
  assert.match(src, /\.blockmsg\{[^}]*background:var\(--asoft\)/, '发送条上的琥珀提示自带不透明底');
  assert.match(src, /\.mnote\{[^}]*background:var\(--asoft\)/, '留言框里的提示条不透明底');
  assert.match(src, /\{\.memo,\.memo:has\(\.mi\.empty\),\.mbtn,\.sendbar,\.sendbar:has\(\.blockmsg\)\{background:#fbfbfc/, '退路盖得住空框那条（选择器更具体）');
  assert.match(src, /@media \(prefers-reduced-transparency:reduce\),\(prefers-contrast:more\)\{/, '提高对比度时也不透明');
  assert.doesNotMatch(src, /\.sendbar\{[^}]*(?:background:#fff|0 0 0 1px)/, '发送条不再是白底描边');
  // 留言框随内容长高（框里不滚，外层 mwrap 滚）、点外面 / 发送后收起（行为在 tmp/probe/align-note-glass/memo-inline.mjs 用真浏览器核对）
  assert.doesNotMatch(src, /\.mi\{[^}]*overflow(?:-y)?:/, '留言输入区自己不滚');
  assert.match(src, /\.mwrap\.over\{[^}]*overflow-y:auto/, '放不下时外层滚（平时 visible，投影不裁）');
  assert.match(src, /downInMemo = memoEl\.contains\(e\.target\) \|\| mbtnEl\.contains\(e\.target\) \|\| \(e\.target === mwrapEl/, '在框里按下再拖出去不算点外面');
  assert.match(src, /if \(DQ\.memo\) openMemo\(false\);/, '点发送收起留言框');
});

// ---- 发送条：待发送列表、单条删除、留言草稿（template.html 的 @queue 段）----
test('待发送列表：决定 / 轮次按选的先后、留言放最后；单条删除只删这一条；留言草稿存进 picks、清空即删', () => {
  const { queueOf, dropPick, withMemo, MEMO_KEY, MEMO_MAX } = tplSeg('queue', 'queueOf, dropPick, withMemo, MEMO_KEY, MEMO_MAX');
  const decs = { d1: { id: 'd1', title: '选库', status: 'open', like: '选库类' }, d2: { id: 'd2', title: '开放问题', status: 'sent' }, d3: { id: 'd3', title: '已处理', status: 'done' } };
  const rounds = { r1: { id: 'r1', title: '估时', status: 'done' }, r2: { id: 'r2', title: '跑着', status: 'doing' } };
  const look = { dec: (id) => decs[id], round: (id) => rounds[id], act: (a) => ({ accept: '确认', revise: '修改', paused: '暂缓' })[a], from: (a) => ({ accept: ['done'], revise: ['done'], paused: ['doing', 'waiting'] })[a] || [] };
  let picks = {};
  picks = withMemo(picks, '  周五前上线\r\n别动库  ');
  picks['d:d1'] = { choice: '乙', note: ' 尽快 ', scope: 'always' };
  picks['r:r1'] = { action: 'revise', note: '标题改短' };
  picks['d:d2'] = { note: '先这样' };
  picks['d:d3'] = { choice: '甲' };
  picks['r:r2'] = { action: 'accept' };
  picks['r:r1x'] = { action: 'paused' };
  const q = queueOf(picks, look);
  assert.deepEqual(q.map((x) => [x.key, x.type, x.title, x.value]), [
    ['d:d1', '决定', '选库', '乙（以后同类） · 尽快'],
    ['r:r1', '轮次', '估时', '修改 · 标题改短'],
    ['d:d2', '决定', '开放问题', '先这样'],
    [MEMO_KEY, '留言', '周五前上线 别动库', ''],
  ]);
  assert.deepEqual(q.map((x) => x.answer), [
    { id: 'd1', choice: '乙', note: '尽快', scope: 'always', like: '选库类' },
    { kind: 'round', id: 'r1', action: 'revise', note: '标题改短' },
    { id: 'd2', note: '先这样' },
    { kind: 'message', text: '周五前上线\n别动库' },
  ]);
  assert.equal(picks[MEMO_KEY].text, '  周五前上线\r\n别动库  ', '草稿存原文');
  const after = dropPick(picks, 'r:r1');
  assert.deepEqual(queueOf(after, look).map((x) => x.key), ['d:d1', 'd:d2', MEMO_KEY]);
  assert.ok(picks['r:r1'], 'dropPick 不改原对象');
  assert.deepEqual(queueOf(dropPick(picks, MEMO_KEY), look).map((x) => x.key), ['d:d1', 'r:r1', 'd:d2']);
  assert.equal(withMemo(picks, '   \n ')[MEMO_KEY], undefined, '清空留言 = 删掉这一项');
  assert.deepEqual(queueOf(withMemo({}, 'x'.repeat(MEMO_MAX + 50)), look)[0].answer.text.length, MEMO_MAX);
  assert.equal(MEMO_MAX, A.MESSAGE_MAX, '页面上限与服务端一致');
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(src, new RegExp('id="memo-in"[^>]*data-max="' + A.MESSAGE_MAX + '"'));
  assert.match(src, /const picksKey = 'align-picks:' \+ data\.name;/, '留言草稿和已选内容共用 align-picks:<页>');
  assert.match(src, /if \(changed && kind !== 'load'\) \{ picks = withMemo\(picks, s\); savePicks\(\);/, '输入即存本机');
  assert.match(src, /aria-expanded="' \+ DQ\.list \+ '" aria-controls="queue"/);
});

test('留言带图：发送条列表的留言行写「N 张图」，只有图片时标题就是它；草稿只存传好的路径；改字不丢图', () => {
  const { queueOf, withMemo, memoIntake, MEMO_KEY, MEMO_IMAGES_MAX, MEMO_IMAGE_BYTES } = tplSeg('queue', 'queueOf, withMemo, memoIntake, MEMO_KEY, MEMO_IMAGES_MAX, MEMO_IMAGE_BYTES');
  assert.equal(MEMO_IMAGES_MAX, A.MEMO_IMAGES_MAX, '页面上限与服务端一致');
  assert.equal(MEMO_IMAGE_BYTES, A.MEMO_IMAGE_BYTES);
  const look = { dec: () => null, round: () => null, act: () => '', from: () => [] };
  let picks = withMemo({}, '看看这个', ['C:\\x\\a.png', 'C:\\x\\b.png']);
  let q = queueOf(picks, look);
  assert.deepEqual(q.map((x) => [x.type, x.title, x.value]), [['留言', '看看这个', '2 张图']]);
  assert.deepEqual(q[0].answer, { kind: 'message', text: '看看这个', images: ['C:\\x\\a.png', 'C:\\x\\b.png'] });
  picks = withMemo(picks, '看看这个吧');
  assert.deepEqual(picks[MEMO_KEY].images, ['C:\\x\\a.png', 'C:\\x\\b.png'], '只改字：图片还在');
  picks = withMemo(picks, '', ['C:\\x\\a.png']);
  q = queueOf(picks, look);
  assert.deepEqual(q.map((x) => [x.type, x.title, x.value]), [['留言', '1 张图', '']], '只有图片：标题写图片数');
  assert.deepEqual(q[0].answer, { kind: 'message', text: '', images: ['C:\\x\\a.png'] });
  assert.equal(withMemo(picks, '', [])[MEMO_KEY], undefined, '字和图都删光 = 删掉这一项');
  assert.deepEqual(queueOf(withMemo({}, '只有字'), look)[0].answer, { kind: 'message', text: '只有字' }, '没有图不带 images');
  // 粘贴 / 拖进来的文件：只收四种图片、单张不超、最多 5 张，放不进来的给一句话
  const png = { type: 'image/png', size: 1000 };
  assert.deepEqual(memoIntake([png, png], 0), { take: [0, 1], note: '' });
  assert.deepEqual(memoIntake([png, png, png], 3), { take: [0, 1], note: '一条留言最多 5 张图片，多出的 1 张没加上' });
  assert.deepEqual(memoIntake([png], 5), { take: [], note: '一条留言最多 5 张图片' });
  assert.deepEqual(memoIntake([{ type: 'image/png', size: MEMO_IMAGE_BYTES + 1 }], 0), { take: [], note: '图片超过 20 MB，没加上' });
  assert.deepEqual(memoIntake([png, { type: 'image/jpeg', size: MEMO_IMAGE_BYTES + 1 }, { type: 'image/gif', size: MEMO_IMAGE_BYTES + 9 }], 0), { take: [0], note: '2 张图片超过 20 MB，没加上' });
  assert.deepEqual(memoIntake([{ type: 'application/pdf', size: 10 }], 0), { take: [], note: '仅支持 PNG、JPG、WebP、GIF 格式的图片' });
  assert.deepEqual(memoIntake([{ type: 'image/svg+xml', size: 10 }, png], 0), { take: [1], note: '仅支持 PNG、JPG、WebP、GIF 格式的图片' });
});

// ---- 页面里内联的四栏 / 排序（template.html 的 @columns / @sort 段）必须和 align.mjs 导出的一致 ----
const tplSeg = (name, ret) => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('// @' + name + '-begin'), b = src.indexOf('// @' + name + '-end');
  assert.ok(a >= 0 && b > a, 'template.html 缺 @' + name + ' 段');
  return new Function(src.slice(a, b) + '\nreturn { ' + ret + ' };')();
};

test('模板 @columns 段：四栏判定与 align.mjs 的 columnOf 一致（含 live 为 null / unknown / 缺 sid）', () => {
  const T = tplSeg('columns', 'columnOf, isClosed, isFinished');
  const statuses = ['doing', 'waiting', 'paused', 'done', 'accepted', 'dropped'];
  const lives = [null, {}, { s: 'running' }, { s: 'subagent' }, { s: 'job' }, { s: 'idle' }, { s: 'unknown' }];
  const decs = [[], [{ status: 'open' }], [{ status: 'pending' }], [{ status: 'sent' }], [{ status: 'open' }, { status: 'pending' }]];
  let n = 0;
  for (const status of statuses) for (const fault of [undefined, { at: '2026-10-22T20:00:00+08:00', msg: '429' }]) for (const sid of ['s', undefined]) for (const ds of decs) for (const live of lives) {
    const r = { id: 'r', status, sid, fault };
    const data = { decisions: ds.map((d, i) => ({ id: 'd' + i, round: 'r', ...d })) };
    assert.deepEqual(T.columnOf(data, r, live), A.columnOf(data, r, live), JSON.stringify({ r, ds, live }));
    assert.equal(T.isClosed(r), A.isClosed(r)); assert.equal(T.isFinished(r), A.isFinished(r));
    n++;
  }
  assert.ok(n > 500);
});

test('模板 @sort 段：决定子卡与阻塞栏排序和 align.mjs 的 sortDecisions / sortBlocked 一致', () => {
  const T = tplSeg('sort', 'sortDecisions, sortBlocked');
  const now = Date.parse('2026-10-22T20:50:00+08:00');
  const t = (h) => '2026-10-22T' + h + ':00+08:00';
  const ds = [
    { id: 'a', risk: '中', opened: t('18:00') }, { id: 'b', risk: '高', opened: t('19:00') }, { id: 'c', opened: t('17:00') },
    { id: 'd', risk: '低', updated: t('16:00') }, { id: 'e', risk: '高', opened: t('18:30'), overdue: t('20:00') }, { id: 'f', risk: '中' },
  ];
  const ids = (l) => l.map((x) => x.id);
  for (let k = 0; k < ds.length; k++) { const l = [...ds.slice(k), ...ds.slice(0, k)]; assert.deepEqual(ids(T.sortDecisions(l, now)), ids(A.sortDecisions(l, now))); }
  const cards = [
    { id: 'p', reason: 'paused', decisions: [] }, { id: 's', reason: 'stopped', decisions: [] }, { id: 'f', reason: 'fault', decisions: [] },
    { id: 'i', reason: 'info', decisions: [] }, { id: 'w', reason: 'answer', decisions: [], answer: t('17:30') },
    { id: 'h', reason: 'decide', decisions: [ds[1], ds[0]] }, { id: 'o', reason: 'decide', decisions: [ds[4]] }, { id: 'l', reason: 'decide', decisions: [ds[3]] },
  ];
  for (let k = 0; k < cards.length; k++) { const l = [...cards.slice(k), ...cards.slice(0, k)]; assert.deepEqual(ids(T.sortBlocked(l, now)), ids(A.sortBlocked(l, now))); }
  assert.deepEqual(ids(T.sortBlocked(cards, now)).slice(0, 2), ['o', 'h'], '超时的最前，其次高风险');
});

// ---- 按项目分组(模板 @group 段 + 渲染出的组头)----------------------------------------------------
test('按项目分组:组按组内最急的卡排序、组内顺序不变、空项目不出;阻塞 / 完成 / 进行中 / 已结束四栏都按项目出组头', async () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('// @group-begin'), src.indexOf('// @group-end'));
  assert.ok(body.length > 0, '模板里要有 @group 段');
  const groupByProject = new Function(body + '; return groupByProject;')();
  const cards = [{ id: 'a', p: 'x' }, { id: 'b', p: 'y' }, { id: 'c', p: 'x' }, { id: 'd', p: '' }];
  const gs = groupByProject(cards, (c) => c.p);
  assert.deepEqual(gs.map((g) => [g.pid, g.items.map((c) => c.id).join('')]), [['x', 'ac'], ['y', 'b'], ['', 'd']]);
  assert.deepEqual(groupByProject([], (c) => c.p), []);
  // 渲染出的三栏都调用 projGroup(防止像 v7 初版那样只给「进行中」分组)
  for (const col of ['blk', 'done', 'doing', 'end']) assert.match(src, new RegExp("grp\\('" + col + "', groupByProject\\("), col + ' 栏要按项目分组');
});

// ---- 项目顺序（api 10）：「已完成」栏拖出来的 projOrder，各栏跟随 ----------------------------------------
test('项目顺序：orderGroups 按 projOrder 排、新项目按默认顺序排在后面；mergeOrder 保留栏里没出现的；各栏和决定列表都经 orderGroups', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('// @group-begin'), src.indexOf('// @group-end'));
  const { orderGroups, mergeOrder } = new Function(body + '; return { orderGroups, mergeOrder };')();
  const gs = ['x', 'new1', 'y', '', 'new2'].map((pid) => ({ pid }));
  const pids = (l) => l.map((g) => g.pid);
  assert.deepEqual(pids(orderGroups(gs, ['y', 'x', ''])), ['y', 'x', '', 'new1', 'new2'], '排过的在前，新项目按原来的默认顺序接在后面');
  assert.deepEqual(pids(orderGroups(gs, undefined)), pids(gs), '没排过就是默认顺序');
  assert.deepEqual(pids(orderGroups(gs, ['gone', 'y'])), ['y', 'x', 'new1', '', 'new2'], '已不在栏里的 id 不影响');
  assert.deepEqual(mergeOrder(['b', 'a'], ['a', 'z', 'b']), ['b', 'a', 'z'], '这次栏里没有的项目（z）留在顺序里');
  assert.deepEqual(mergeOrder(['b', 'a'], undefined), ['b', 'a']);
  // 进行中 / 阻塞 / 待验收 / 已完成四栏都用 grp（→ orderGroups(…, data.projOrder)），左栏决定列表也是
  assert.match(src, /const grp = \(k, gs\) => orderGroups\(gs, data\.projOrder\)/);
  assert.match(src, /return orderGroups\(pgs, data\.projOrder\)\.map\(\(pg\) => '<section class="dg"/);
});

test('项目顺序：POST /order 存进页面 projOrder，读回、刷新模板、meta 清掉都对；坏请求不改文件', async () => {
  const f = page7('ord', {
    projects: [{ id: 'pa', title: '甲', cwd: 'C:/a' }, { id: 'pb', title: '乙', cwd: 'C:/b' }, { id: 'pc', title: '丙', cwd: 'C:/c' }],
    rounds: [{ id: 'r1', title: '一', status: 'accepted', proj: 'pa' }, { id: 'r2', title: '二', status: 'accepted', proj: 'pb' }],
  });
  const h = A.createHandler({ prefix: '', send: async () => {}, guard: () => null, live: null });
  const srv = http.createServer(h);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + srv.address().port;
    const post = (body) => fetch(base + '/p/ord/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await post({ order: ['pb', '', 'pa'] });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).data.projOrder, ['pb', '', 'pa']);
    assert.deepEqual(read3(f).projOrder, ['pb', '', 'pa'], '写进页面文件');
    assert.deepEqual((await (await fetch(base + '/p/ord/data')).json()).projOrder, ['pb', '', 'pa'], '/data 读回');
    assert.match(fs.readFileSync(f, 'utf8'), /\n"projOrder":\["pb","","pa"\],\n/, '顶层单独一行');
    const snap = fs.readFileSync(f, 'utf8');
    for (const [body, re] of [[{ order: ['nope'] }, /没有项目 nope/], [{ order: ['pa', 'pa'] }, /重复/], [{ order: 'pa' }, /数组/], [{}, /数组/]]) {
      const x = await post(body);
      assert.equal(x.status, 400, JSON.stringify(body));
      assert.match((await x.json()).message, re);
    }
    assert.equal(fs.readFileSync(f, 'utf8'), snap, '坏请求不改文件');
    // 别的写入（CLI）和 refresh 保留它
    await run('round', 'set', 'ord', 'r1', 'state=x');
    await run('refresh', 'ord');
    assert.deepEqual(read3(f).projOrder, ['pb', '', 'pa']);
    // meta 也能改 / 清
    await run('meta', 'ord', 'projOrder=pa,pb');
    assert.deepEqual(read3(f).projOrder, ['pa', 'pb']);
    await rejects(['meta', 'ord', 'projOrder=pa,zz'], /projOrder 里的 zz 不在 projects 里/, f);
    // 空数组 = 恢复默认
    assert.equal((await post({ order: [] })).status, 200);
    assert.equal('projOrder' in read3(f), false);
  } finally { srv.close(); }
});

// ---- 会话小卡用时圆环（模板 @ring 段）----------------------------------------------------------------
test('用时圆环:一圈 = 预计;超出后换下一色从头画,满 4 圈保持满圈;没有预计不画', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('// @ring-begin'), src.indexOf('// @ring-end'));
  assert.ok(body.length > 0, '模板里要有 @ring 段');
  const ringOf = new Function(body + '; return ringOf;')();
  const H = 36e5;
  assert.equal(ringOf(H, 0), null);
  assert.equal(ringOf(H, undefined), null);
  assert.deepEqual(ringOf(0, H), { lap: 1, frac: 0 });
  assert.deepEqual(ringOf(H / 4, H), { lap: 1, frac: 0.25 });
  assert.deepEqual(ringOf(H, H), { lap: 2, frac: 0 }, '刚好用完:第 1 圈满,第 2 圈从头');
  assert.deepEqual(ringOf(1.5 * H, H), { lap: 2, frac: 0.5 });
  assert.deepEqual(ringOf(3.25 * H, H), { lap: 4, frac: 0.25 });
  assert.deepEqual(ringOf(4 * H, H), { lap: 4, frac: 1 });
  assert.deepEqual(ringOf(9 * H, H), { lap: 4, frac: 1 }, '超过 4 圈保持满圈红');
  // ringLook(x)：底圈 = 上一圈的颜色（第 1 圈灰轨道，满 4 圈也是红），本圈弧长只用 stroke-dashoffset（100 = 空，0 = 满），圈心点数 = 已超出的整圈数
  const ringLook = new Function(body + '; return ringLook;')();
  const look = (x) => { const v = ringLook(x); return [v.lap, v.under, v.arc, v.off, v.n]; };
  assert.deepEqual(look(0), [1, 'var(--track)', 'var(--lap1)', '100.00', 0]);
  assert.deepEqual(look(0.25), [1, 'var(--track)', 'var(--lap1)', '75.00', 0]);
  assert.deepEqual(look(1), [2, 'var(--lap1)', 'var(--lap2)', '100.00', 1], '刚好一圈：满圈蓝 / 灰，黄从起点开始');
  assert.deepEqual(look(2.5), [3, 'var(--lap2)', 'var(--lap3)', '50.00', 2]);
  assert.deepEqual(look(4), [4, 'var(--lap4)', 'var(--lap4)', '0.00', 3], '满 4 圈：底圈和弧都是红');
  assert.deepEqual(look(9), look(4));
  assert.match(src, /ringHtml\(r, p\b/, '会话小卡要画圆环');
  // 会话小卡：预计只认轮次登记的（First Mate 2026-10-24 定）；进行中 / 阻塞照样画进度条（用户 2026-10-24 要回来）；没登记预计又没交结果的只写已用、不画进度条
  const card = src.slice(src.indexOf('function sessCard('), src.indexOf('function projGroup('));
  assert.match(card, /const total = dur\(r\.etaadj \|\| r\.eta\)/, '小卡预计 = etaadj，没有就 eta，不用待办估时合计');
  assert.match(card, /const bar = !total && !fin \? '' :/, '只有没登记预计又没交结果的不画进度条');
});

// ---- 已用 = 主回合 ∪ 子 agent / 后台任务（模板 @busy 段；2026-10-24）-------------------------------------------
test('已用口径：模板 @busy 段合并区间和 todos.js 同一规则；悬停拆分两部分加起来等于显示的已用', async () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('// @busy-begin'), src.indexOf('// @busy-end'));
  assert.ok(body.length > 0, '模板里要有 @busy 段');
  const short = (t) => Math.floor(t / 6e4) + 'm';
  const { mergeSpans, spanIn, splitTip, minusSpans, busyOf } = new Function('short', body + '; return { mergeSpans, spanIn, splitTip, minusSpans, busyOf };')(short);
  const server = await import('../todos.js');
  let seed = 7;
  const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  for (let k = 0; k < 300; k++) {
    const spans = Array.from({ length: rnd(8) }, () => { const a = rnd(100); return [a, rnd(5) === 0 ? null : a + rnd(30)]; });
    assert.deepEqual(mergeSpans(spans), server.mergeSpans(spans), JSON.stringify(spans));
    const holes = server.mergeSpans(Array.from({ length: rnd(4) }, () => { const a = rnd(100); return [a, rnd(5) === 0 ? null : a + rnd(30)]; }));
    assert.deepEqual(minusSpans(server.mergeSpans(spans), holes), server.minusSpans(server.mergeSpans(spans), holes), JSON.stringify([spans, holes]));
  }
  // 后台任务在等你决定的时间段里不算，子 agent 照算：主回合 0–5，子 agent 10–20，后台任务 0–40，等决定 15–30 → 0–20、30–40
  assert.deepEqual(busyOf([[0, 5]], { subagent: [[10, 20]], job: [[0, 40]] }, [[15, 30]]), [[0, 20], [30, 40]]);
  const M = 6e4;
  // 主回合 0–10、30–40；子 agent 1–32 → 已用 0–40；这一轮从 5 开始、现在 = 35
  const busy = mergeSpans([[0, 10 * M], [30 * M, 40 * M]].concat([[1 * M, 32 * M]]));
  assert.deepEqual(busy, [[0, 40 * M]]);
  assert.equal(spanIn(busy, 5 * M, 35 * M, 35 * M), 30 * M);
  assert.equal(spanIn([[0, null]], 5 * M, 35 * M, 35 * M), 30 * M, '没结束的区间算到现在');
  assert.equal(splitTip(30 * M + 59e3, 10 * M + 30e3, Math.floor), '其中主回合 10m，子 agent 和后台任务 20m', '30m59s = 10m（取整后）+ 20m');
  assert.equal(splitTip(10 * M + 50e3, 10 * M, Math.floor), '', '子 agent 和后台任务不到 1 分钟不写');
  assert.equal(splitTip(12 * M, null, Math.floor), '', '旧服务端（没有主回合的数）不写');
  assert.equal(splitTip(4 * M + 40e3, 2 * M + 20e3, Math.round), '其中主回合 2m，子 agent 和后台任务 3m', '待办按四舍五入：5m = 2m + 3m');
  // 所有用到已用的地方都走同一份：轮次的 prog（小卡、圆环、详情用时卡）和待办单项都合并 activity 与 background
  assert.match(src, /el: spanIn\(minusSpans\(busyOf\(a, b, waitsOf\(r\.sid\)\), pz\), lo, hi, now\)/, '轮次已用 = activity ∪ 子 agent ∪ (后台任务 − 等你决定)，再去掉暂缓时段（api 15）');
  assert.match(src, /const busy = b \? busyOf\(a, b, waitsOf\(sid\)\) : a;/, '待办已用同一口径');
  assert.match(src, /const bb = j && j\.background;/, '页面读 /alignment/todos 的 background');
});

// ---- v8：待验收「修改」、开放问题（没有选项的决定）---------------------------------------------------
test('v8 round revise：只对 done，意见必填，消息里带意见和返工命令；开放问题可以没有选项、文字答复、旧格式投影成等你回答', async () => {
  const sent = [];
  const send = async (sid, msg) => { sent.push(msg); };
  page7('v8a', {
    rounds: [{ id: 'r1', title: '交了', status: 'done', sid: 'session-5b511f81-0000-4000-8000-100000000000' }, { id: 'r2', title: '在跑', status: 'doing', sid: 'session-58511ac8-0000-4000-8000-200000000000' }],
    decisions: [{ id: 'q1', title: '手机插好了吗', why: '要装 local.10', status: 'open', round: 'r2' }],
  });
  await assert.rejects(A.answerBatch('v8a', { answers: [{ kind: 'round', id: 'r1', action: 'revise' }] }, send), (e) => e.code === 'needs-note');
  await assert.rejects(A.answerBatch('v8a', { answers: [{ kind: 'round', id: 'r2', action: 'revise', note: 'x' }] }, send), (e) => e.code === 'bad-action');
  const r = await A.answerBatch('v8a', { answers: [{ kind: 'round', id: 'r1', action: 'revise', note: '按钮再大一点' }, { id: 'q1', note: '插好了，已解锁' }] }, send);
  assert.match(sent[0], /用户选择：修改/);
  assert.match(sent[0], /备注：按钮再大一点/);
  // 「修改」= 登记一轮续发（2026-11-03：只 round set status=doing 时页面数不到续发 ⟲N）
  assert.match(sent[0], /align dispatch v8a r1-2 --prompt-file <返工任务文件> --prev r1 --mode continue 'title=返工：交了' 'why=用户点了修改' eta=… eta75=… etaconf=…/);
  assert.match(sent[0], /--mode new --handoff <交接文件>/, '换会话的写法也给');
  assert.doesNotMatch(sent[0], /status=doing/, '不再给 round set status=doing 这条路');
  assert.match(sent[0], /用户回复：插好了，已解锁/);
  assert.doesNotMatch(sent[0], /备注：插好了/, '只写了文字时不再重复成备注');
  const r1 = r.data.rounds.find((x) => x.id === 'r1'), q1 = r.data.decisions.find((x) => x.id === 'q1');
  assert.deepEqual([r1.status, r1.ask, r1.asknote], ['done', 'revise', '按钮再大一点']);
  assert.deepEqual([q1.status, q1.choice, q1.reply], ['sent', '', '插好了，已解锁']);
  const legacy = A.legacyView(r.data);
  const it = legacy.items.find((x) => x.id === 'q1');
  assert.deepEqual([it.sec, it.who], ['doing', 'agent'], 'sent 的开放问题投影成进行中、轮到会话');
});

test('「修改」的续发命令：id 顺延到没用过的 -N；原轮次带着修改请求时 round set status=doing 被拒、给 dispatch 命令', async () => {
  const sent = [];
  const send = async (sid, msg) => { sent.push(msg); };
  const sidA = 'session-5b511f81-0000-4000-8000-100000000001';
  page7('rv2', {
    rounds: [
      { id: 'fix', title: '修一下', status: 'done', sid: sidA },
      { id: 'fix-2', title: '旧的续发', status: 'accepted', sid: sidA, prev: 'fix', mode: 'continue' },
      { id: 'job-2', title: '第二轮', status: 'done', sid: sidA },
      { id: 'z', title: '别的', status: 'done', sid: sidA },
    ],
  });
  await A.answerBatch('rv2', { answers: [{ kind: 'round', id: 'fix', action: 'revise', note: '再短一点' }, { kind: 'round', id: 'job-2', action: 'revise', note: '换个色' }] }, send);
  assert.match(sent[0], /dispatch rv2 fix-3 --prompt-file/, 'fix-2 已被占用，顺延到 fix-3');
  assert.match(sent[0], /dispatch rv2 job-3 --prompt-file .* --prev job-2 --mode continue/, '本身是 -2 的接着编号成 -3，不叠成 job-2-2');
  await rejects(['round', 'set', 'rv2', 'fix', 'status=doing', 'state=返工'], /用户点了「修改」.*align dispatch rv2 fix-3 --prompt-file <返工任务文件> --prev fix --mode continue/s, path.join(dir, 'rv2.html'));
  // 没有修改请求的 done 轮次照常能改回 doing
  assert.match(await run('round', 'set', 'rv2', 'z', 'status=doing'), /^改了 round\/z 的 status/);
});

test('v8 校验：开放问题不能写 rec；有选项时仍要 ≥2 个', () => {
  const base = { version: 3, name: 'v', title: 't', projects: [], rounds: [], notes: [] };
  assert.throws(() => A.validate({ ...base, decisions: [{ id: 'q', title: 'q', why: 'w', status: 'open', rec: 'a' }] }), /不能写 rec/);
  assert.throws(() => A.validate({ ...base, decisions: [{ id: 'q', title: 'q', why: 'w', status: 'open', opt: [{ label: 'a', effect: 'e' }] }] }), /至少 2 个选项/);
  A.validate({ ...base, decisions: [{ id: 'q', title: 'q', why: 'w', status: 'open', opt: [] }] });
  A.validate({ ...base, decisions: [{ id: 'q', title: 'q', why: 'w', status: 'open' }] });
});

test('v8 kpi：decide / round 的 add、set 可带 kpi=标签::数值[::对比值]，可重复、最多 4 个，kpi= 清空；格式不对报错；手机投影不带', async () => {
  page7('kp', { projects: [{ id: 'ws-k', title: 'K', cwd: 'C:/k' }], rounds: [{ id: 'kr', title: '轮', status: 'doing', sid: 'session-kk', proj: 'ws-k' }] });
  const out = (...a) => run(...a);
  await out('decide', 'add', 'kp', 'kd', '--round', 'kr', 'title=要不要换', 'why=显存不够', 'opt=换::多 30 分钟', 'opt=不换::到此为止', 'risk=低', 'cat=方向取舍', 'kpi=显存::15.2 / 16.3 GB', 'kpi=错字率::9.2%::47.6%');
  const rd = () => A.parsePage(fs.readFileSync(path.join(dir, 'kp.html'), 'utf8'));
  assert.deepEqual(rd().decisions[0].kpi, [{ label: '显存', value: '15.2 / 16.3 GB' }, { label: '错字率', value: '9.2%', from: '47.6%' }]);
  await out('round', 'set', 'kp', 'kr', 'kpi=开口 p95::2.8 秒');
  assert.deepEqual(rd().rounds[0].kpi, [{ label: '开口 p95', value: '2.8 秒' }]);
  await out('round', 'set', 'kp', 'kr', 'kpi=');
  assert.equal(rd().rounds[0].kpi, undefined, 'kpi= 清空');
  await assert.rejects(out('round', 'set', 'kp', 'kr', 'kpi=只有标签'), /kpi 要写成 kpi="标签::数值\[::对比值\]"/);
  await assert.rejects(out('round', 'set', 'kp', 'kr', 'kpi=a::1', 'kpi=b::2', 'kpi=c::3', 'kpi=d::4', 'kpi=e::5'), /kpi 要 1–4 个/);
  await assert.rejects(out('round', 'set', 'kp', 'kr', 'kpi=这是一个特别特别长的标签名字::1'), /标签最多 12 个字/);
  const legacy = A.legacyView(rd());
  assert.ok(legacy.items.every((x) => x.kpi === undefined), '手机投影不带 kpi');
});

// ---- 页面视图（选中项 / 页签 / 滚动）在别的会话里接着看：template.html 的 @view 段 ----
test('页面视图：选中项还在才恢复；页签只认 dec / sess；滚动取非负数；乱数据退回默认', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('// @view-begin'), b = src.indexOf('// @view-end');
  assert.ok(a >= 0 && b > a, 'template.html 缺 @view 段');
  const { viewOf } = new Function(src.slice(a, b) + '\nreturn { viewOf };')();
  const has = (k) => ['d:pick', 'r:r1'].includes(k);
  assert.deepEqual(viewOf({ sel: 'd:pick', tab: 'dec', scroll: { left: 120.4, right: 300, board: 0 } }, has), { sel: 'd:pick', tab: 'dec', scroll: { left: 120, right: 300, board: 0 } });
  assert.deepEqual(viewOf({ sel: 'd:gone', tab: 'dec', scroll: { right: 50 } }, has), { sel: null, tab: null, scroll: { right: 50 } }, '条目已不在：不恢复选中，滚动照样恢复');
  assert.deepEqual(viewOf({ sel: 'r:r1', tab: 'evil', scroll: { left: -5, right: 'x', board: Infinity } }, has), { sel: 'r:r1', tab: null, scroll: {} });
  assert.deepEqual(viewOf({ sel: 'd:pick"><img', scroll: null }, () => true), { sel: null, tab: null, scroll: {} }, 'sel 只认 id 字符');
  for (const junk of [null, 'x', 42, []]) assert.deepEqual(viewOf(junk, has), { sel: null, tab: null, scroll: {} });
});

// ---- 会话详情里的会话链：template.html 的 @chain 段 ----
test('会话链：从最早到最新列出整条链，成环不死循环；链长时只留首尾和当前前后', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('// @chain-begin'), b = src.indexOf('// @chain-end');
  assert.ok(a >= 0 && b > a, 'template.html 缺 @chain 段');
  const { chainOf, chainShown, chainLabels } = new Function(src.slice(a, b) + '\nreturn { chainOf, chainShown, chainLabels };')();
  // 5 个会话 s0 → s4：s(i).from = s(i-1) 的最后一轮，s(i).next = s(i+1)
  const ss = Array.from({ length: 5 }, (_, i) => ({ key: 's' + i, last: { id: 'r' + i } }));
  const ofRound = new Map(ss.map((s) => [s.last.id, s]));
  ss.forEach((s, i) => { s.from = i ? ss[i - 1].last : null; s.next = ss[i + 1] || null; });
  const keys = (l) => l.map((s) => s.key).join(',');
  assert.equal(keys(chainOf(ss[2], ofRound)), 's0,s1,s2,s3,s4', '中间的会话也看到整条链');
  assert.equal(keys(chainOf(ss[0], ofRound)), 's0,s1,s2,s3,s4');
  assert.equal(keys(chainOf(ss[4], ofRound)), 's0,s1,s2,s3,s4');
  const solo = { key: 'x', last: { id: 'rx' }, from: null, next: null };
  assert.equal(chainOf(solo, ofRound).length, 1, '没有接续：只有自己（页面上不显示）');
  ss[0].from = ss[4].last; ss[4].next = ss[0]; // 数据成环
  assert.equal(chainOf(ss[2], ofRound).length, 5, '成环时每个会话只出现一次');
  assert.deepEqual(chainShown(5, 2, false), [0, 1, 2, 3, 4], '不超过 6 个全显示');
  assert.deepEqual(chainShown(9, 2, false), [0, 1, 2, 3, 8], '长链：首、当前前后、尾');
  assert.deepEqual(chainShown(9, 8, false), [0, 7, 8]);
  assert.deepEqual(chainShown(9, 4, true), [...Array(9).keys()], '展开后全显示');
  assert.deepEqual(chainLabels(['旁白第 1 轮：接事件', '旁白第 12 轮：两级生成']), ['接事件', '两级生成'], '同一系列头（只差数字）去掉');
  assert.deepEqual(chainLabels(['旁白第 1 轮：接事件', '字典：并入致歉']), ['旁白第 1 轮：接事件', '字典：并入致歉'], '系列头不同：原样');
  assert.deepEqual(chainLabels(['旁白第 1 轮：接事件', '常驻服务统一自动拉起']), ['旁白第 1 轮：接事件', '常驻服务统一自动拉起'], '有一项没有系列头：原样');
  assert.deepEqual(chainLabels(['旁白第 8 轮：调延迟', '旁白第 9 轮：调延迟']), ['旁白第 8 轮：调延迟', '旁白第 9 轮：调延迟'], '去掉后会重名：原样');
});

// ---- 两条分隔条的位置（存取、上下限）：template.html 的 @split 段 ----
test('分隔条：存下的高度 / 比例只认合法数字；上下限不把任一块挤没，窄屏和矮屏按比例放宽', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('// @split-begin'), b = src.indexOf('// @split-end');
  assert.ok(a >= 0 && b > a, 'template.html 缺 @split 段');
  const { splitOf, hRange, wRange, clampTo } = new Function(src.slice(a, b) + '\nreturn { splitOf, hRange, wRange, clampTo };')();
  assert.deepEqual(splitOf({ h: 412.6, w: 0.31234 }), { h: 413, w: 0.3123, d: null });
  assert.deepEqual(splitOf({ h: 0, w: 1 }), { h: null, w: null, d: null }, '0 高、整宽都不算');
  assert.deepEqual(splitOf({ h: -5, w: -0.2, d: 0 }), { h: null, w: null, d: null });
  assert.deepEqual(splitOf({ h: '400', w: NaN, d: '700' }), { h: null, w: null, d: null });
  assert.deepEqual(splitOf({ h: Infinity, w: 0.5 }), { h: null, w: 0.5, d: null });
  assert.deepEqual(splitOf({ h: 300 }), { h: 300, w: null, d: null }, '只存了一条也能用');
  assert.deepEqual(splitOf({ d: 700.4 }), { h: null, w: null, d: 700 }, '看文档时的高度另存在 d');
  for (const junk of [null, undefined, 'x', 42, []]) assert.deepEqual(splitOf(junk), { h: null, w: null, d: null });
  // 1280×800 一类：详情区 180..(总高-140)
  assert.deepEqual(hRange(754), [180, 614]);
  assert.equal(clampTo(50, hRange(754)), 180, '拖到最上详情区仍留 180');
  assert.equal(clampTo(9000, hRange(754)), 614, '拖到最下会话区仍留 140');
  // 矮窗口：两块各至少 30%
  assert.deepEqual(hRange(300), [90, 210]);
  // 宽：1280 下左栏 240..960（右栏留 320）；侧栏约 420 宽时左栏 147（默认）..190（右栏留 230）
  assert.deepEqual(wRange(1280), [240, 960]);
  assert.deepEqual(wRange(420), [147, 190]);
  assert.equal(clampTo(10, wRange(420)), 147, '窄屏往左拖到底就是默认位置，不会比默认更宽');
  assert.equal(clampTo(400, wRange(420)), 190);
  assert.deepEqual(wRange(600), [210, 360], '默认比 240 窄时以默认为下限');
  assert.deepEqual(wRange(300), [105, 105], '放不下时只留默认');
  for (const W of [300, 420, 800, 1280, 2560]) { const [lo, hi] = wRange(W); assert.ok(lo > 0 && lo <= W * 0.35 && lo <= hi && hi < W, 'W=' + W); }
  for (const W of [420, 800, 1280, 2560]) { const [, hi] = wRange(W); assert.ok(W - hi >= 230, '右栏至少 230，W=' + W); }
  for (const T of [200, 400, 754, 1400]) { const [lo, hi] = hRange(T); assert.ok(lo > 0 && lo < hi && hi < T, 'T=' + T); }
});

test('分隔条接线：role=separator、可聚焦、带 aria-valuenow；位置存在 align-split:<页>；收起详情时藏起来', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  for (const id of ['hsplit', 'vsplit']) assert.match(src, new RegExp('id="' + id + '" role="separator" tabindex="0"'));
  assert.match(src, /setAttribute\('aria-valuenow'/);
  assert.match(src, /const splitKey = 'align-split:' \+ data\.name;/);
  assert.match(src, /\.app\.shut \.hsplit,\.app\.shut \.vsplit\{visibility:hidden\}/);
  assert.match(src, /addEventListener\('pointerdown'/);
  assert.match(src, /addEventListener\('dblclick'/);
});

test('页面里的 First Mate 按钮和「打开会话」：侧栏里发给同源父页面，整页（服务端给的页面）开 DSH 标签页，本机文件没有', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(src, /const embedded = window\.parent !== window;/);
  assert.match(src, /const opensSess = embedded \|\| live;/);
  assert.match(src, /sid && opensSess \? '<button class="chip lnk" data-act="open-sess"/);
  assert.match(src, /if \(embedded\) \{ window\.parent\.postMessage\(msg, location\.origin\); return; \}/);
  assert.match(src, /window\.open\('\/#' \+ q, DSH_TAB\)/);
  assert.match(src, /toDsh\(\{ type: 'dsh-alignment\/open-session', sid \}\)/);
  assert.match(src, /const from = embedded \? e\.source === window\.parent : !!dshWin && e\.source === dshWin;/);
  assert.match(src, /if \(!from \|\| e\.origin !== location\.origin/);
});

test('页面脚本能解析（重名变量、语法错误会让整页空白）', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s), 'template.html 的 <script> 解析失败');
});


// ---- 发送失败的提示（template.html 的 @senderr 段）：2026-10-24 在家里经 4080 发送，负责人会话已归档 → 页面只显示「发送失败」+ 原始 JSON ----
test('发送失败提示：401 / 被转到登录页说「登录已失效，请重新登录」；负责人不是当前 First Mate 时说清楚；其余带服务端原因', () => {
  const { sendErrOf } = tplSeg('senderr', 'sendErrOf');
  for (const [status, j, toLogin] of [[401, { ok: false, code: 'unauthorized', error: 'unauthorized' }, false], [401, { ok: false, message: '需要先登录 DSH' }, false], [200, null, true]]) {
    const e = sendErrOf(status, j, 'x', toLogin, null);
    assert.equal(e.title, '登录已失效，请重新登录', '4080 网关 401 / 3080 401 / 302 到 /login');
    assert.equal(e.login, true);
    assert.match(e.why, /已选内容都还在/);
  }
  const archived = { ok: false, message: '会话 session-c0ffee03-0000-4000-8000-000000000003 已归档，取消归档后再发送' };
  const o = sendErrOf(500, archived, '', false, { owner: 'session-c0ffee03-0000-4000-8000-000000000003', fm: 'session-c0ffee04-0000-4000-8000-000000000004' });
  assert.equal(o.login, false);
  assert.equal(o.title, '发送失败：负责人会话不是当前 First Mate');
  assert.match(o.why, /^已选内容都还在。.*c0ffee03.*c0ffee04.*改成自己/);
  assert.doesNotMatch(o.why, /取消归档/, '只给一条做法：改负责人，不叫人去取消归档旧会话');
  const same = sendErrOf(500, archived, '', false, { owner: 'session-a', fm: 'session-a' });
  assert.equal(same.title, '发送失败');
  assert.match(same.why, /原因：会话 session-c0ffee03.* 已归档/);
  assert.equal(sendErrOf(500, null, '', false, null).why, '已选内容都还在。', '没有人话原因就不复述框里的 HTTP 原文');
  const net = sendErrOf(0, null, 'Failed to fetch', false, null);
  assert.equal(net.title, '发送失败：连不上 DSH');
  assert.match(net.why, /检查网络或远程连接后点重试/);
});

test('发送：失败时带上状态码、响应 JSON 和是否被转到 /login；4080 的「退出登录」浮层不盖住发送按钮', () => {
  const src = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(src, /dock = \{ state: 'err', status: res\.status, j, toLogin: res\.redirected && new URL\(res\.url\)\.pathname === '\/login'/);
  assert.match(src, /sendErrOf\(dock\.status, dock\.j, dock\.text, dock\.toLogin, ownerCheck\(\)\)/);
  assert.match(src, /e\.login \? '<a class="ghost" href="\/" target="_top">重新登录<\/a>'/);
  assert.match(src, /#dsh-plugin-remote-logout\{display:none!important\}/);
});

// ---- 盖章：template.html 内联的 stamp-fx 必须和 assets/stamp-fx/stamp-fx.js 逐字一致（改组件后跑 assets/stamp-fx/tools/sync-template.mjs）----
test('template.html inlines assets/stamp-fx/stamp-fx.js verbatim', () => {
  const tpl = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const src = fs.readFileSync(new URL('../assets/stamp-fx/stamp-fx.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const a = tpl.indexOf('// @stamp-fx-begin'), b = tpl.indexOf('// @stamp-fx-end');
  assert.ok(a >= 0 && b > a, 'template.html 缺 @stamp-fx-begin / @stamp-fx-end');
  assert.equal(tpl.slice(tpl.indexOf('\n', a) + 1, b).trimEnd(), src);
  assert.match(tpl, /StampFx\.sequence\(live, \{ sound \}\)/);
  assert.match(tpl, /data-act="stamp-sound" aria-pressed="/);
});

// ---- api 13：进待验收要说明是不是视觉类交付（visual=true|false），视觉类要带截图 ----------------------------------
test('api 13 visual：进待验收必带 visual=true|false；true 要有 img（之前挂的或同一条命令里的）；false 不写进页面；旧的待验收不受影响', async () => {
  const f = page7('vis', { projects: [{ id: 'p1', title: '项目一', cwd: dir }], rounds: [
    { id: 'v1', title: '改页面', status: 'doing', sid: 's1', proj: 'p1', started: t7('08'), updated: t7('08') },
    { id: 'v2', title: '改页面二', status: 'doing', sid: 's2', proj: 'p1', started: t7('08'), updated: t7('08') },
    { id: 'v3', title: '查数据', status: 'doing', sid: 's3', proj: 'p1', started: t7('08'), updated: t7('08') },
    { id: 'v4', title: '旧的待验收', status: 'done', sid: 's4', proj: 'p1', started: t7('08'), ended: t7('09'), updated: t7('09') },
    { id: 'v5', title: '放弃过', status: 'dropped', sid: 's5', proj: 'p1', ended: t7('09'), updated: t7('09') },
    { id: 'v6', title: '上一轮', status: 'doing', sid: 's6', proj: 'p1', started: t7('08'), updated: t7('08') },
  ] });
  const shot = path.join(dir, 'vis-shot.png'); fs.writeFileSync(shot, 'png');
  const R = (id) => read3(f).rounds.find((x) => x.id === id);
  const s13 = await fakeDsh(13);
  process.env.DSH_WEB_URL = 'http://127.0.0.1:' + s13.address().port;
  try {
    // 不填就报错，并提示怎么填：round done、round set status=done、旧命令 done 都一样
    await rejects(['round', 'done', 'vis', 'v1', 'result=好了'], /round\/v1 进待验收要带 visual=true\|false（.*true 要挂截图 img=<路径>::说明）/, f);
    await rejects(['round', 'done', 'vis', 'v1', 'visual='], /round\/v1 进待验收要带 visual=true\|false/, f);
    await rejects(['round', 'done', 'vis', 'v1', 'visual=yes'], /visual 只能是 true 或 false: yes/, f);
    await rejects(['round', 'set', 'vis', 'v1', 'status=done'], /round\/v1 进待验收要带 visual=true\|false/, f);
    await rejects(['done', 'vis', 'v1'], /round\/v1 进待验收要带 visual=true\|false/, f);
    await rejects(['round', 'set', 'vis', 'v5', 'status=done'], /round\/v5 进待验收要带 visual=true\|false/, f);
    // 视觉类没图：报错，提示带截图
    await rejects(['round', 'done', 'vis', 'v1', 'visual=true', 'result=好了'], /round\/v1: 视觉类交付要带截图：img=<路径>::说明/, f);
    await rejects(['round', 'set', 'vis', 'v1', 'status=done', 'visual=true'], /round\/v1: 视觉类交付要带截图/, f);
    // 视觉类有图：同一条命令里带 img=，或之前 round set 挂上的
    assert.match(await run('round', 'done', 'vis', 'v1', 'visual=true', 'img=' + shot + '::首页', 'result=好了'), /^round\/v1 → 完成 → /);
    assert.deepEqual([R('v1').status, R('v1').visual, R('v1').img], ['done', 'true', [{ src: shot, cap: '首页' }]]);
    await run('round', 'set', 'vis', 'v2', 'img=' + shot);
    assert.match(await run('round', 'done', 'vis', 'v2', 'visual=true'), /^round\/v2 → 完成 → /);
    assert.equal(R('v2').visual, 'true');
    // 待验收的视觉类轮次不能把截图删光
    await rejects(['round', 'set', 'vis', 'v2', 'img='], /round\/v2: 视觉类交付要带截图/, f);
    await rejects(['round', 'set', 'vis', 'v2', 'img=-' + shot], /round\/v2: 视觉类交付要带截图/, f);
    // 非视觉：照常完成，visual 不写进页面
    assert.match(await run('round', 'done', 'vis', 'v3', 'visual=false', 'result=查完了'), /^round\/v3 → 完成 → /);
    assert.deepEqual([R('v3').status, 'visual' in R('v3')], ['done', false]);
    // 已在待验收的旧轮次：没有 visual 照常读、照常通过
    assert.equal(R('v4').visual, undefined);
    assert.match(await run('round', 'accept', 'vis', 'v4'), /^round\/v4 → 通过/);
    // round add --prev 自动收尾的上一轮不要 visual（不是交付，验收跟着链上最新一轮）
    assert.match(await run('round', 'add', 'vis', 'v7', '--prev', 'v6', '--mode', 'continue', 'title=下一轮', 'why=接着做', ...E), /上一轮 v6 改为完成/);
    assert.deepEqual([R('v6').status, 'visual' in R('v6')], ['done', false]);
  } finally { s13.close(); }
  // 3080 内存里还是旧代码（api 12）或探测不通：visual=true 不写；visual=false 不探测
  await run('round', 'set', 'vis', 'v3', 'status=doing');
  const s12 = await fakeDsh(12);
  process.env.DSH_WEB_URL = 'http://127.0.0.1:' + s12.address().port;
  try {
    await rejects(['round', 'done', 'vis', 'v3', 'visual=true', 'img=' + shot], /报 api=12：3080 内存里还是旧插件代码，页面里有 visual 它会整页读不出来；3080 重启后再跑这条命令（visual=false 不受影响）/, f);
    await rejects(['round', 'set', 'vis', 'v3', 'visual=true', 'img=' + shot], /报 api=12：3080 内存里还是旧插件代码/, f);
  } finally { s12.close(); }
  process.env.DSH_WEB_URL = 'http://127.0.0.1:1';
  try {
    await rejects(['round', 'done', 'vis', 'v3', 'visual=true', 'img=' + shot], /写 visual=true 前要确认 3080 读得了它，探测 .* 失败/, f);
    assert.match(await run('round', 'done', 'vis', 'v3', 'visual=false'), /^round\/v3 → 完成 → /);
  } finally { delete process.env.DSH_WEB_URL; }
});

// ---- 2026-10-26：round show / ls --sid / sid 校验 / sids / dispatch（会话一律经替身 dsh-threads，ALIGN_THREADS_CLI） ----
const S1 = 'session-c0ffee05-0000-4000-8000-000000000005', S2 = 'session-c0ffee06-0000-4000-8000-000000000006';
const fakeLog = path.join(dir, 'fake-threads.log');
const calls = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sidPage = async (name) => {
  await run('init', path.join(dir, name + '.html'), '--name', name, '--title', 'sid 页', '--owner', 'session-owner', '--version', '3');
  await run('round', 'add', name, 'cua-no-element', '--mode', 'new', '--proj', 'HomeFake', ...E, 'title=cua 找不到元素', 'sid=' + S1, 'why=w', 'stitle=CUA 会话', 'state=在查', 'next=等结果');
  await run('round', 'add', name, 'thinking-sig-400', '--mode', 'new', '--proj', 'HomeFake', ...E, 'title=查 400', 'sid=' + S2, 'why=w', 'fault=429 限流');
};

test('ls 每行带 sid 前 8 位；--sid 按完整 sid 或前 8 位过滤', async () => {
  await sidPage('sd1');
  assert.match(await run('ls', 'sd1', 'round'), /round\/cua-no-element .* · c0ffee05$/m);
  assert.equal(await run('ls', 'sd1', 'round', '--sid', 'c0ffee05'), (await run('ls', 'sd1', 'round')).split('\n').find((l) => l.startsWith('round/cua-no-element')));
  assert.match(await run('ls', 'sd1', 'round', '--sid', S2), /^round\/thinking-sig-400 [^\n]*$/);
  assert.match(await run('ls', 'sd1', '--sid', 'deadbeef'), /没有匹配/);
  await assert.rejects(run('ls', 'sd1', 'round', '--sid', '91d6'), /至少前 8 位/);
});

test('sid= 校验：格式不对、会话不存在、threads 不可用都拒收且不改文件；--no-check-sid 只跳过存在性', async () => {
  await sidPage('sd2');
  const f = path.join(dir, 'sd2.html'), snap = fs.readFileSync(f, 'utf8');
  await assert.rejects(run('round', 'set', 'sd2', 'thinking-sig-400', 'sid=e0e55152-c647-446f-abdd-6a5fdc451b90'), /sid 格式不对.*session-xxxxxxxx/);
  await assert.rejects(run('round', 'set', 'sd2', 'thinking-sig-400', 'sid=session-dead0000-0000-4000-8000-000000000000'), /不存在.*No dsh thread found/);
  await assert.rejects(run('round', 'add', 'sd2', 'x9', '--mode', 'new', '--proj', 'HomeFake', ...E, 'title=t', 'sid=session-dead0000-0000-4000-8000-000000000000', 'why=w'), /不存在/);
  process.env.FAKE_THREADS_DOWN = '1';
  try {
    await assert.rejects(run('round', 'set', 'sd2', 'thinking-sig-400', 'sid=' + S1), /查不了会话.*ECONNREFUSED.*--no-check-sid/);
    await assert.rejects(run('round', 'set', 'sd2', 'thinking-sig-400', 'sid=abc', '--no-check-sid'), /sid 格式不对/);
    assert.equal(fs.readFileSync(f, 'utf8'), snap);
    assert.match(await run('round', 'set', 'sd2', 'thinking-sig-400', 'sid=' + S1, '--no-check-sid'), /改了 round\/thinking-sig-400 的 sid/);
  } finally { delete process.env.FAKE_THREADS_DOWN; }
  assert.match(await run('round', 'set', 'sd2', 'thinking-sig-400', 'state=不改 sid 不查'), /改了/);
});

test('sids 只读列出格式不对的 sid，不改文件', async () => {
  await sidPage('sd3');
  const f = path.join(dir, 'sd3.html');
  assert.match(await run('sids', 'sd3'), /^没有格式不对的 sid/);
  const d = A.parsePage(fs.readFileSync(f, 'utf8'));
  d.rounds.find((r) => r.id === 'thinking-sig-400').sid = 'e0e55152-c647-446f-abdd-6a5fdc451b90';
  fs.writeFileSync(f, A.render(d));
  const snap = fs.readFileSync(f, 'utf8');
  const out = await run('sids', 'sd3');
  assert.match(out, /^格式不对的 sid 1 条/);
  assert.match(out, /round\/thinking-sig-400 sid=e0e55152-c647-446f-abdd-6a5fdc451b90/);
  assert.equal(fs.readFileSync(f, 'utf8'), snap);
});

test('round show：字段每个一行 + 暂缓 + 挂着的决定 + 会话现状；取不到会话就报错', async () => {
  await sidPage('sd4');
  await run('round', 'set', 'sd4', 'cua-no-element', 'status=paused');
  await run('round', 'set', 'sd4', 'cua-no-element', 'status=doing');
  await run('decide', 'add', 'sd4', 'q1', ...RC, 'title=要你定', 'why=w', 'opt=甲::a', 'opt=乙::b', '--round', 'cua-no-element');
  const out = await run('round', 'show', 'sd4', 'cua-no-element');
  for (const re of [/^id: cua-no-element$/m, /^项目: HomeFake（ws-h）$/m, /^status: doing · mode new$/m, new RegExp('^sid: ' + S1 + '$', 'm'), /^stitle: CUA 会话$/m,
    /^state: 在查$/m, /^next: 等结果$/m, /^fault: —$/m, /^prev: —$/m, /^handoff: —$/m, /^started: 20\d\d-/m, /^updated: 20\d\d-/m,
    /^暂缓: 20\d\d-\S+ → 20\d\d-/m, /^决定: q1 \[open\] 要你定$/m,
    /^会话: 空闲 · 替身会话$/m, /^最后回合: \d\d-\d\d \d\d:\d\d 开始，\d\d-\d\d \d\d:\d\d 结束 · 被打断$/m]) assert.match(out, re);
  const reply = out.split('\n').find((l) => l.startsWith('最后回复: '));
  assert.equal(reply, '最后回复: 最后一句：' + '长'.repeat(195) + '…');
  assert.ok(!out.includes('{'), '不输出原始 JSON');
  assert.match(await run('round', 'show', 'sd4', 'thinking-sig-400', '--no-session'), /^fault: 429 限流$/m);
  assert.doesNotMatch(await run('round', 'show', 'sd4', 'thinking-sig-400', '--no-session'), /^会话:/m);
  process.env.FAKE_THREADS_DOWN = '1';
  try { await assert.rejects(run('round', 'show', 'sd4', 'cua-no-element'), /read_thread 失败.*ECONNREFUSED/); } finally { delete process.env.FAKE_THREADS_DOWN; }
  await assert.rejects(run('round', 'show', 'sd4', 'nope'), /没有 id 为 nope/);
});

test('dispatch：新开（create_thread）和续发（send_message_to_thread）都登记轮次，sid 取自 threads', async () => {
  await sidPage('dp1');
  const f = path.join(dir, 'dp1.html'), pf = path.join(dir, 'task.md');
  fs.writeFileSync(pf, '你的任务：做 X。\n');
  process.env.FAKE_THREADS_LOG = fakeLog;
  process.env.DSH_SESSION_ID = 'session-f1257000-0000-4000-8000-000000000000';
  try {
    fs.rmSync(fakeLog, { force: true });
    const out = await run('dispatch', 'dp1', 'd-new', '--prompt-file', pf, '--mode', 'new', '--proj', 'HomeFake', ...E, 'title=做 X', 'stitle=X 会话', 'why=新任务');
    const created = calls().find((c) => c.created).created;
    const ct = calls().find((c) => c.tool === 'create_thread');
    assert.deepEqual(ct.args, { title: 'X 会话', prompt: '你的任务：做 X。\n', target: { type: 'project', projectId: 'ws-h', environment: { type: 'local' } } });
    assert.equal(ct.caller, process.env.DSH_SESSION_ID);
    let d = A.parsePage(fs.readFileSync(f, 'utf8'));
    assert.equal(d.rounds.find((r) => r.id === 'd-new').sid, created);
    assert.match(out, new RegExp('新增一轮 d-new[^\n]*\n会话 ' + created + '（新开'));

    fs.rmSync(fakeLog, { force: true });
    const out2 = await run('dispatch', 'dp1', 'd-more', '--prompt-file', pf, '--mode', 'continue', '--prev', 'd-new', ...E, 'title=再做', 'why=同一件事');
    assert.deepEqual(calls().map((c) => c.tool), ['send_message_to_thread']);
    assert.deepEqual(calls()[0].args, { threadId: created, prompt: '你的任务：做 X。\n' });
    d = A.parsePage(fs.readFileSync(f, 'utf8'));
    const r = d.rounds.find((x) => x.id === 'd-more');
    assert.equal(r.sid, created);
    assert.equal(r.prev, 'd-new');
    assert.equal(d.rounds.find((x) => x.id === 'd-new').status, 'done');
    assert.match(out2, /续发，已发任务/);
  } finally { delete process.env.FAKE_THREADS_LOG; delete process.env.DSH_SESSION_ID; }
});

test('dispatch：参数错不建会话；threads 失败打印原始错误；建好后登记失败给 sid 和补登记命令', async () => {
  await sidPage('dp2');
  const f = path.join(dir, 'dp2.html'), pf = path.join(dir, 'task2.md');
  fs.writeFileSync(pf, '任务');
  process.env.FAKE_THREADS_LOG = fakeLog;
  try {
    fs.rmSync(fakeLog, { force: true });
    const snap = fs.readFileSync(f, 'utf8');
    const base = ['dispatch', 'dp2', 'd1', '--prompt-file', pf, '--mode', 'new', '--proj', 'HomeFake'];
    await assert.rejects(A.main([...base, 'title=t', 'why=w']), /eta=/);
    await assert.rejects(A.main([...base, ...E, 'title=t', 'why=w', 'sid=' + S1]), /不要写 sid=/);
    await assert.rejects(A.main(['dispatch', 'dp2', 'd1', '--prompt-file', path.join(dir, 'none.md'), '--mode', 'new', '--proj', 'HomeFake', ...E, 'title=t', 'why=w']), /prompt 文件不存在/);
    await assert.rejects(A.main(['dispatch', 'dp2', 'd1', '--prompt-file', pf, '--mode', 'new', ...E, 'title=t', 'why=w']), /--proj/);
    await assert.rejects(A.main(['dispatch', 'dp2', 'd1', '--prompt-file', pf, '--mode', 'continue', ...E, 'title=t', 'why=w']), /--prev/);
    await assert.rejects(A.main([...base, ...E, 'title=t', 'why=w', 'status=done']), /status/);
    await assert.rejects(A.main(['dispatch', 'dp2', 'cua-no-element', '--prompt-file', pf, '--mode', 'new', '--proj', 'HomeFake', ...E, 'title=t', 'why=w']), /已存在/);
    assert.deepEqual(calls(), [], '参数错时一次 threads 都没调');
    process.env.FAKE_THREADS_FAIL = 'create_thread';
    try { await assert.rejects(A.main([...base, ...E, 'title=t', 'why=w']), /create_thread 失败: create_thread 替身故意失败/); } finally { delete process.env.FAKE_THREADS_FAIL; }
    assert.equal(fs.readFileSync(f, 'utf8'), snap);
    // 会话建好后页面被别人改了（替身 create_thread 抢先把同 id 的轮次写进页面）：登记失败，给出 sid 和补登记命令
    fs.rmSync(fakeLog, { force: true });
    let err;
    process.env.FAKE_THREADS_RACE_PAGE = f;
    try { await A.main([...base, ...E, 'title=t', 'why=w', 'stitle=有 空格']); } catch (e) { err = e; } finally { delete process.env.FAKE_THREADS_RACE_PAGE; }
    assert.ok(err, '登记应当失败');
    const created = calls().find((c) => c.created).created;
    assert.match(err.message, new RegExp('会话 ' + created + ' 已新开并发了任务，但登记轮次失败：.*已存在'));
    assert.match(err.message, new RegExp('\n会话 sid: ' + created + '\n补登记: align round add dp2 d1 --mode new --proj ws-h eta=40m eta75=1h etaconf=中 title=t why=w \'stitle=有 空格\' sid=' + created + '$'));
  } finally { delete process.env.FAKE_THREADS_LOG; }
});

// ---- 2026-11-01：dispatch --cwd（目录还不是工作区就先 create_workspace，再开会话、登记） ----
test('dispatch --cwd：先 create_workspace 再 create_thread，轮次归到新工作区并加进 projects；已有工作区直接用', async () => {
  await sidPage('dc1');
  const f = path.join(dir, 'dc1.html'), pf = path.join(dir, 'task-cwd.md');
  fs.writeFileSync(pf, '在新目录里做 Y');
  const repo = path.join(dir, 'brand-new-repo');
  fs.mkdirSync(repo, { recursive: true });
  process.env.FAKE_THREADS_LOG = fakeLog;
  try {
    fs.rmSync(fakeLog, { force: true });
    const out = await run('dispatch', 'dc1', 'c-new', '--prompt-file', pf, '--mode', 'new', '--cwd', repo, ...E, 'title=做 Y', 'why=新目录');
    assert.deepEqual(calls().filter((c) => c.tool).map((c) => c.tool), ['create_workspace', 'create_thread'], '先建工作区再开会话');
    assert.deepEqual(calls()[0].args, { path: repo });
    assert.deepEqual(calls().find((c) => c.tool === 'create_thread').args.target, { type: 'project', projectId: 'ws-new-brand-new-repo', environment: { type: 'local' } });
    const d = A.parsePage(fs.readFileSync(f, 'utf8'));
    assert.equal(d.rounds.find((r) => r.id === 'c-new').proj, 'ws-new-brand-new-repo');
    assert.deepEqual(d.projects.find((p) => p.id === 'ws-new-brand-new-repo'), { id: 'ws-new-brand-new-repo', title: 'brand-new-repo', cwd: repo });
    assert.ok(!d.projects.some((p) => p.id === 'dispatch-cwd-pending'), '试跑的占位项目不落盘');
    assert.match(out, /\n工作区 brand-new-repo（ws-new-brand-new-repo，新建）/);

    // 目录已是工作区（且页面上已有这个项目）：用它，不重复加项目
    fs.rmSync(fakeLog, { force: true });
    process.env.FAKE_THREADS_WS_EXISTING = 'ws-h';
    const out2 = await run('dispatch', 'dc1', 'c-old', '--prompt-file', pf, '--mode', 'new', '--cwd', repo, ...E, 'title=再做', 'why=已有目录');
    assert.equal(calls().find((c) => c.tool === 'create_thread').args.target.projectId, 'ws-h');
    const d2 = A.parsePage(fs.readFileSync(f, 'utf8'));
    assert.equal(d2.rounds.find((r) => r.id === 'c-old').proj, 'ws-h');
    assert.equal(d2.projects.filter((p) => p.id === 'ws-h').length, 1);
    assert.match(out2, /（ws-h，已有）/);
  } finally { delete process.env.FAKE_THREADS_LOG; delete process.env.FAKE_THREADS_WS_EXISTING; }
});

test('dispatch --cwd：目录不存在 / 是文件 / 和 --proj 同用 / 续发 都直接报错，一次 threads 都不调；多个工作区时不开会话', async () => {
  await sidPage('dc2');
  const f = path.join(dir, 'dc2.html'), pf = path.join(dir, 'task-cwd2.md');
  fs.writeFileSync(pf, '任务');
  const file = path.join(dir, 'just-a-file.txt');
  fs.writeFileSync(file, 'x');
  const repo = path.join(dir, 'brand-new-repo');
  fs.mkdirSync(repo, { recursive: true });
  process.env.FAKE_THREADS_LOG = fakeLog;
  try {
    fs.rmSync(fakeLog, { force: true });
    const snap = fs.readFileSync(f, 'utf8');
    const base = ['dispatch', 'dc2', 'c1', '--prompt-file', pf, '--mode', 'new'];
    const missing = path.join(dir, 'no-such-dir');
    await assert.rejects(A.main([...base, '--cwd', missing, ...E, 'title=t', 'why=w']), (e) => e.message === '目录不存在: ' + missing);
    await assert.rejects(A.main([...base, '--cwd', file, ...E, 'title=t', 'why=w']), (e) => e.message === '不是目录（是文件）: ' + file);
    await assert.rejects(A.main([...base, '--cwd', repo, '--proj', 'HomeFake', ...E, 'title=t', 'why=w']), /--cwd 和 --proj 只能写一个/);
    await assert.rejects(A.main(['dispatch', 'dc2', 'c1', '--prompt-file', pf, '--mode', 'continue', '--prev', 'cua-no-element', '--cwd', repo, ...E, 'title=t', 'why=w']), /--cwd 只用于 --mode new/);
    await assert.rejects(A.main([...base, '--cwd', repo, 'title=t', 'why=w']), /eta=/, '轮次参数错也在建工作区之前报');
    assert.deepEqual(calls(), [], '参数错时一次 threads 都没调（不建工作区、不开会话）');
    // create_workspace 拒绝（如多个工作区）：原始错误报出，不开会话、页面不变
    process.env.FAKE_THREADS_FAIL = 'create_workspace';
    await assert.rejects(A.main([...base, '--cwd', repo, ...E, 'title=t', 'why=w']), /create_workspace 失败: create_workspace 替身故意失败/);
    assert.deepEqual(calls().map((c) => c.tool), ['create_workspace']);
    assert.equal(fs.readFileSync(f, 'utf8'), snap);
  } finally { delete process.env.FAKE_THREADS_LOG; delete process.env.FAKE_THREADS_FAIL; }
});

// ---- 顺便问（btw，api 16）------------------------------------------------------------------------
const BS = (n) => 'session-b0b0000' + n + '-0000-4000-8000-000000000000';
async function btwPage(name) {
  const f = path.join(dir, name + '.html');
  await run('init', f, '--name', name, '--title', '顺便问页', '--owner', BS(9), '--version', '3');
  await run('round', 'add', name, 'q1', '--mode', 'new', '--proj', 'Alpha', ...E, 'title=第一轮', 'sid=' + BS(1), 'why=新任务');
  return f;
}
const btwIdOf = (out) => out.match(/btw\/(b-[a-z0-9-]+)/)[1];

test('btw：add / when / answer / end / ls；没用过顺便问的页面序列化不带 btw；3080 旧插件时 add 报错不写', async () => {
  const f = await btwPage('bt1');
  assert.doesNotMatch(fs.readFileSync(f, 'utf8').match(/id="align-data">([\s\S]*?)<\/script>/)[1], /"btw"/, '没有顺便问时不写 btw 字段（旧 3080 照样读）');
  const keep = A.probes.btwApi;
  A.probes.btwApi = async () => { throw new A.UsageError('3080 报 api=15'); };
  try { await rejects(['btw', 'add', 'bt1', '--round', 'q1', 'q=问'], /api=15/, f); } finally { A.probes.btwApi = keep; }
  A.probes.btwApi = async () => {};
  try {
    await rejects(['btw', 'add', 'bt1', 'q=问'], /--round/, f);
    await rejects(['btw', 'add', 'bt1', '--round', 'nope', 'q=问'], /没有 id 为 nope/, f);
    await rejects(['btw', 'add', 'bt1', '--round', 'q1', 'q=' + '长'.repeat(301)], /最多 300 字/, f);
    const out = await run('btw', 'add', 'bt1', '--round', 'q1', 'q=A/B 两组首句延迟差多少？');
    const id = btwIdOf(out);
    assert.match(out, new RegExp('转给会话：align btw forward bt1 ' + id));
    let b = read3(f).btw[0];
    assert.deepEqual([b.round, b.src, b.status, b.q], ['q1', 'chat', 'open', 'A/B 两组首句延迟差多少？']);
    assert.match(await run('btw', 'when', 'bt1', id, 'when=等 A/B 跑完'), /回答时机/);
    assert.match(await run('btw', 'ls', 'bt1'), new RegExp('btw/' + id + ' \\[open\\] 轮次 q1 · A/B[^\\n]*等：等 A/B 跑完 · 还没转给会话'));
    assert.match(await run('btw', 'answer', 'bt1', id, 'a=A 组 1.8s，B 组 1.1s。'), /已答/);
    await rejects(['btw', 'answer', 'bt1', id, 'a=又答'], /已经答过/, f);
    b = read3(f).btw[0];
    assert.equal(b.status, 'answered');
    assert.equal(b.when, undefined, '答了就清掉时机');
    assert.ok(A.btwUnseen(b), '新答案 = 决定栏里一张卡');
    assert.match(await run('btw', 'ls', 'bt1', '--new'), /\[answered·新\]/);
    assert.equal(A.listPages().find((p) => p.name === 'bt1').open, 0, '不计入要你处理的卡数');
    const id2 = btwIdOf(await run('btw', 'add', 'bt1', '--round', 'q1', 'q=显存多少？', 'src=web'));
    assert.notEqual(id2, id);
    assert.match(await run('btw', 'end', 'bt1', id2, 'why=测不了'), /不答了/);
    await rejects(['btw', 'end', 'bt1', id2, 'why=又'], /不在等答/, f);
    assert.match(await run('btw', 'ls', 'bt1', 'status=ended'), new RegExp('btw/' + id2));
    assert.equal(A.columnOf(read3(f), read3(f).rounds[0], { [BS(1)]: 'idle' }).reason, 'stopped', '顺便问不改变分栏');
  } finally { A.probes.btwApi = keep; }
});

test('btw：页面提问 / 追问 / 了解 —— 经 First Mate 转发，消息末尾是 btw forward；了解只写文件；发送失败页面不变', async () => {
  const f = await btwPage('bt2');
  const sent = [];
  const send = async (sid, text, card) => { sent.push({ sid, text, card }); };
  let r = await A.answerBatch('bt2', { answers: [{ kind: 'btw', round: 'q1', q: '显存峰值多少？' }] }, send);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, BS(9));
  const b0 = r.data.btw[0];
  assert.deepEqual([b0.src, b0.status, b0.round], ['web', 'open', 'q1']);
  assert.match(sent[0].text, new RegExp('顺便问，挂在轮次「第一轮」（q1）：显存峰值多少？\\n   转给负责的会话（' + BS(1) + '）：运行 align btw forward bt2 ' + b0.id));
  assert.deepEqual(r.items, ['btw/' + b0.id]);
  // 追问 / 了解只接已答的
  await assert.rejects(A.answerBatch('bt2', { answers: [{ kind: 'btw-ack', id: b0.id }] }, send), (e) => e.code === 'bad-action');
  await assert.rejects(A.answerBatch('bt2', { answers: [{ kind: 'btw', round: 'q1', q: '  ' }] }, send), (e) => e.code === 'empty-answer');
  await assert.rejects(A.answerBatch('bt2', { answers: [{ kind: 'btw', round: 'nope', q: '问' }] }, send), (e) => e.code === 'round-not-found');
  A.mutate(f, (d, now) => A.btwOps.answer(d, now, [b0.id], [['a', '15.2 GB']], {}));
  // 发送失败：页面不变
  const snap = fs.readFileSync(f, 'utf8');
  await assert.rejects(A.answerBatch('bt2', { answers: [{ kind: 'btw-more', id: b0.id, q: 'B 组呢？' }] }, async () => { throw new Error('boom'); }), (e) => e.code === 'send-failed');
  assert.equal(fs.readFileSync(f, 'utf8'), snap);
  r = await A.answerBatch('bt2', { answers: [{ kind: 'btw-more', id: b0.id, q: 'B 组呢？' }] }, send);
  assert.match(sent[1].text, new RegExp('继续追问顺便问 ' + b0.id + '：B 组呢？\\n   原问题：显存峰值多少？\\n   之前的答案：15.2 GB\\n   转给负责的会话'));
  let b = r.data.btw[0];
  assert.deepEqual([b.status, b.more.length, b.more[0].q, A.btwUnseen(b)], ['open', 1, 'B 组呢？', false]);
  // 会话收到的是追问 + 之前的问答
  assert.match(A.btwPromptBlock(r.data, 'bt2', [b]), /顺便问 b-[a-z0-9-]+（追问）：B 组呢？\n   之前问：显存峰值多少？\n   之前答：15.2 GB/);
  A.mutate(f, (d, now) => A.btwOps.answer(d, now, [b0.id], [['a', '13.8 GB']], {}));
  assert.ok(A.btwUnseen(read3(f).btw[0]), '答了追问又出卡');
  r = await A.answerBatch('bt2', { answers: [{ kind: 'btw-ack', id: b0.id }] }, async () => { throw new Error('「了解」不该发消息'); });
  b = r.data.btw[0];
  assert.ok(b.seen && !A.btwUnseen(b));
  assert.equal(r.sid, undefined);
});

test('btw：round add --prev 把没答的转到新一轮并列出；round done 列出；整条链结束改 ended；openBtwForSession', async () => {
  const f = await btwPage('bt3');
  A.probes.btwApi = async () => {};
  const open = btwIdOf(await run('btw', 'add', 'bt3', '--round', 'q1', 'q=没答的'));
  const done = btwIdOf(await run('btw', 'add', 'bt3', '--round', 'q1', 'q=已答的'));
  await run('btw', 'answer', 'bt3', done, 'a=答了');
  // 会话上还在等答的：dsh-fm 的「会话回合结束」通知末尾列出
  assert.deepEqual(A.openBtwForSession(BS(1)).filter((x) => x.page === 'bt3').map((x) => [x.id, x.q, x.forwarded, x.cmds.length]), [[open, '没答的', false, 3]]);
  assert.throws(() => A.openBtwForSession(''), A.UsageError);
  // round done 列出待答的顺便问
  const out = await run('round', 'done', 'bt3', 'q1', 'visual=false', 'result=交了');
  assert.match(out, new RegExp('\\n待答的顺便问 ' + open + ' \\[open\\] 没答的 → align btw answer bt3 ' + open + " 'a=<答案>' \\| align btw end bt3 " + open));
  assert.doesNotMatch(out, new RegExp(done));
  // 换新会话：没答的跟着 --prev 转过去，输出列出并给转发命令；已答的留在原轮次
  const out2 = await run('round', 'add', 'bt3', 'q2', '--mode', 'new', '--prev', 'q1', '--handoff', handoff, ...E, 'title=第二轮', 'sid=' + BS(2), 'why=阶段边界');
  assert.match(out2, /1 条没答的顺便问转到这一轮/);
  assert.match(out2, new RegExp('转到这一轮的顺便问 ' + open + ' 没答的（最早问在 q1）；还没转给会话：align btw forward bt3 ' + open));
  let d = read3(f);
  assert.deepEqual(d.btw.map((b) => [b.id, b.round, b.from]), [[open, 'q2', 'q1'], [done, 'q1', undefined]]);
  assert.deepEqual(A.openBtwForSession(BS(2)).filter((x) => x.page === 'bt3').map((x) => x.id), [open]);
  assert.deepEqual(A.openBtwForSession(BS(1)).filter((x) => x.page === 'bt3'), []);
  // 整条链结束：还在等答的改成 ended（会话结束时没答）
  await run('round', 'set', 'bt3', 'q2', 'status=dropped', 'result=不做了');
  d = read3(f);
  assert.deepEqual([d.btw[0].status, d.btw[0].endWhy], ['ended', '会话结束时没答']);
});

test('btw：一轮通过（accepted）后没答的不自动结束，一直列在 ls / round show 和回合结束通知里，btw answer / end 后才不列；挂着没答的已通过轮次不被裁剪', async () => {
  const f = await btwPage('bt8');
  A.probes.btwApi = async () => {};
  const a = btwIdOf(await run('btw', 'add', 'bt8', '--round', 'q1', 'q=通过后再答'));
  const e = btwIdOf(await run('btw', 'add', 'bt8', '--round', 'q1', 'q=通过后结束'));
  await run('round', 'done', 'bt8', 'q1', 'visual=false', 'result=交了');
  await run('round', 'accept', 'bt8', 'q1');
  // 通过后又写了几次页面（别的轮次），后面没有接 q1 的新一轮：仍在等答
  await run('round', 'add', 'bt8', 'q2', '--mode', 'new', '--proj', 'Alpha', ...E, 'title=别的事', 'sid=' + BS(2), 'why=新任务');
  assert.deepEqual(read3(f).btw.map((b) => [b.id, b.status, b.ended, b.endWhy]), [[a, 'open', undefined, undefined], [e, 'open', undefined, undefined]]);
  const rows = async () => (await run('ls', 'bt8')).split('\n').filter((l) => l.startsWith('btw/')).map((l) => l.split(' ')[0]);
  const shown = async () => (await run('round', 'show', 'bt8', 'q1', '--no-session')).split('\n').filter((l) => l.startsWith('顺便问: ')).map((l) => l.split(' ')[1]);
  assert.deepEqual(await rows(), ['btw/' + a, 'btw/' + e]);
  assert.deepEqual(await shown(), [a, e]);
  assert.deepEqual(A.openBtwForSession(BS(1)).filter((x) => x.page === 'bt8').map((x) => x.id), [a, e]);
  // 裁剪（已结束轮次留 40 条）：挂着没答顺便问的已通过轮次留着，顺便问也留着
  A.mutate(f, (x) => {
    for (let i = 0; i < 41; i++) x.rounds.push({ id: 'old' + i, title: 't', status: 'accepted', proj: 'ws-a', updated: '2027-01-01T00:00:' + String(i).padStart(2, '0') + '+08:00' });
    return '';
  });
  assert.ok(read3(f).rounds.some((r) => r.id === 'q1'), '挂着没答顺便问的不裁');
  assert.deepEqual(await rows(), ['btw/' + a, 'btw/' + e]);
  // 会话答了 / 手动结束：不再列出
  await run('btw', 'answer', 'bt8', a, 'a=答了');
  await run('btw', 'end', 'bt8', e, 'why=不相干');
  assert.deepEqual(await rows(), []);
  assert.deepEqual(A.openBtwForSession(BS(1)).filter((x) => x.page === 'bt8'), []);
  // 都处理完的已通过轮次照常按 40 条裁掉（刚才那次写入已经裁了，顺便问一起删）
  assert.ok(!read3(f).rounds.some((r) => r.id === 'q1'));
  assert.equal(read3(f).btw, undefined);
});

test('btw：dispatch --prev 把转过来的顺便问写进发给新会话的任务，输出列出并记下已转', async () => {
  const f = await btwPage('bt4');
  A.probes.btwApi = async () => {};
  const id = btwIdOf(await run('btw', 'add', 'bt4', '--round', 'q1', 'q=延迟差多少？'));
  await run('btw', 'when', 'bt4', id, 'when=等 A/B 跑完');
  const pf = path.join(dir, 'bt4-task.md');
  fs.writeFileSync(pf, '你的任务：继续。\n');
  process.env.FAKE_THREADS_LOG = fakeLog;
  try {
    fs.rmSync(fakeLog, { force: true });
    const out = await run('dispatch', 'bt4', 'q2', '--prompt-file', pf, '--mode', 'new', '--prev', 'q1', '--handoff', handoff, ...E, 'title=第二轮', 'why=阶段边界');
    const ct = calls().find((c) => c.tool === 'create_thread');
    assert.match(ct.args.prompt, /^你的任务：继续。\n\n---\n\n对齐页「顺便问页」上，用户顺便问了一句/);
    assert.match(ct.args.prompt, new RegExp('顺便问 ' + id + '：延迟差多少？\\n   你说过的回答时机：等 A/B 跑完\\n   能答时运行：align btw answer bt4 ' + id));
    assert.match(out, new RegExp('转到这一轮的顺便问 ' + id + ' 延迟差多少？（最早问在 q1）（已写进发给会话的任务）'));
    const b = read3(f).btw[0];
    assert.ok(b.fwd, '记下已转给新会话');
    assert.equal(b.round, 'q2');
    // btw forward：发给所挂轮次的会话
    fs.rmSync(fakeLog, { force: true });
    assert.match(await run('btw', 'forward', 'bt4', id), /已转给会话 session-0000feed/);
    const sm = calls().find((c) => c.tool === 'send_message_to_thread');
    assert.equal(sm.args.threadId, read3(f).rounds.find((r) => r.id === 'q2').sid);
    assert.match(sm.args.prompt, new RegExp('顺便问 ' + id));
  } finally { delete process.env.FAKE_THREADS_LOG; }
});

test('btw：校验——字段白名单、挂的轮次要在、答案和状态一致；轮次被裁掉时一起删', () => {
  const base = { version: 3, name: 'v', title: 't', projects: [], rounds: [{ id: 'r', title: 'r', status: 'doing' }], decisions: [], notes: [] };
  const now = '2026-10-27T10:00:00+08:00';
  const ok = { id: 'b-1', round: 'r', src: 'web', q: 'q', asked: now, status: 'open' };
  A.validate({ ...base, btw: [ok] });
  for (const [bad, re] of [
    [{ ...ok, x: '1' }, /没有字段 x/], [{ ...ok, round: 'zz' }, /不在页面上/], [{ ...ok, status: 'answered' }, /要有答案/],
    [{ ...ok, a: 'x', answered: now }, /status 应是 answered/], [{ ...ok, status: 'ended' }, /要有 ended/], [{ ...ok, src: 'sms' }, /src/],
    [{ ...ok, more: [{ q: 'm', asked: now }] }, /前一问还没答/],
  ]) assert.throws(() => A.validate({ ...base, btw: [bad] }), re);
  assert.throws(() => A.validate({ ...base, btw: [] }), /非空数组/);
});

test('btw：追问挂到会话链最新一轮（换过会话由新会话答）；链已结束就拒收；3390 在主 3080 还是旧插件时不写 btw', async () => {
  const f = await btwPage('bt5');
  A.probes.btwApi = async () => {};
  const id = btwIdOf(await run('btw', 'add', 'bt5', '--round', 'q1', 'q=问'));
  await run('btw', 'answer', 'bt5', id, 'a=答');
  // 已答的留在 q1；换到新会话 q2 后追问，挂到 q2、发给 q2 的会话
  await run('round', 'add', 'bt5', 'q2', '--mode', 'new', '--prev', 'q1', '--handoff', handoff, ...E, 'title=第二轮', 'sid=' + BS(2), 'why=阶段边界');
  assert.equal(read3(f).btw[0].round, 'q1');
  const sent = [];
  const r = await A.answerBatch('bt5', { answers: [{ kind: 'btw-more', id, q: '再问' }] }, async (sid, text) => { sent.push(text); });
  const b = r.data.btw[0];
  assert.deepEqual([b.round, b.from, b.status], ['q2', 'q1', 'open']);
  assert.match(sent[0], new RegExp('转给负责的会话（' + BS(2) + '）'));
  assert.deepEqual(A.openBtwForSession(BS(2)).filter((x) => x.page === 'bt5').map((x) => x.id), [id]);
  // 链结束后：答了的可以「了解」，不能再追问
  await run('btw', 'answer', 'bt5', id, 'a=又答');
  await run('round', 'set', 'bt5', 'q2', 'status=dropped', 'result=不做了');
  await assert.rejects(A.answerBatch('bt5', { answers: [{ kind: 'btw-more', id, q: '还问' }] }, async () => {}), (e) => e.code === 'bad-action' && /已经结束/.test(e.message));
  assert.ok((await A.answerBatch('bt5', { answers: [{ kind: 'btw-ack', id }] }, async () => {})).data.btw[0].seen);
  // 3390：btwGuard 报错（主 3080 是旧插件）→ 409 needs-update，页面不变、不发消息
  await run('round', 'add', 'bt5', 'q3', '--mode', 'continue', ...E, 'title=第三轮', 'sid=' + BS(3), 'why=新事', '--proj', 'Alpha');
  const snap = fs.readFileSync(f, 'utf8');
  let called = 0;
  await assert.rejects(A.answerBatch('bt5', { answers: [{ kind: 'btw', round: 'q3', q: '问' }] }, async () => { called++; }, { btwGuard: async () => { throw new A.UsageError('3080 报 api=15'); } }), (e) => e.status === 409 && e.code === 'needs-update' && /api=15/.test(e.message));
  assert.equal(called, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), snap);
});

test('btw：ls 不带区块和 round show 列出没答完的顺便问（挂在哪一轮、转没转、多久前问的），已答、已结束的不列；--proj / --sid / k=v 同样过滤', async () => {
  const f = await btwPage('bt7');
  A.probes.btwApi = async () => {};
  const at = (iso) => { process.env.ALIGN_NOW = iso; };
  try {
    await run('round', 'add', 'bt7', 'q2', '--mode', 'new', '--proj', 'gamma', ...E, 'title=第二轮', 'sid=' + BS(2), 'why=新任务');
    at('2026-10-21T09:00:00+08:00');
    const beta = btwIdOf(await run('btw', 'add', 'bt7', '--round', 'q2', 'q=挂在第二轮'));
    at('2026-10-24T09:30:00+08:00');
    const sent = btwIdOf(await run('btw', 'add', 'bt7', '--round', 'q1', 'q=已转的'));
    A.mutate(f, (d, now) => { d.btw.find((b) => b.id === sent).fwd = now; return ''; });
    await run('btw', 'when', 'bt7', sent, 'when=跑完 A/B');
    at('2026-10-24T11:55:00+08:00');
    const fresh = btwIdOf(await run('btw', 'add', 'bt7', '--round', 'q1', 'q=没转的\n第二行'));
    const answered = btwIdOf(await run('btw', 'add', 'bt7', '--round', 'q1', 'q=已答的'));
    await run('btw', 'answer', 'bt7', answered, 'a=答了');
    const ended = btwIdOf(await run('btw', 'add', 'bt7', '--round', 'q1', 'q=不答了'));
    await run('btw', 'end', 'bt7', ended, 'why=不相干');
    at('2026-10-24T12:00:00+08:00');
    const btwRows = (out) => out.split('\n').filter((l) => l.startsWith('btw/'));
    const L = {
      beta: 'btw/' + beta + ' [open] 轮次 q2 · 还没转给会话 · 3 天前问 · 挂在第二轮',
      sent: 'btw/' + sent + ' [open] 轮次 q1 · 已转给会话 · 2 小时前问 · 已转的 · 等：跑完 A/B',
      fresh: 'btw/' + fresh + ' [open] 轮次 q1 · 还没转给会话 · 5 分钟前问 · 没转的 第二行',
    };
    assert.deepEqual(btwRows(await run('ls', 'bt7')), [L.beta, L.sent, L.fresh]);
    // 排在轮次、决定、须知后面（输出末尾）
    assert.match(await run('ls', 'bt7'), /^round\/q1 /);
    // 只看某个区块时照旧只有那个区块
    for (const sec of ['round', 'decide', 'note', 'doing', 'done']) assert.deepEqual(btwRows(await run('ls', 'bt7', sec)), [], sec);
    assert.equal(await run('ls', 'bt7', 'project'), A.listProjects(A.pageData('bt7')));
    // 过滤：--sid / --proj 看所挂轮次，k=v 看顺便问自己的字段
    assert.deepEqual(btwRows(await run('ls', 'bt7', '--sid', BS(1))), [L.sent, L.fresh]);
    assert.deepEqual(btwRows(await run('ls', 'bt7', '--proj', 'gamma')), [L.beta]);
    assert.deepEqual(btwRows(await run('ls', 'bt7', 'status=open')), [L.beta, L.sent, L.fresh]);
    assert.deepEqual(btwRows(await run('ls', 'bt7', 'status=doing')), []);
    assert.deepEqual(btwRows(await run('ls', 'bt7', 'round=q2')), [L.beta]);
    // round show：只列这一轮的
    const show = (await run('round', 'show', 'bt7', 'q1', '--no-session')).split('\n').filter((l) => l.startsWith('顺便问: '));
    assert.deepEqual(show, ['顺便问: ' + sent + ' [open] 已转给会话 · 2 小时前问 · 已转的 · 等：跑完 A/B', '顺便问: ' + fresh + ' [open] 还没转给会话 · 5 分钟前问 · 没转的 第二行']);
    // 追问：按最新一问算转没转、多久前问的
    at('2026-10-24T12:01:00+08:00');
    await A.answerBatch('bt7', { answers: [{ kind: 'btw-more', id: answered, q: '再问一句' }] }, async () => {});
    at('2026-10-24T12:02:00+08:00');
    assert.deepEqual(btwRows(await run('ls', 'bt7')).filter((l) => l.includes(answered)), ['btw/' + answered + ' [open] 轮次 q1 · 还没转给会话 · 1 分钟前问 · 再问一句']);
    // 都答完、结束了：一条都不列（也不留空行）
    for (const id of [sent, fresh, answered]) await run('btw', 'answer', 'bt7', id, 'a=答了');
    await run('btw', 'end', 'bt7', beta, 'why=不相干');
    assert.deepEqual(btwRows(await run('ls', 'bt7')), []);
    assert.doesNotMatch(await run('ls', 'bt7'), /\n$/);
    assert.doesNotMatch(await run('round', 'show', 'bt7', 'q1', '--no-session'), /^顺便问: /m);
  } finally { delete process.env.ALIGN_NOW; }
});

test('btw：页面路径带空格时命令里加引号', () => {
  assert.equal(A.btwCmds('C:\\a b\\p.html', 'b-1').forward, "align btw forward 'C:\\a b\\p.html' b-1");
  assert.equal(A.btwCmds('first-mate', 'b-1').forward, 'align btw forward first-mate b-1');
});

test('btw：forward 发送失败页面不变；续发（continue）时已转过的不重发、没转过的写进任务；两次 --prev 保留最早 from；轮次被裁掉时顺便问一起删', async () => {
  const f = await btwPage('bt6');
  A.probes.btwApi = async () => {};
  const a = btwIdOf(await run('btw', 'add', 'bt6', '--round', 'q1', 'q=转过的'));
  const b = btwIdOf(await run('btw', 'add', 'bt6', '--round', 'q1', 'q=没转过的'));
  process.env.FAKE_THREADS_LOG = fakeLog;
  try {
    // forward 发送失败：原样报错、页面不变
    process.env.FAKE_THREADS_FAIL = 'send_message_to_thread';
    await rejects(['btw', 'forward', 'bt6', a], /send_message_to_thread 失败/, f);
    delete process.env.FAKE_THREADS_FAIL;
    await run('btw', 'forward', 'bt6', a);
    const pf = path.join(dir, 'bt6-task.md');
    fs.writeFileSync(pf, '接着做。\n');
    fs.rmSync(fakeLog, { force: true });
    const out = await run('dispatch', 'bt6', 'q2', '--prompt-file', pf, '--mode', 'continue', '--prev', 'q1', ...E, 'title=第二轮', 'why=同一件事');
    const sm = calls().find((c) => c.tool === 'send_message_to_thread');
    assert.ok(sm.args.prompt.includes('顺便问 ' + b + '：没转过的'), '没转过的写进任务');
    assert.ok(!sm.args.prompt.includes('顺便问 ' + a + '：'), '同一会话已经转过的不重发');
    assert.match(out, new RegExp(a + ' [^\\n]*（同一会话，已经转过）'));
    assert.match(out, new RegExp(b + ' [^\\n]*（已写进发给会话的任务）'));
  } finally { delete process.env.FAKE_THREADS_LOG; delete process.env.FAKE_THREADS_FAIL; }
  // 再换一次会话：from 仍是最早的 q1；新会话不知道这些问题，fwd 清掉
  await run('round', 'add', 'bt6', 'q3', '--mode', 'new', '--prev', 'q2', '--handoff', handoff, ...E, 'title=第三轮', 'sid=' + BS(3), 'why=阶段边界');
  let d = read3(f);
  assert.deepEqual(d.btw.map((x) => [x.round, x.from, !!x.fwd]), [['q3', 'q1', false], ['q3', 'q1', false]]);
  // 裁剪：轮次被裁掉（按已结束轮次留 40 条）时挂在它上面的顺便问一起删，删光了就去掉 btw 字段（还在等答的轮次不裁，先答 / 结束掉）
  await run('btw', 'answer', 'bt6', a, 'a=答了');
  await run('btw', 'end', 'bt6', b, 'why=不相干');
  A.mutate(f, (x, now) => {
    for (let i = 0; i < 41; i++) x.rounds.push({ id: 'old' + i, title: 't', status: 'accepted', proj: 'ws-a', updated: '2027-01-01T00:00:' + String(i).padStart(2, '0') + '+08:00' });
    for (const r of x.rounds.filter((r) => /^q/.test(r.id))) Object.assign(r, { status: 'accepted', updated: '2020-01-01T00:00:00+08:00' });
    return '';
  });
  d = read3(f);
  assert.ok(!d.rounds.some((r) => r.id === 'q3'), 'q3 被裁掉');
  assert.equal(d.btw, undefined, '挂在裁掉的轮次上的顺便问一起删，删光了就没有 btw 字段');
});
