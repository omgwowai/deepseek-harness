// text-fixtures.mjs：给手机 App 生成 data.text 的对拍夹具（服务端 textOf 的输入和输出成对存下来，App 用同样的输入跑自己的渲染逻辑对拍）。
//
// 用法（在 ~/.dsh 下）：
//   node plugins/dsh-alignment/cli/text-fixtures.mjs [输出文件]
//   输出文件缺省 = ~/.dsh/tmp/mobile-align-v8/impl/text-fixtures.json；ALIGN_FIXTURE_PAGE=<页名> 换真实页（缺省 first-mate）
// 内容：{"generated": <ISO>, "cases": [{"name", "data": <版本 3 页面数据>, "text": <textOf(data)>}]}
//   - real:<页名>：登记表里的真实页面（align.mjs pageData() 读，照存盘原样）
//   - synthetic:all-tokens：SAMPLE_PAGE，覆盖全部 token 类型、要点标签 / 序号 / 好处代价 / ask、自动挑和指定（fixed）的数字卡、轮次 mainFrom 三种口径
// SAMPLE_PAGE 也被 test/text-split.test.mjs 用（检查它真的覆盖了这些情况、并且能过 align.mjs validate）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const T = '2026-10-24T14:00:00+08:00';
export const SAMPLE_PAGE = {
  version: 3, name: 'text-sample', title: '正文拆分样例', owner: 'session-sample', updated: T,
  projects: [{ id: 'p1', title: '样例项目', cwd: 'C:/proj/sample' }],
  rounds: [
    { id: 'r-doing', proj: 'p1', title: '进行中的轮次', status: 'doing', sid: 'session-a', updated: T,
      state: '现状：错字率从 47.6% 降到 9.2%，比赛 12 胜 3 负 1 平。显存占用 15.2/16.3 GB（峰值 1.5 秒）。见 https://example.com/report/1 和 C:\\Users\\x\\out.json',
      result: '这段不该当正文', next: '你确认一下「发布窗口」', why: '起因：提交 3f9a2c1d 之后 \`npm test\` 变慢了 2.5 秒' },
    { id: 'r-done', proj: 'p1', title: '做完待验收', status: 'done', sid: 'session-a', updated: T,
      state: '旧的现状', result: '结果：耗时 120 秒 → 45 秒；成本 ¥12.5；处理 30000 条' },
    { id: 'r-state-only', proj: 'p1', title: '做完但只有现状', status: 'accepted', updated: T, state: '只写了现状 3/4 项' },
    { id: 'r-result-only', proj: 'p1', title: '进行中但只有结果', status: 'doing', updated: T, result: '先交了半份 50%' },
    { id: 'r-empty', proj: 'p1', title: '什么都没写', status: 'paused', updated: T },
    // 下文每种类型各一句（rowKinds：序号 / 好处 / 代价 / 问你 / 要你做 / 风险 / 等重启 / 花费 / 对比升降平 / 默认），外加网页才认的 step / quote / idf（2026-10-26，手机接口 k / w 字段）
    { id: 'r-kinds', proj: 'p1', title: '下文类型齐全的轮次', status: 'doing', sid: 'session-a', updated: T,
      state: '现状：对齐页手机版第 2/5 步，正在改 text-split.mjs。① 先补服务端字段。+ 好处：两端同一份规则。- 代价：要多传几个字段。所以来问你要不要现在重启。需要你去手机上点一下安装。上游还在报 503。要等重启 3080 后才生效，核对编号 check-20261026-093000。这次花了 ¥3.5。耗时 120 秒 → 45 秒。体积 30 MB → 45 MB。旧版 → 新版 3 秒 → 2 秒。你说的「先别重启」照做。普通的一句 --refine none',
      next: '跑 dsh-verify 第 1/2 步', why: '用户原话「跟上网页」' },
    { id: 'r-fixed', proj: 'p1', title: '指定数字卡的轮次', status: 'doing', updated: T, state: '准确率 88% 不上卡',
      kpi: [{ label: '准确率', value: '93%', from: '88%' }, { label: '进度', value: '3/5 项' }, { label: '说明', value: '待定' }] },
  ],
  decisions: [
    { id: 'd-open', proj: 'p1', round: 'r-doing', title: '选哪个方案', status: 'open', risk: '中', cat: '方向取舍', updated: T,
      why: '①背景：现在每次构建要 90 秒；②代价：换方案要花 ¥300（一次性）\n+ 好处：构建降到 20 秒\n- 风险：要你确认迁移窗口\n• 普通要点，没有好处代价',
      opt: [{ label: '甲', effect: '+ 快 3 倍；- 多花 ¥300' }, { label: '乙', effect: '维持现状' }], rec: '甲' },
    { id: 'd-fixed', proj: 'p1', title: '指定了数字卡', status: 'open', risk: '低', cat: '其他', updated: T,
      why: '这里的 75% 不会自动上卡', opt: [{ label: '好', effect: '照做' }, { label: '不', effect: '不做' }],
      kpi: [{ label: '胜负', value: '8 胜 2 负' }, { label: '耗时', value: '1.5 小时' }] },
    { id: 'd-done', proj: 'p1', title: '已定的决定', status: 'done', updated: T, choice: '甲', result: '已按「甲」执行，见 a1b2c3d4e' },
    { id: 'd-pending', title: '等信息的决定', status: 'pending', updated: T },
  ],
  notes: [],
};

async function main() {
  const { pageData, validate, textOf } = await import('./align.mjs');
  const out = process.argv[2] || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'tmp', 'mobile-align-v8', 'impl', 'text-fixtures.json');
  const real = process.env.ALIGN_FIXTURE_PAGE || 'first-mate';
  validate(structuredClone(SAMPLE_PAGE));
  const data = pageData(real);
  if (data.version !== 3) throw new Error('页面 ' + real + ' 是版本 ' + data.version + '，夹具要版本 3');
  const cases = [['real:' + real, data], ['synthetic:all-tokens', SAMPLE_PAGE]].map(([name, d]) => ({ name, data: d, text: textOf(d) }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ generated: new Date().toISOString(), cases }, null, 1) + '\n');
  fs.renameSync(tmp, out);
  console.log('写了 ' + out + '：' + cases.length + ' 个 case（' + cases.map((c) => c.name).join('、') + '）');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
