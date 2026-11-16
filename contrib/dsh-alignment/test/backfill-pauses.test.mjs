// 老轮次补暂缓时段（2026-10-26）：从会话日志里的 align 命令推出每一轮进出暂缓的时刻；推不出的标 untimed。纯函数，不读真日志。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ALIGN_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'align-backfill-'));
const B = await import('../cli/backfill-pauses.mjs');
const A = await import('../cli/align.mjs');

const T = (h, m = 0) => Date.parse('2026-10-26T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00+08:00');
const iso = (t) => A.nowIso(new Date(t));

test('statusCommands：认 round set … status=、round add … --prev；一条里的几个命令都认；别的字段不算', () => {
  assert.deepEqual(B.statusCommands("align round set first-mate phone-install status=paused 'state=等家里电脑'; exit $LASTEXITCODE"), [{ page: 'first-mate', id: 'phone-install', status: 'paused' }]);
  assert.deepEqual(B.statusCommands("node C:/x/align.mjs round set 'D:/fm-home/alignment.html' r1 'next=继续' 'status=doing'"), [{ page: 'D:/fm-home/alignment.html', id: 'r1', status: 'doing' }]);
  assert.deepEqual(B.statusCommands('align round add fm r2 --prev r1 --mode continue title=x; align round set fm r3 status=dropped'), [{ page: 'fm', id: 'r1', status: 'done' }, { page: 'fm', id: 'r3', status: 'dropped' }]);
  assert.deepEqual(B.statusCommands("align round set fm r1 'state=写了 substatus=paused 这样的字'"), []);
  assert.deepEqual(B.statusCommands('align decide add fm d1 status=open'), []);
});

test('commandsInLog：只认退出码 0 的 pwsh 后台任务，时刻取任务结束', () => {
  const ev = (type, data) => JSON.stringify({ type, time: data.finishedAt ?? data.startedAt, data });
  const log = [
    ev('job/registered', { jobId: 'j1', kind: 'pwsh', label: 'align round set fm r1 status=paused', startedAt: T(10) }),
    ev('job/settled', { jobId: 'j1', kind: 'pwsh', label: 'x', startedAt: T(10), finishedAt: T(10, 1), status: 'completed', detail: 'exit code: 0' }),
    ev('job/registered', { jobId: 'j2', kind: 'pwsh', label: 'align round set fm r1 status=doing', startedAt: T(11) }),
    ev('job/settled', { jobId: 'j2', finishedAt: T(11, 1), status: 'completed', detail: 'exit code: 1' }),
    ev('job/registered', { jobId: 'j3', kind: 'workflow', label: 'round set fm r1 status=doing', startedAt: T(12) }),
    ev('job/settled', { jobId: 'j3', finishedAt: T(12, 1), status: 'completed', detail: 'exit code: 0' }),
    'not json round ',
  ].join('\n');
  assert.deepEqual(B.commandsInLog(log), [{ t: T(10, 1), page: 'fm', id: 'r1', status: 'paused' }]);
});

test('inferPauses：按顺序走状态机；暂缓中的最后一段开着；推不出就 untimed；没暂缓过不动', () => {
  const r = { id: 'r1', started: iso(T(9)), status: 'accepted', ended: iso(T(16)) };
  const e = (h, status) => ({ t: T(h), status });
  assert.deepEqual(B.inferPauses(r, [e(13, 'doing'), e(10, 'paused'), e(11, 'paused'), e(14, 'paused'), e(15, 'done')]),
    { pauses: [{ from: iso(T(10)), to: iso(T(13)) }, { from: iso(T(14)), to: iso(T(15)) }] }, '乱序输入按时间排；重复的 paused 不另开一段');
  assert.deepEqual(B.inferPauses(r, [e(8, 'paused'), e(17, 'paused')]), null, '这一轮时间窗外的命令不算');
  assert.deepEqual(B.inferPauses({ ...r, status: 'paused', ended: undefined }, [e(10, 'paused')]), { pauses: [{ from: iso(T(10)) }] });
  assert.deepEqual(B.inferPauses({ ...r, status: 'paused', ended: undefined }, []), { untimed: true }, '现在暂缓、找不到进入暂缓的命令');
  assert.deepEqual(B.inferPauses({ ...r, status: 'paused', ended: undefined }, [e(10, 'paused'), e(11, 'doing')]), { untimed: true }, '现在暂缓、最后一次进入暂缓没找到');
  assert.deepEqual(B.inferPauses(r, [e(10, 'paused')]), { untimed: true }, '进了暂缓、离开的命令没找到');
  assert.equal(B.inferPauses(r, [e(10, 'doing')]), null);
});

test('plan：只看这一页的命令，已经有 pauses / untimed 的轮次不动；结果过得了页面校验', () => {
  const data = { version: 3, name: 'fm', title: '页', updated: iso(T(17)), projects: [], decisions: [], notes: [], rounds: [
    { id: 'r1', title: '一', status: 'accepted', started: iso(T(9)), ended: iso(T(16)) },
    { id: 'r2', title: '二', status: 'paused', started: iso(T(9)) },
    { id: 'r3', title: '三', status: 'paused', started: iso(T(9)), pauses: [{ from: iso(T(12)) }] },
    { id: 'r4', title: '四', status: 'doing', started: iso(T(9)) },
  ] };
  const c = (h, page, id, status) => ({ t: T(h), page, id, status });
  const cmds = [c(10, 'fm', 'r1', 'paused'), c(11, 'fm', 'r1', 'doing'), c(10, 'other', 'r4', 'paused'), c(13, 'fm', 'r3', 'paused')];
  const out = B.plan(data, cmds, (p) => p === 'fm');
  assert.deepEqual(out.map(({ id, pauses, untimed }) => ({ id, pauses, untimed })), [
    { id: 'r1', pauses: [{ from: iso(T(10)), to: iso(T(11)) }], untimed: undefined },
    { id: 'r2', pauses: undefined, untimed: true },
  ]);
  for (const x of out) { const r = data.rounds.find((y) => y.id === x.id); if (x.untimed) r.untimed = 'true'; else r.pauses = x.pauses; }
  A.validate(data);
});
