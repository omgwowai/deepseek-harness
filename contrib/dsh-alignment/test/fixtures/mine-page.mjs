// 「我的」页签的测试 / 截图数据：接近真实的待办、目标、关键结果、进度记录和在等待办的会话（待办标题取自 personal-ops 11-02 的未完成任务，目标是方案报告里的示例）。
// 只造数据对象，不写文件；时间按传入的「今天」算，「已过 N 天」不随跑测试的日期变。
const p2 = (n) => String(n).padStart(2, '0');
export const SID = (n) => 'session-0000000' + n + '-0000-4000-8000-000000000000';
/** today = 本机日期 YYYY-MM-DD；返回页面数据（version 3）。 */
export function minePage(name, today) {
  const day = (k) => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + k); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  const at = (k, h = '10:00') => day(k) + 'T' + h + ':00+08:00';
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const T = (id, title, x) => ({ id, title, status: 'open', src: '手记', created: at(-9), updated: at(-1), log: [{ at: at(-9), ev: 'add' }], ...x });
  const g1 = 'g-narr', g2 = 'g-yinzi', g3 = 'g-pcua';
  return {
    version: 3, name, title: '我的测试', owner: SID(9), updated: ago(1),
    projects: [{ id: 'hs', title: 'highschool', cwd: 'C:/p/hs' }, { id: 'dsh', title: '.dsh', cwd: 'C:/p/dsh' }],
    rounds: [
      { id: 'r-ban', sid: SID(1), title: '从禁用词里去掉「啥」，等 27B 恢复后验证、上 01', status: 'paused', proj: 'hs', started: ago(300), eta: '20m', goal: g1, wait: 't-tianyi', state: '等 27B 接口恢复。' },
      { id: 'r-cam', sid: SID(2), title: '旁白：镜头内上下文对照截图 + 中心到边缘详略', status: 'doing', proj: 'hs', started: ago(40), eta: '30m', goal: g1, state: '在做对照截图。' },
      { id: 'r-duo', sid: SID(3), title: '旁白团播模式：实现 + 测试机实测', status: 'done', proj: 'hs', started: ago(200), ended: ago(30), eta: '2h', goal: g1, result: '团播模式在 01 上跑通。' },
      { id: 'r-dsh', sid: SID(4), title: 'DSH：流式文字逐渐显示，对齐 Claude Code app', status: 'doing', proj: 'dsh', started: ago(50), eta: '1h' },
    ],
    decisions: [{ id: 'd1', title: '旁白「最近的台词」列不列即兴闲聊', why: '列了会拖长提示词。所以来问。', status: 'open', round: 'r-cam', proj: 'hs', risk: '中', cat: '方向取舍', opened: ago(20), due: new Date(Date.now() + 5 * 36e5).toISOString(), opt: [{ label: '列', effect: '信息全' }, { label: '不列', effect: '提示词短' }], rec: '不列' }],
    notes: [{ id: 'rec-' + today.replace(/-/g, '') + '-1', title: '试一次 pcua 接管早报截图', body: '整链误否上周降到 1.2%；今天有 20 分钟空档。', updated: ago(120) }],
    goals: [
      { id: g1, title: '旁白 11 月上线测试机：01、05 都用 Bellwether 连续跑通 10 局', status: 'doing', range: '季度', metric: '连续跑通', unit: '局', base: 0, cur: 2, target: 10, due: day(28), projs: ['hs'], why: '双击桌面「旁白 开始」就能跑完一局，中途不断、不用人管。',
        kr: [{ id: 'k1', title: '27B 接口稳定、并发 2', cur: 0, target: 2 }, { id: 'k2', title: '离线测试集四项问题修完', cur: 3, target: 4 }, { id: 'k3', title: '05 和 01 同时各跑一局' }],
        log: [{ at: at(-2, '21:10'), cur: 1, note: '01 跑通第一局，最长沉默 131 秒' }, { at: at(-1, '18:40'), cur: 2, note: '01 团播跑通' }, { at: at(-1, '19:00'), cur: 3, kr: 'k2', note: '句尾重复修好' }], created: at(-20), updated: at(-1) },
      { id: g2, title: '寅子数据集：训练数据和约 900 题视频理解评测', status: 'doing', range: '月度', metric: '评测题', unit: '题', cur: 340, target: 900, due: day(12), created: at(-15), updated: at(-3) },
      { id: g3, title: 'pcua 接管日常 GUI 操作：整链误否压到 0.5% 以下', status: 'doing', range: '季度', kr: [{ id: 'k1', title: '误否率 ≤ 0.5%', done: at(-4) }, { id: 'k2', title: '早报截图全用 pcua' }], created: at(-30), updated: at(-4) },
      { id: 'g-old', title: '对齐页手机端上线', status: 'done', range: '月度', created: at(-40), updated: at(-12), ended: at(-12) },
    ],
    todos: [
      T('t-tianyi', '找 Tianyi：27B 旁白接口 30353 续期或给新地址 + 开第 2 个并发', { p: 'P0', urg: '紧急', energy: '低', eta: '10m', due: day(-5), today: day(-2), goal: [g1], why: '接口 10-28 16:20 已过期；镜头 mod 对比和台词回放都在等。', log: [{ at: at(-9), ev: 'add' }, { at: at(-2), ev: 'today' }] }),
      T('t-yinzi', '寅子的数据集 的 扩大+筛选 管线', { status: 'doing', p: 'P0', urg: '正常', energy: '中', eta: '2h', due: day(-6), today: day(0), goal: [g2], log: [{ at: at(-9), ev: 'add' }, { at: at(0, '08:30'), ev: 'today' }, { at: at(0, '09:00'), ev: 'doing' }] }),
      T('t-pair', '和 cua-pick-speed 会话 pair-thinking：定 cua-pick 适应所有场景的目的和方案', { p: 'P1', urg: '正常', energy: '高', eta: '45m', goal: [g3] }),
      T('t-codex', '试一次原版 Codex 语音 + 原生 agent，看还晕不晕', { p: 'P1', urg: '正常', energy: '低', eta: '15m' }),
      T('t-harness', '决定早报 Harness 待处理升级：rapidocr 3.9.2→3.10.0、Go 1.26.5→1.27.3、Win32-OpenSSH 10.0p2→10.4p1', { p: 'P2', urg: '正常', energy: '低', eta: '10m' }),
      T('t-mac', '在 Mac 浏览器打开内网站点，首次弹框选本机证书', { p: 'P3', urg: '不急', energy: '低', eta: '5m' }),
      T('t-cam', '镜头内上下文：对照截图和中心到边缘详略', { status: 'sent', round: 'r-cam', goal: [g1], log: [{ at: at(-3), ev: 'add' }, { at: at(-1), ev: 'send', round: 'r-cam' }] }),
      T('t-done1', '回对齐页 3 个待决定', { status: 'done', ended: at(-1, '17:20'), goal: [g1], log: [{ at: at(-4), ev: 'add' }, { at: at(-1, '17:20'), ev: 'done' }] }),
      T('t-done2', '点头或否决：把 harness2 的优化思路吸收进 revise-harness skill', { status: 'done', ended: at(0, '09:40'), log: [{ at: at(-5), ev: 'add' }, { at: at(0, '09:40'), ev: 'done' }] }),
      T('t-drop', '换一台测试机跑旁白', { status: 'dropped', ended: at(-2, '11:00'), log: [{ at: at(-6), ev: 'add' }, { at: at(-2, '11:00'), ev: 'drop' }] }),
    ],
  };
}
