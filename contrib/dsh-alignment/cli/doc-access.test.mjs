// node --test plugins/dsh-alignment/cli/doc-access.test.mjs（2026-10-24）
// 附件文件的可读范围（api 12）：登记过的附件在 ~/.dsh/tmp、页面目录、项目目录之外时，挂它的会话在会话日志里读写过的 git 仓库也算可读；
// 密钥类文件名、没登记的文件、仓库外的文件仍然拒绝；出错回 {ok:false, code, message, hint}。另测 Markdown 里引用的图片（doc=）和 /lib 两个排版库。
// 页面上引用的图片（2026-11-01，D:\games 下的截图在家里电脑和手机上都打不开）：扩展名和文件头都是 PNG / JPG / GIF / WebP 的不看目录，其余规则不变。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'align-doc-')));
process.env.DSH_HOME = path.join(tmp, 'home');
process.env.ALIGN_STORE = path.join(tmp, 'store');
process.env.ALIGN_WORKSPACES = path.join(tmp, 'workspace.json');
fs.mkdirSync(process.env.ALIGN_STORE, { recursive: true });
const A = await import('./align.mjs');

const mk = (p, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
// 两个 git 仓库（只要有 .git 目录）和一个不在仓库里的目录，都不在页面目录 / 项目目录里
const used = path.join(tmp, 'repos', 'used-repo'), other = path.join(tmp, 'repos', 'other-repo'), loose = path.join(tmp, 'loose');
for (const r of [used, other]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
const doc = mk(path.join(used, 'docs', 'report.md'), '# 报告\n\n![图](img/fig.png)\n\n![外面](../../other-repo/pic.png)\n\n![仓库外的真图片](../../../loose/shots/shot.png)\n');
const fig = mk(path.join(used, 'docs', 'img', 'fig.png'), 'png');
const stray = mk(path.join(used, 'docs', 'img', 'stray.png'), 'png');
const unlisted = mk(path.join(used, 'notes.md'), '没登记');
const secret = mk(path.join(used, '.env'), 'KEY=1');
const token = mk(path.join(used, 'api-token.txt'), 'tok');
const exe = mk(path.join(used, 'tool.exe'), 'MZ');
const gone = mk(path.join(used, 'gone.md'), '会被删掉');
const log = mk(path.join(used, 'run.log'), 'line');
const otherDoc = mk(path.join(other, 'README.md'), '别的仓库');
mk(path.join(other, 'pic.png'), 'png');
const looseDoc = mk(path.join(loose, 'free.md'), '不在仓库里');
const viaDec = mk(path.join(other, 'by-decision.md'), '决定挂的');
// 不在可读目录、不在任何 git 仓库里；文件头是真的
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const pagePng = mk(path.join(loose, 'shots', 'shot.png'), PNG);
const pageUpper = mk(path.join(loose, 'shots', 'SHOT2.PNG'), PNG);
const pageJpg = mk(path.join(loose, 'shots', 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
const pageGif = mk(path.join(loose, 'shots', 'anim.gif'), 'GIF89a......');
const pageWebp = mk(path.join(loose, 'shots', 'pic.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]));
const linkedPng = mk(path.join(loose, 'shots', 'linked.png'), PNG);
const wrongExt = mk(path.join(loose, 'shots', 'really-a-jpeg.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
const unlistedPng = mk(path.join(loose, 'shots', 'unlisted.png'), PNG);
const fakePng = mk(path.join(loose, 'shots', 'notes-really.png'), '这是文本，不是图片');
const pngAsText = mk(path.join(loose, 'shots', 'data.txt'), PNG);
const pageSvg = mk(path.join(loose, 'shots', 'icon.svg'), '<svg/>');
const secretPng = mk(path.join(loose, 'shots', 'api-token.png'), PNG);
const dirPng = path.join(loose, 'shots', 'folder.png');
fs.mkdirSync(dirPng);
const emptyPng = mk(path.join(loose, 'shots', 'empty.png'), '');
// HTML 附件（2026-11-02，对照页 compare.html 在对齐页上只显示源码）：它引用的图片、样式表、样式表里的图片
const htmlDoc = mk(path.join(used, 'docs', 'compare.html'), [
  "<!doctype html><link rel=stylesheet href='css/site.css'><link rel=stylesheet href=\"../../other-repo/far.css\">",
  "<style>.a{background:url( 'img/bg.png' )} .b{background:url(img/q.png?v=2#x)}</style>",
  "<img src='img/h01.png'><img src=\"img/stray-ref%20sp.png\"><img src=../../../loose/shots/shot.png>",
  '<script src="app.js"></script><a href="notes.txt">n</a><a href="https://example.com/x.png">ext</a>',
  // 注释、脚本字符串、textarea 里写的地址不算引用；字符引用按浏览器还原
  '<!-- <link rel=stylesheet href="css/private.css"> <img src="img/in-comment.png"> -->',
  '<script>var s = \'<img src="img/in-script.png">\';</script><textarea><img src="img/in-textarea.png"></textarea>',
  '<style>/* url(img/in-css-comment.png) */</style><a href="img/linked-only.png">链接不算</a>',
  '<img src="img/ent&#32;sp.png"><img src="img/hex&#x20;sp.png"><img src="img/mix&#32;a%20b.png">',
  // 复核给的输入：嵌套 template、属性值里的 <style>、C1 区的字符引用（浏览器还原成 €）
  '<template><template></template><img src="img/in-tpl.png"></template>',
  '<div title="<style>">url(img/in-attr.png)</div>',
  '<img src="img/c1&#128;.png"><img src="img/c1x&#x80;.png"><img src="img/amp&ampx.png"><img src="img/unk&copy;.png">',
  '<style>.q{content:"url(img/in-css-string.png)"} .r{background:xurl(img/in-xurl.png)}</style><img src="//server/share/x.png">',
  '<!--> <img src="img/after-short-comment.png"> <script><!--<script></script><img src="img/in-double-escaped.png"></script>',
].join('\n'));
const inTpl = mk(path.join(used, 'docs', 'img', 'in-tpl.png'), 'png');
const inAttr = mk(path.join(used, 'docs', 'img', 'in-attr.png'), 'png');
const c1Raw = mk(path.join(used, 'docs', 'img', 'c1\u0080.png'), 'png');
const c1Euro = mk(path.join(used, 'docs', 'img', 'c1\u20ac.png'), 'png');
const c1xRaw = mk(path.join(used, 'docs', 'img', 'c1x\u0080.png'), 'png');
const inCssString = mk(path.join(used, 'docs', 'img', 'in-css-string.png'), 'png');
const inXurl = mk(path.join(used, 'docs', 'img', 'in-xurl.png'), 'png');
const afterShort = mk(path.join(used, 'docs', 'img', 'after-short-comment.png'), 'png');
const inDouble = mk(path.join(used, 'docs', 'img', 'in-double-escaped.png'), 'png');
const inComment = mk(path.join(used, 'docs', 'img', 'in-comment.png'), 'png');
const privCss = mk(path.join(used, 'docs', 'css', 'private.css'), 'x{}');
const inScript = mk(path.join(used, 'docs', 'img', 'in-script.png'), 'png');
const inTextarea = mk(path.join(used, 'docs', 'img', 'in-textarea.png'), 'png');
const inCssComment = mk(path.join(used, 'docs', 'img', 'in-css-comment.png'), 'png');
const linkedOnly = mk(path.join(used, 'docs', 'img', 'linked-only.png'), 'png');
const entSp = mk(path.join(used, 'docs', 'img', 'ent sp.png'), 'png');
const hexSp = mk(path.join(used, 'docs', 'img', 'hex sp.png'), 'png');
const mixSp = mk(path.join(used, 'docs', 'img', 'mix a b.png'), 'png');
const htmlImg = mk(path.join(used, 'docs', 'img', 'h01.png'), 'png');
const htmlBg = mk(path.join(used, 'docs', 'img', 'bg.png'), 'png');
const htmlQ = mk(path.join(used, 'docs', 'img', 'q.png'), 'png');
const htmlSp = mk(path.join(used, 'docs', 'img', 'stray-ref sp.png'), 'png');
const htmlCss = mk(path.join(used, 'docs', 'css', 'site.css'), 'body{background:url("../img/from-css.png")}');
const cssImg = mk(path.join(used, 'docs', 'img', 'from-css.png'), 'png');
const unrefCss = mk(path.join(used, 'docs', 'css', 'unused.css'), 'x{}');
const htmlJs = mk(path.join(used, 'docs', 'app.js'), 'alert(1)');
const htmlTxt = mk(path.join(used, 'docs', 'notes.txt'), 'n');
const farCss = mk(path.join(other, 'far.css'), 'body{background:url("pic.png")}');

// 会话日志：sw 直接调 read 读过 used 仓库；sd 在 run_code 里用 pwsh workdir 进过 other 仓库；sn 什么都没碰
const writeLog = (sid, lines) => mk(path.join(process.env.DSH_HOME, 'sessions', '--proj--', sid, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')));
writeLog('session-sw', [{ type: 'session', version: 4, id: 'session-sw', cwd: path.join(tmp, 'elsewhere') },
  { type: 'tool/call', data: { name: 'read', arguments: JSON.stringify({ file_path: path.join(used, 'docs', 'report.md') }) } }]);
writeLog('session-sd', [{ type: 'session', version: 4, id: 'session-sd', cwd: path.join(tmp, 'elsewhere') },
  { type: 'tool/ptc-dispatch', data: { name: 'pwsh', arguments: { description: 'ls', command: 'ls', workdir: other } } }]);
writeLog('session-sn', [{ type: 'session', version: 4, id: 'session-sn', cwd: path.join(tmp, 'elsewhere') }]);

const T0 = '2026-10-24T10:00:00+08:00';
const link = (...ps) => ps.map((href) => ({ href, title: path.basename(href) }));
const data = {
  version: 3, name: 'doc', title: '附件', owner: 'session-fm', updated: T0, projects: [],
  rounds: [
    { id: 'r1', sid: 'session-sw', title: '用过 used 仓库', status: 'doing', mode: 'new', started: T0, updated: T0, state: '进行中', link: link(doc, secret, token, exe, gone, log, otherDoc, looseDoc, htmlDoc) },
    { id: 'r2', sid: 'session-sd', title: '用过 other 仓库', status: 'doing', mode: 'new', started: T0, updated: T0, state: '进行中' },
    { id: 'r3', sid: 'session-sn', title: '什么都没用过', status: 'doing', mode: 'new', started: T0, updated: T0, state: '进行中', handoff: fig,
      img: [pagePng, pageUpper, pageJpg, pageGif, pageWebp, wrongExt, fakePng, pngAsText, pageSvg, secretPng, dirPng, emptyPng].map((src) => ({ src, cap: path.basename(src) })), link: link(linkedPng) },
  ],
  decisions: [{ id: 'd1', round: 'r2', title: '挂在 r2 下', status: 'done', why: 'w', opt: [{ label: '甲', effect: 'a' }, { label: '乙', effect: 'b' }], updated: T0, link: link(viaDec) }],
  notes: [],
};
const page = path.join(tmp, 'pages', 'doc.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, A.render(data));
fs.writeFileSync(path.join(process.env.ALIGN_STORE, 'pages.json'), JSON.stringify({ doc: page }));
fs.rmSync(gone);

const denied = (ref, code, re, via) => {
  let err;
  try { A.attachmentFile('doc', ref, via); } catch (e) { err = e; }
  assert.ok(err instanceof A.PageError, ref + ' 应被拒绝');
  assert.equal(err.code, code, ref);
  if (re) assert.match(err.message, re, ref);
  assert.ok(err.hint, ref + ' 要带下一步');
  return err;
};

test('放行：挂它的会话读写过的 git 仓库里的附件（直接调用 / run_code 里的 workdir / 决定取所挂轮次的会话）', () => {
  assert.equal(A.attachmentFile('doc', doc).body.toString(), fs.readFileSync(doc, 'utf8'));
  assert.equal(A.attachmentFile('doc', doc).type, 'text/plain; charset=utf-8');
  assert.equal(A.attachmentFile('doc', log).body.toString(), 'line', '同一仓库里别的登记文件也行');
  assert.equal(A.attachmentFile('doc', viaDec).body.toString(), '决定挂的', 'd1 挂在 r2 下，r2 的会话用过 other 仓库');
  assert.ok(A.sessionPaths('session-sd').includes(A.normPath(other)));
});

test('拒绝：密钥类文件名、没登记的、别的会话的仓库、不在仓库里、类型不支持、文件不在了', () => {
  denied(secret, 'secret-like', /密钥/);
  denied(token, 'secret-like', /密钥/);
  denied(unlisted, 'not-attached', /没有挂在这一页上/);
  denied(otherDoc, 'outside-roots', /other-repo 仓库里.*没权限读/); // r1 的会话没用过 other 仓库（d1 不挂这个文件）
  denied(looseDoc, 'outside-roots', /不在项目目录或 git 仓库里/);
  denied(fig, 'outside-roots', /used-repo 仓库里/); // r3 的 handoff：r3 的会话什么都没碰过
  denied(exe, 'type-not-served', /\.exe/);
  denied(gone, 'file-missing', /不在了/);
});

test('文档里的图片：只给这份文档引用的、在文档所在仓库里的图片', () => {
  assert.equal(A.attachmentFile('doc', fig, doc).type, 'image/png', '相对路径解析到文档目录');
  assert.equal(A.attachmentFile('doc', pagePng, doc).type, 'image/png', '文档引用的真图片，不在文档所在仓库里也给');
  denied(stray, 'not-attached', /不在这份文档里/, doc);
  denied(path.join(other, 'pic.png'), 'outside-roots', /仓库里/, doc);
  denied(fig, 'not-attached', null, unlisted); // 文档本身没登记
  assert.throws(() => A.attachmentFile('doc', fig, log), (e) => e.code === 'bad-path');
});

test('HTML 附件里的文件：只给它引用的图片和样式表（及样式表里的图片），按文档所在仓库限定', () => {
  assert.equal(A.attachmentFile('doc', htmlDoc).type, 'text/plain; charset=utf-8', 'HTML 本身仍按文字给，不在对齐页的源上当网页执行');
  for (const [p, type] of [[htmlImg, 'image/png'], [htmlBg, 'image/png'], [htmlQ, 'image/png'], [htmlSp, 'image/png'], [pagePng, 'image/png'], [htmlCss, 'text/css; charset=utf-8'], [cssImg, 'image/png']]) {
    const f = A.attachmentFile('doc', p, htmlDoc);
    assert.equal(f.type, type, p);
    assert.deepEqual(f.body, fs.readFileSync(p), p);
  }
  for (const p of [entSp, hexSp, mixSp]) assert.equal(A.attachmentFile('doc', p, htmlDoc).type, 'image/png', '字符引用按浏览器还原：' + p);
  for (const p of [inComment, privCss, inScript, inTextarea, inCssComment, linkedOnly]) denied(p, 'not-attached', /不在这份文档里/, htmlDoc); // 只在注释 / 脚本 / 链接里出现
  // 浏览器不加载的（template 里、属性值里、CSS 字符串里、别的 CSS 函数、脚本里的 <!--<script> 段），和字符引用还原不准的（C1、不认识的名字）：都不放行
  for (const p of [inTpl, inAttr, inCssString, inXurl, inDouble, c1Raw, c1Euro, c1xRaw]) denied(p, 'not-attached', /不在这份文档里/, htmlDoc);
  assert.equal(A.attachmentFile('doc', afterShort, htmlDoc).type, 'image/png', '<!--> 是一个已经结束的注释，后面的图照常算');
  // 分词本身：和浏览器对得上的几个写法
  const r = (h) => A.htmlRefs(h).refs;
  assert.deepEqual(r('<IMG SRC=a.png><img src = "b.png"><img/src=c.png><img src=d.png src=e.png>'), ['a.png', 'b.png', 'c.png', 'd.png']);
  assert.deepEqual(r('<link rel="icon stylesheet" href=s.css><link rel=preload href=p.css><link href=n.css>'), ['s.css']);
  assert.deepEqual(r('<img src="a.png"<img src=b.png>'), ['a.png']);
  assert.deepEqual(r('<img src="unterminated.png'), []);
  assert.deepEqual(r('<p style="background:url(&quot;q.png&quot;)">'), ['q.png']);
  assert.deepEqual(A.cssRefs('a{b:url( x.png )} c{d:url("y.png")} e{f:url(z\\.png)} g{h:url(a b.png)}'), ['x.png', 'y.png']);
  denied(stray, 'not-attached', /不在这份文档里/, htmlDoc); // 同目录、同仓库，但网页没引用
  denied(unrefCss, 'not-attached', /样式表不在这份文档里/, htmlDoc);
  denied(htmlJs, 'type-not-served', /不是图片或样式表/, htmlDoc); // 脚本不给
  denied(htmlTxt, 'type-not-served', null, htmlDoc);
  denied(farCss, 'outside-roots', /样式表不在文档所在的仓库里/, htmlDoc);
  denied(path.join(other, 'pic.png'), 'not-attached', null, htmlDoc); // 只在仓库外的样式表里提到，不算
  denied(secret, 'type-not-served', null, htmlDoc);
  denied(htmlImg, 'not-attached', null, unlisted); // 文档本身没登记
  assert.throws(() => A.attachmentFile('doc', htmlImg, log), (e) => e.code === 'bad-path');
  denied(htmlCss, 'type-not-served', /不是图片格式/, doc); // Markdown 文档仍只给图片
});

test('页面上引用的图片：不看目录，会话没碰过、不在仓库里也给；类型按扩展名', () => {
  for (const [p, type] of [[pagePng, 'image/png'], [pageUpper, 'image/png'], [pageJpg, 'image/jpeg'], [pageGif, 'image/gif'], [pageWebp, 'image/webp'], [linkedPng, 'image/png'], [wrongExt, 'image/png']]) {
    const f = A.attachmentFile('doc', p);
    assert.equal(f.type, type, p);
    assert.deepEqual(f.body, fs.readFileSync(p), p);
  }
});

test('放宽只到真图片：没挂的、内容不是图片的、SVG、文本扩展名、密钥名、文件夹、空文件都不给', () => {
  denied(unlistedPng, 'not-attached', /没有挂在这一页上/);
  denied(fakePng, 'outside-roots', /不在项目目录或 git 仓库里/); // 扩展名是 .png，内容是文本
  denied(pngAsText, 'outside-roots', /不在项目目录或 git 仓库里/); // 文件头是 PNG，按 text/plain 给就成了任意读文件
  denied(pageSvg, 'outside-roots', /不在项目目录或 git 仓库里/); // SVG 是文本，认不出是不是图片
  denied(secretPng, 'secret-like', /密钥/);
  denied(dirPng, 'outside-roots');
  denied(emptyPng, 'outside-roots');
  denied(path.join(tmp, 'never-existed.png'), 'not-attached');
});

test('HTTP：出错回 code / message / hint；/lib 只给两个排版库', async () => {
  const h = A.createHandler({ prefix: '', send: async () => {}, guard: () => null, live: null });
  const call = (url) => new Promise((ok) => {
    const res = { code: 0, headers: {}, body: '', writeHead(c, hd) { this.code = c; this.headers = hd; }, end(b) { this.body = String(b ?? ''); ok(this); } };
    h({ method: 'GET', url, headers: {} }, res);
  });
  const bad = await call('/p/doc/file?path=' + encodeURIComponent(secret));
  assert.equal(bad.code, 403);
  const j = JSON.parse(bad.body);
  assert.equal(j.ok, false); assert.equal(j.code, 'secret-like'); assert.match(j.message, /密钥/); assert.ok(j.hint);
  const img = await call('/p/doc/file?path=' + encodeURIComponent(fig) + '&doc=' + encodeURIComponent(doc));
  assert.equal(img.code, 200); assert.equal(img.headers['content-type'], 'image/png');
  const shot = await call('/p/doc/file?path=' + encodeURIComponent(pagePng));
  assert.equal(shot.code, 200, '页面上引用的图片经 /file 能取到');
  assert.equal(shot.headers['content-type'], 'image/png');
  const lib = await call('/lib/marked.js');
  assert.equal(lib.code, 200); assert.match(lib.headers['content-type'], /javascript/); assert.match(lib.body, /marked/);
  assert.equal((await call('/lib/purify.js')).code, 200);
  assert.equal((await call('/lib/evil.js')).code, 404);
  assert.equal((await call('/lib/..%2Falign.mjs')).code, 404);
});
