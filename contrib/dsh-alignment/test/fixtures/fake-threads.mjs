// 替身 dsh-threads：和 scripts/threads-cli/dsh-threads.mjs 一样导出 main(argv, env, out, err)，给 align 的测试用（ALIGN_THREADS_CLI 指向本文件）。
// 不连 3080。行为由环境变量控制（每次调用时读）：
//   FAKE_THREADS_LOG     每次调用追加一行 JSON {tool, args, caller} 到这个文件
//   FAKE_THREADS_DOWN=1  所有调用都像 3080 连不上一样失败
//   FAKE_THREADS_FAIL=<tool>  这个工具失败
//   FAKE_THREADS_RACE_PAGE=<页面文件>  create_thread 时抢先往这页写一条同 id 的轮次（id 取 prompt 之外的 title 不可靠，所以写 d1），模拟「会话建好、登记失败」
//   FAKE_THREADS_WS_EXISTING=<id>  create_workspace 当作目录已是这个工作区（created: false）；不设就当新建（id ws-new-<目录名>）
// 会话是否存在：id 以 session-dead 开头的不存在，其余都存在。create_thread 返回的 sid 记在日志里。
import fs from 'node:fs';
import path from 'node:path';

let seq = 0;
export async function main(argv, env, out, err) {
  const [tool, raw] = argv;
  const args = JSON.parse(raw ?? '{}');
  if (process.env.FAKE_THREADS_LOG) fs.appendFileSync(process.env.FAKE_THREADS_LOG, JSON.stringify({ tool, args, caller: env.DSH_SESSION_ID ?? null }) + '\n');
  if (process.env.FAKE_THREADS_DOWN === '1') throw new Error('fetch failed (connect ECONNREFUSED 127.0.0.1:3080)');
  if (process.env.FAKE_THREADS_FAIL === tool) { err.write(tool + ' 替身故意失败\n'); return 1; }
  if (tool === 'read_thread') {
    if (args.threadId.startsWith('session-dead')) { err.write('No dsh thread found for threadId: ' + args.threadId + '. Hosts without a readable match: local\n'); return 1; }
    out.write(JSON.stringify({
      schemaVersion: 1,
      thread: { id: args.threadId, kind: 'dsh', hostId: 'local', title: '替身会话', status: { type: 'idle' }, createdAt: 1793000000, updatedAt: 1793000600 },
      page: { order: 'newest_first', limit: args.turnLimit ?? 3, nextCursor: null, hasMore: false },
      turns: [
        { id: 't2', status: 'interrupted', error: null, startedAt: 1793000500, completedAt: 1793000600, items: [{ type: 'userMessage', id: 'u2', content: [] }] },
        { id: 't1', status: 'completed', error: null, startedAt: 1793000000, completedAt: 1793000100, items: [
          { type: 'agentMessage', id: 'a0', text: '中间的话', phase: 'commentary' },
          { type: 'agentMessage', id: 'a1', text: '最后一句：' + '长'.repeat(300), phase: 'final' },
        ] },
      ],
    }) + '\n');
    return 0;
  }
  if (tool === 'create_thread') {
    if (process.env.FAKE_THREADS_RACE_PAGE) {
      const A = await import(new URL('../../cli/align.mjs', import.meta.url).href);
      const f = process.env.FAKE_THREADS_RACE_PAGE, d = A.parsePage(fs.readFileSync(f, 'utf8'));
      d.rounds.push({ ...d.rounds[0], id: 'd1', title: '别人抢先登记' });
      fs.writeFileSync(f, A.render(d));
    }
    const sid = 'session-0000feed-0000-4000-8000-' + String(process.pid % 1e6).padStart(6, '0') + String(++seq).padStart(6, '0');
    if (process.env.FAKE_THREADS_LOG) fs.appendFileSync(process.env.FAKE_THREADS_LOG, JSON.stringify({ created: sid }) + '\n');
    out.write(JSON.stringify({ threadId: sid, hostId: 'local' }) + '\n');
    return 0;
  }
  if (tool === 'send_message_to_thread') {
    if (args.threadId.startsWith('session-dead')) { err.write('No dsh thread found for threadId: ' + args.threadId + '\n'); return 1; }
    out.write(JSON.stringify({ threadId: args.threadId, hostId: 'local', delivered: true }) + '\n');
    return 0;
  }
  if (tool === 'create_workspace') {
    const id = process.env.FAKE_THREADS_WS_EXISTING;
    out.write(JSON.stringify({ projectId: id || 'ws-new-' + path.basename(args.path), path: args.path, title: path.basename(args.path), created: !id }) + '\n');
    return 0;
  }
  err.write('替身不认识 ' + tool + '\n');
  return 1;
}
