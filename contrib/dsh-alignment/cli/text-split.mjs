// text-split.mjs：对齐页正文拆分（要点 / token / 数字卡），网页和服务端共用同一份代码。
// - 服务端：align.mjs createHandler（/data、/answer、/order）和插件 createPhoneBridge（pageData3 / answerBatch3）给版本 3 页面的
//   响应多一个 data.text = textOf(data)（只在响应里，不写文件、不参加校验）。形状：docs/alignment-page-mobile-api.md 第 12 节。
// - 网页：align.mjs render() 把 @inline-begin … @inline-end 之间的源码原样注入 template.html 的 /*@text-split*/ 占位，
//   页面在浏览器里用同一份 tokens / segs / kpis / fixedTok 本地拆。所以这一段里不能有 import / export，也不能出现 </script。
// 单测：test/text-split.test.mjs（node --test plugins/dsh-alignment/test/text-split.test.mjs）。
// @inline-begin
const UNIT = '(?:%|％|毫秒|秒|分钟|小时|ms|GB|MB|KB|TB|tokens?|元|万次|万行|万字|万|次|位|句|行|对|题|票|版|轮|个|张|条|项|天|px|倍|字|段|人|家|处|帧|篇|页|分(?!钟))';
const NUM = '(?:[¥￥]\\s?\\d+(?:\\.\\d+)?(?:\\s?万)?|\\d+(?:\\.\\d+)?(?:\\s?[–~～-]\\s?\\d+(?:\\.\\d+)?)?\\s?' + UNIT + '|\\d+\\.\\d+(?:\\s?[–~～-]\\s?\\d+\\.\\d+)?|\\d{5,})(?![A-Za-z\\d])';
const LB = '(?<![\\w.\\-/\\\\])';
// 条目引用（对齐页详情区「复制引用」生成；留言框、正文、发送条列表认成短标签）：
//   〔对齐页 <页> · 轮次|决定 <id>[ · 待办|工具调用|附件|会话 <定位>]「<标题>」〕
// 标题去掉〔〕和换行、最多 40 字；定位里去掉〔〕「和换行。写法见本文件下方 refOf / splitRef。
const REF_KIND = { r: '轮次', d: '决定' };
// 子项：待办 / 工具调用 / 附件 / 会话；事实行 现状 / 结果 / 下一步 / 起因 / 待办原因 / 说明（决定的 why），下文的一句定位写「第 N 句」（第一句是第 1 句）
const REF_SUB = '待办原因|待办|工具调用|附件|会话|现状|结果|下一步|起因|说明';
const REF_RE = new RegExp('〔对齐页 ([a-z0-9-]+) · (轮次|决定) ([a-z0-9][a-z0-9-]{0,47})(?: · (' + REF_SUB + ')(?: ([^「〕\\n]+?))?)?(?:「([^〕\\n]*)」)?〕');
function refText(page, k, id, sub, at, title) {
  const t = String(title ?? '').replace(/[〔〕]/g, '').replace(/\s+/g, ' ').trim(), loc = String(at ?? '').replace(/[〔〕「\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return '〔对齐页 ' + page + ' · ' + REF_KIND[k] + ' ' + id + (sub ? ' · ' + sub + (loc ? ' ' + loc : '') : '') + (t ? '「' + (t.length > 40 ? t.slice(0, 39) + '…' : t) + '」' : '') + '〕';
}
function refParse(v) {
  const m = REF_RE.exec(String(v ?? ''));
  return m ? { page: m[1], k: m[2] === '轮次' ? 'r' : 'd', id: m[3], sub: m[4] || '', at: m[5] || '', title: m[6] || '' } : null;
}
const RX = [
  ['ref', new RegExp(REF_RE.source, 'g')],
  ['url', /https?:\/\/[^\s，。；;、）)」>]+/g],
  ['sid', /(?<![\w-])session-[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![\w-])/g],
  ['path', /(?:[A-Za-z]:[\\/]|~[\\/])[^\s，。；;、）)」「（(]+/g],
  ['code', /\x60([^\x60]+)\x60/g],
  ['hash', /(?<![\w.\-/\\#])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}(?![\w])/g],
  // 等宽的标识符和命令（网页用；手机接口照旧当文字）：核对编号、--参数、键=值、版本号、local.N、文件名、/路由、带 - 或 _ 的小写标识符、E 开头的错误码
  ['idf', /check-\d{8}-\d{6}|(?<![\w-])--[a-z][\w-]*(?: (?=[a-z0-9])[\w.|/-]+(?![^\s，。；、）)」]))?|(?<![\w-])[a-z]\w*=[\w|.-]+|(?<![\w.])\d+(?:\.\d+){2,}(?:-[\w.]+)?(?![\w.])|(?<![\w.])local\.\d+(?!\w)|(?<![\w./\\-])[\w-]+\.(?:ps1|js|mjs|cjs|ts|tsx|md|json|jsonl|log|txt|ya?ml|html|py|patch|cmd)(?!\w)|(?<![\w/])\/[a-z][\w-]*(?:\/[\w-]+)+|(?<![\w.-])[a-z][a-z0-9]*(?:[-_](?:[a-z0-9.]*[a-z0-9])?)*[-_][a-z0-9.]*[a-z0-9](?![\w-])|(?<!\w)E[A-Z]{3,}(?!\w)/g],
  // 步骤进度「第 N/M 步」：照文字写，不当成比例（网页用）
  ['step', /第\s?(\d+)\s?\/\s?(\d+)\s?步/g],
  // 引用原话：「你说的 / 你指定的 / 原话 / 用户说」后面「」里的话（网页用）
  ['quote', /(你说的|你指定的|你写的|你提的|用户说的?|用户原话|原话)(\s?)「([^「」\n]{1,80})」/g],
  ['wlt', /(\d+)\s?胜\s?(\d+)\s?负(?:\s?(\d+)\s?平)?/g],
  // 带 × 的倍数对比「×0.27 → ×0.78」（网页用，出来的 token 记成 cmp：画对比胶囊、下文按方向判；手机接口照旧是两个 num）
  ['xcmp', /(?<![\w.\-/\\])(×\s?\d+(?:\.\d+)?)\s*(?:→|->|⇒)\s*(×\s?\d+(?:\.\d+)?)(?!\d|\.\d)/g],
  ['cmp', new RegExp(LB + '(?:从\\s*)?(' + NUM + ')\\s*(?:→|->|⇒|(?:降|升|提|涨|减|缩|增|变)(?:到|至|成))\\s*(' + NUM + ')', 'g')],
  ['ratio', new RegExp(LB + '(\\d+(?:\\.\\d+)?)\\s?\\/\\s?(\\d+(?:\\.\\d+)?)(\\s?(?:GB|MB|TB|个|项|条|位|轮|次|题|对))?(?![\\d/])', 'g')],
  ['num', new RegExp(LB + NUM + '(?!\\.\\d)', 'g')],
  ['term', /「([^「」\n]{1,40})」/g],
  ['aside', /[（(]([^（）()\n]{2,140})[）)]/g],
];
// legacy：手机接口（textOf）只认原来那几种，网页加的 idf / step / quote / xcmp 不出
const WEB_ONLY = ['idf', 'step', 'quote', 'xcmp'];
function tokens(s, inner, legacy) {
  const out = [], str = String(s ?? ''), rx = RX.filter(([k]) => !(inner && k === 'aside') && !(legacy && WEB_ONLY.includes(k)));
  let i = 0;
  while (i < str.length) {
    let best = null;
    for (const [k, re] of rx) { re.lastIndex = i; const m = re.exec(str); if (m && m[0] && (!best || m.index < best.m.index)) best = { k, m }; }
    if (!best) { out.push({ t: 'text', v: str.slice(i) }); break; }
    const { k, m } = best;
    if (m.index > i) out.push({ t: 'text', v: str.slice(i, m.index) });
    // 路径末尾的英文标点（「见 D:\a\b.md, 然后」）不算路径
    const v = k === 'path' ? m[0].replace(/[.,:;!?'"]+$/, '') || m[0] : m[0];
    if (k === 'aside') out.push({ t: 'aside', v: tokens(m[1], true, legacy) });
    else out.push({ t: k === 'xcmp' ? 'cmp' : k, v, m: v === m[0] ? [...m] : [v] });
    i = m.index + v.length;
  }
  return out;
}
/** 一段文字里的会话 ID、路径、提交号、条目引用（按出现顺序，去重）：发送条列表行的浮层用 */
const MARK = ['sid', 'path', 'hash', 'ref'];
function marksOf(s) {
  const out = [], seen = new Set();
  for (const tk of tokens(s, true)) if (MARK.includes(tk.t) && !seen.has(tk.v)) { seen.add(tk.v); out.push({ t: tk.t, v: tk.v }); }
  return out;
}
/**
 * 留言输入区的分段：会话 ID / 路径 / 提交号 / 条目引用是标签，其余是文字（相邻文字并成一段）；各段原文拼起来就是原文。
 * hold = 光标位置：正好在光标前结束的那一个还在打（路径、提交号会越打越长），先当文字，打了空格 / 标点或离开输入框再变标签。
 * atoms = 已经显示成标签的 [{a, b, t}]（原文里的起止）：原样当一个标签，旁边紧挨着打字也不拆开、不并进别的词
 */
function memoSegs(s, hold, atoms) {
  const out = [];
  const text = (v) => { if (!v) return; if (out.length && out[out.length - 1].t === 'text') out[out.length - 1].v += v; else out.push({ t: 'text', v }); };
  const scan = (str, base) => {
    let at = base;
    const ts = tokens(str, true);
    ts.forEach((tk, k) => {
      at += tk.v.length;
      // 还在打：正好停在光标前；路径后面只跟着点号直到光标时也算（打到「progress.」时点号先被当成句末）。引用以〕收尾、不会再长，打完就是标签
      const nx = ts[k + 1], typing = tk.t !== 'ref' && (at === hold || (tk.t === 'path' && nx && nx.t === 'text' && /^\.+$/.test(nx.v) && at + nx.v.length === hold));
      if (MARK.includes(tk.t) && !typing) out.push({ t: 'mark', tk: { t: tk.t, v: tk.v } }); else text(tk.v);
    });
  };
  let i = 0;
  for (const x of (atoms || []).filter((x) => x.a >= 0 && x.b <= s.length && x.b > x.a).sort((p, q) => p.a - q.a)) {
    if (x.a < i) continue;
    scan(s.slice(i, x.a), i);
    out.push({ t: 'mark', tk: { t: x.t, v: s.slice(x.a, x.b) } });
    i = x.b;
  }
  scan(s.slice(i), i);
  return out;
}
const ASK = /所以来问|来问你|要你定|要你签审|要你确认|要你看|要你选|你亲口批|你之前说|你刚定过|属于对外沟通|要你去|你自己/;
const OPEN = '（(「[', CLOSE = '）)」]', CIRC = '①②③④⑤⑥⑦⑧⑨';
// 切成要点：换行、句号、分号断开（括号和引号里的不断）；①② 起新的一条；开头「- 」「+ 」是要点 / 好处 / 代价；「标签：」认成键值
function segs(s) {
  const out = [], str = String(s ?? '');
  let cur = '', depth = 0;
  const push = () => {
    let t = cur.trim(); cur = '';
    if (!t) return;
    const g = { text: t };
    if (CIRC.includes(t[0])) { g.no = CIRC.indexOf(t[0]) + 1; t = t.slice(1).trim(); }
    let m = /^[+＋]\s*/.exec(t);
    if (m) { g.pc = 'pro'; t = t.slice(m[0].length); }
    else if ((m = /^[-−－•·]\s+/.exec(t))) { if (m[0][0] !== '•' && m[0][0] !== '·') g.pc = 'con'; t = t.slice(m[0].length); }
    m = /^([^\s，,：:。；;「」（）()\d][^\s，,：:。；;「」（）()]{1,7})[：:]\s*(?=\S)/.exec(t);
    if (m && /[\u4e00-\u9fff]/.test(m[1])) { g.label = m[1]; t = t.slice(m[0].length); }
    g.text = t.replace(/[。；;，,]+$/, '');
    if (ASK.test(g.text)) g.ask = true;
    if (g.text) out.push(g);
  };
  for (let k = 0; k < str.length; k++) {
    const c = str[k];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    if (c === '\n') { depth = 0; push(); continue; }
    if (!depth && '。；;'.includes(c)) { push(); continue; }
    if (!depth && CIRC.includes(c) && cur.trim()) push();
    cur += c;
  }
  push();
  return out;
}
const numVal = (s) => { const m = String(s).replace(/,/g, '').match(/\d+(?:\.\d+)?/g); if (!m) return NaN; return m.length > 1 && /[–~～-]/.test(s) ? (parseFloat(m[0]) + parseFloat(m[1])) / 2 : parseFloat(m[0]); };
// 数字卡的标签：数字前面那一小句（到上一个标点为止），去掉「约 / 是 / 从 / 还」之类的虚词。
// 只在词边界取：句子开头（标点后）或空格（数字前的空格、数字和单位 / 英文之间的空格不算，「第 9 轮」「78 GiB」是一个词）；超过 10 字时取边界后最长的一段，
// 取不到（没有边界、或剩不到 2 个字）就不给标签，这个数字不上卡。
// 比较类：句末紧挨着「X 对 / vs / 比 Y」（连接词两边有空格、X 和 Y 都含字母或汉字）时取完整的「X 对 Y」，连接词照原文。
const WORD_GAP = new RegExp('\\s+(?!\\d)(?<!\\d\\s+(?=' + UNIT + '|[A-Za-z]))', 'g');
const CMP_TAIL = /(?:^|\s)(\S*[A-Za-z\u4e00-\u9fff]\S*\s+(?:对|vs\.?|VS|比)\s+\S*[A-Za-z\u4e00-\u9fff]\S*)$/;
function labelBefore(pre) {
  let t = pre.split(/[，,；;：:。、（(！!？?]/).pop() || '';
  t = t.replace(/[\s约是为从到达在的了共只仅已还也仍：:]+$/g, '').replace(/^(?:但|而|且|和|并|就|也|又|再)/, '').trim();
  const cmp = CMP_TAIL.exec(t);
  if (cmp && cmp[1].length <= 20) return cmp[1];
  if (t.length <= 10) return t;
  for (const m of t.matchAll(WORD_GAP)) { const s = t.slice(m.index + m[0].length); if (s.length <= 10) return s.length >= 2 ? s : ''; }
  return '';
}
function labelAfter(post) {
  const t = (post.split(/[，,；;：:。、（(]/)[0] || '').replace(/^[\s的]+/, '').replace(/^(?:但|而|且|和|并|就|也|又|再)/, '').trim();
  if (t.length <= 10) return t;
  let best = '';
  for (const m of t.matchAll(WORD_GAP)) { if (m.index > 10) break; best = t.slice(0, m.index); }
  return best.length >= 2 ? best : '';
}
const SCORE = (tk) => {
  if (tk.t === 'cmp' || tk.t === 'wlt') return 6;
  if (tk.t === 'ratio') return 4;
  if (tk.t !== 'num') return 0;
  if (/[¥￥]/.test(tk.v)) return 4.5;
  if (/[%％]/.test(tk.v)) return 3.5;
  if (/秒|分钟|小时|ms/.test(tk.v)) return 2.5;
  if (/GB|MB|TB|token/.test(tk.v)) return 2;
  return /\d\.\d|\d{4,}/.test(tk.v) ? 1.5 : 1;
};
// 指标：从要点里挑最有信息量的 max 个数字（对比 / 胜负 > 比例 > 金额 > 百分比 > 时长），按原文顺序排
function kpis(list, max) {
  const c = [];
  list.forEach((g, gi) => {
    // 数字卡只看原来那几种 token（网页加的 idf / step / quote 不影响挑卡，和手机接口同一个结果）
    const toks = tokens(g.text, false, true);
    let pre = '';
    toks.forEach((tk, ti) => {
      if (tk.t === 'aside') {
        // 括号里的数字：标签先取括号里前面的字，太短就取括号前那一句
        let ip = '';
        tk.v.forEach((x, xi) => { const sc = SCORE(x); if (sc) { const l = labelBefore(ip); c.push({ tk: x, sc: sc - 0.5, pos: gi * 1000 + ti + xi / 100, label: l.length >= 3 ? l : labelBefore(pre) || l }); } ip += x.v || ''; });
        pre += '（';
        return;
      }
      const sc = SCORE(tk);
      if (sc) {
        const post = toks.slice(ti + 1).map((x) => (x.t === 'aside' ? '' : x.v || '')).join('');
        // 同一句里紧跟在上一个数字后面的（「47.6%→9.2%、29.6%→8.4%」）沿用上一个的标签
        const prev = c.length && Math.floor(c[c.length - 1].pos / 1000) === gi ? c[c.length - 1].label : '';
        const lb = /[、和与及]\s*$/.test(pre) ? '' : labelBefore(pre);
        c.push({ tk, sc, pos: gi * 1000 + ti, label: lb || prev || labelAfter(post) || g.label || '' });
      }
      pre += tk.v;
    });
  });
  // 没有标签的数字不上卡（看不出是什么），留在句子里
  return c.filter((x) => x.label && x.label.length >= 2).sort((a, b) => b.sc - a.sc || a.pos - b.pos).slice(0, max).sort((a, b) => a.pos - b.pos);
}
// First Mate 用 kpi=标签::数值[::对比值] 指定的数字卡：每个 {label, value, from?} 转成一个 token（网页 fixedTiles 和 textOf 共用）
function fixedTok(k) {
  if (k.from) { const v = k.from + ' → ' + k.value; return { t: 'cmp', v, m: [v, k.from, k.value] }; }
  const ts = tokens(k.value, false, true).filter((x) => x.t !== 'text' || x.v.trim());
  return ts.length === 1 && ['ratio', 'num', 'wlt', 'cmp'].includes(ts[0].t) ? ts[0] : { t: 'num', v: k.value, m: [k.value] };
}

// ---- 下文的类型（网页详情区：一段正文第一句以后的每一句前面画什么符号；规则见下方 rowKinds）----
// 按顺序判、先中先用：序号（①②）→ 好处 / 代价 → 问你 → 要你做 → 风险 → 等重启 → 花费 → 对比 → 默认灰点。
// 手机接口（2026-10-26 起）由 textOf 把结果写进每句的 k / dir（docs/alignment-page-mobile-api.md 第 15 节），App 不另写一份。
// 网页上决定说明的第一句是不是「问你」也用 ASK_WEB（见 template.html bodyB）；共享的 ASK 只给 segs 的 g.ask（手机接口、数字卡候选）
const ASK_WEB = /所以来问|所以先问你|来问你|要你定|要你签审|要你确认|要你选|要你看|要看你|你亲口批/;
const YOU = /(?:要|需要|请)你(?:去|来|转|找|回|装|插|开|点|发|把|和|跟|帮|再|先|手动|亲自)|你得去|^你(?:回|去|把|先|来)/;
const RISK_L = /^(?:注意|风险|问题|已知问题|限制|隐患|影响)$|问题$/;
const RISK = new RegExp('没修好|还没修|未修复|没解决|未解决|仍然?(?:报错|失败)|在报错|会报?失败|失败了|(?:报|返回|全部|上游|HTTP|状态码?)[^，。；\\d]{0,4}[45]\\d\\d(?!\\d)(?!\\s?' + UNIT + ')|连不上|不通|(?:显示|已|还是|一直)离线|掉线了|没测|未测|没实测|未实测|没开始|没[^，。；、]{0,3}(?:做|跑|测|点|装|弄|写|改)完|剩 ?\\d* ?(?:条|项|个)[^，。；]{0,10}(?:问题|没改|没修|没做)|反而变差|变慢了|退化|红着|偶发(?:红|失败)');
const RISK_NOT = /旧代码[^，。；]{0,12}(?:失败|红)/;
const WAIT = /(?:要|需要?|等|待)[^，。；]{0,14}重启(?:\s?3080)?\s?(?:后|才|生效|[，。；]|$)|重启[^，。；]{0,6}才|重启前|重启后(?:生效|才|：|:)|check-\d{8}-\d{6}/;
const COST_L = /^(?:成本|花费|费用|预算)$/;
// 「A → B」两边换成同一量纲再比（时长、容量）；单位对不上时不比
const DIM = [['t', /毫秒|ms/, 0.001], ['t', /秒/, 1], ['t', /分钟/, 60], ['t', /小时/, 3600], ['t', /天/, 86400], ['b', /KB/, 1], ['b', /MB/, 1024], ['b', /GB/, 1048576], ['b', /TB/, 1073741824]];
const qty = (s) => { const v = numVal(s); for (const [d, re, k] of DIM) if (re.test(s)) return [v * k, d]; return [v, String(s).replace(/[\d.,\s–~～-]+/g, '')]; };
function cmpDir(toks) {
  const ds = toks.map((t) => { const [a, da] = qty(t.m[1]), [b, db] = qty(t.m[2]); return da !== db || !(a === a && b === b) || a === b ? 0 : b > a ? 1 : -1; });
  return ds.every((d) => d > 0) ? 'up' : ds.every((d) => d < 0) ? 'down' : 'flat';
}
const unq = (t) => t.replace(/「[^」]*」/g, '');
/** 每一句的类型 {k, n?, dir?}：k = no | pro | con | ask | you | warn | wait | cost | trend | dot；no 带序号 n；trend 带 dir = up | down | flat */
function rowKinds(list) {
  return list.map((g) => {
    const t = g.text, l = g.label || '';
    if (g.no) return { k: 'no', n: g.no };
    if (g.pc === 'pro' || /^(?:好处|收益)$/.test(l)) return { k: 'pro' };
    if (g.pc === 'con' || l === '代价' || /^代价是/.test(t)) return { k: 'con' };
    if (ASK_WEB.test(unq(t))) return { k: 'ask' };
    if (YOU.test(unq(t))) return { k: 'you' };
    if (RISK_L.test(l) || (RISK.test(t) && !RISK_NOT.test(t))) return { k: 'warn' };
    if (WAIT.test(t) && !/已重启/.test(t)) return { k: 'wait' };
    const fl = tokens(t).flatMap((x) => (x.t === 'aside' ? x.v : [x]));
    if (COST_L.test(l) || fl.some((x) => x.t === 'num' && /[¥￥]/.test(x.v))) return { k: 'cost' };
    const cm = fl.filter((x) => x.t === 'cmp');
    // 句子里还有没认成对比的箭头（「旧版 → 新版」这类两边不是数的）时方向说不清，画 →
    if (cm.length) return { k: 'trend', dir: (t.match(/→|->|⇒/g) || []).length > cm.length ? 'flat' : cmpDir(cm) };
    return { k: 'dot' };
  });
}

// ---- textOf(data)：服务端拆好的正文 data.text（手机接口版本 6；形状见 docs/alignment-page-mobile-api.md 第 12 节）----
const TX_FINISHED = ['done', 'accepted', 'dropped'];
const txFail = (msg) => { throw new Error('textOf: ' + msg); };
const txStr = (it, k, where) => { if (it[k] !== undefined && typeof it[k] !== 'string') txFail(where + '.' + k + ' 必须是字符串'); return it[k]; };
// token 的线上形状：RegExp 匹配数组里 undefined 的组写 null；aside 递归。
// sid（会话 ID，2026-10-24 网页留言框的短标签加的）和 ref（条目引用，同日详情区复制引用加的）不在冻结接口的 token 类型里，折成 text 并和相邻 text 合并。
function txTokList(ts) {
  const out = [];
  for (const tk of ts) {
    const x = tk.t === 'sid' || tk.t === 'ref' ? { t: 'text', v: tk.v } : txTok(tk);
    const last = out[out.length - 1];
    if (x.t === 'text' && last && last.t === 'text') last.v += x.v; else out.push(x);
  }
  return out;
}
function txTok(tk) {
  if (tk.t === 'aside') return { t: 'aside', v: txTokList(tk.v) };
  if (tk.t === 'text') return { t: 'text', v: tk.v };
  if (!Array.isArray(tk.m)) txFail('token ' + tk.t + ' 没有匹配数组');
  return { t: tk.t, v: tk.v, m: tk.m.map((x) => (x === undefined ? null : x)) };
}
const txToks = (s) => txTokList(tokens(s, false, true));
// 网页那一份 token（比 toks 多 idf / step / quote，xcmp 记成 cmp；2026-10-26）：只在和 toks 不同时给，App 有就画它，没有就画 toks
const txWeb = (s, legacy) => { const w = txTokList(tokens(s)); return JSON.stringify(w) === JSON.stringify(legacy) ? undefined : w; };
// kind = rowKinds 判出的这一句的类型（下文前面画什么符号，见 rowKinds）：k，trend 另带 dir；序号的 n 就是 no
function txSeg(g, kind) {
  const o = { toks: txToks(g.text) };
  if (g.label) o.label = g.label;
  if (g.no) o.no = g.no;
  if (g.pc) o.pc = g.pc;
  if (g.ask) o.ask = true;
  const w = txWeb(g.text, o.toks);
  if (w) o.w = w;
  if (kind) { o.k = kind.k; if (kind.dir) o.dir = kind.dir; }
  return o;
}
// 决定说明、轮次现状 / 结果：每句带类型。决定说明的第一句是不是「问你」按网页 bodyB 同一判定（ASK_WEB），是记 ask，否则不记 ask
function txKindSegs(list, first) {
  const ks = rowKinds(list);
  if (first && list.length) ks[0] = ASK_WEB.test(unq(list[0].text)) ? { k: 'ask' } : ks[0].k === 'ask' ? { k: 'dot' } : ks[0];
  return list.map((g, i) => txSeg(g, ks[i]));
}
// next / why / result 这类整段 token：toks 照旧，网页那一份不同时另给 <名字>W
function txToksW(o, key, s) { const t = txToks(s); o[key] = t; const w = txWeb(s, t); if (w) o[key + 'W'] = w; }
// 数字卡：带 kpi 的按原顺序全部 fixed、rank = 下标；否则 kpis(候选, 4)，数组按原文位置，rank = 按分数的名次（0 最好）。
// 客户端前面另有 n 张自己的卡时只取 rank < 4 - n 的，和网页 kpis(list, 4 - n) 相同。
function txTiles(it, cands, where) {
  if (it.kpi !== undefined) {
    if (!Array.isArray(it.kpi)) txFail(where + '.kpi 必须是数组');
    return it.kpi.map((k, i) => {
      if (!k || typeof k.label !== 'string' || typeof k.value !== 'string' || (k.from !== undefined && typeof k.from !== 'string')) txFail(where + '.kpi[' + i + '] 要是 {label, value, from?}（字符串）');
      return { label: k.label, tk: txTok(fixedTok(k)), rank: i, fixed: true };
    });
  }
  const ks = kpis(cands, 4);
  const byScore = [...ks].sort((a, b) => b.sc - a.sc || a.pos - b.pos);
  return ks.map((k) => ({ label: k.label, tk: txTok(k.tk), rank: byScore.indexOf(k) }));
}
// 只对版本 3 页面算；形状不对就抛错（不兜底）
function textOf(data) {
  if (!data || data.version !== 3) txFail('只算版本 3 页面，拿到 version ' + JSON.stringify(data && data.version));
  if (!Array.isArray(data.decisions) || !Array.isArray(data.rounds)) txFail('页面缺 decisions / rounds 数组');
  const d = {}, r = {};
  for (const x of data.decisions) {
    if (!x || typeof x.id !== 'string' || !x.id) txFail('决定缺 id');
    const where = 'decision/' + x.id;
    if (x.opt !== undefined && !Array.isArray(x.opt)) txFail(where + '.opt 必须是数组');
    const why = segs(txStr(x, 'why', where));
    d[x.id] = {
      why: txKindSegs(why, true),
      kpi: txTiles(x, why.filter((g) => !g.ask), where),
      opt: (x.opt || []).map((o, i) => { if (!o || typeof o !== 'object') txFail(where + '.opt[' + i + '] 必须是对象'); return segs(txStr(o, 'effect', where + '.opt[' + i + ']')).map((g) => txSeg(g)); }),
      result: null,
    };
    if (txStr(x, 'result', where)) txToksW(d[x.id], 'result', x.result);
  }
  for (const x of data.rounds) {
    if (!x || typeof x.id !== 'string' || !x.id) txFail('轮次缺 id');
    const where = 'round/' + x.id;
    for (const k of ['state', 'result', 'next', 'why']) txStr(x, k, where);
    // 网页同一口径：已结束（done / accepted / dropped）先取 result，否则先取 state
    const from = (TX_FINISHED.includes(x.status) ? ['result', 'state'] : ['state', 'result']).find((k) => x[k]) || null;
    const main = segs(from ? x[from] : '');
    const o = r[x.id] = { main: txKindSegs(main, false), mainFrom: from, next: null, why: null, kpi: txTiles(x, main, where) };
    if (x.next) txToksW(o, 'next', x.next);
    if (x.why) txToksW(o, 'why', x.why);
  }
  return { v: 1, d, r };
}
// @inline-end

export { UNIT, NUM, REF_KIND, REF_SUB, REF_RE, refText, refParse, RX, tokens, marksOf, memoSegs, segs, numVal, labelBefore, labelAfter, SCORE, kpis, fixedTok, rowKinds, cmpDir, textOf };
