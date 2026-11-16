// phone-file.test.mjs：手机读附件 bridge.file(page, path)（手机接口版本 7，tmp/mobile-align-v8/impl/file-contract.md）。
// node --test plugins/dsh-alignment/test/phone-file.test.mjs（经 dsh-verify 8pl 收集）
// 可读规则是 align.mjs attachmentFile（网页 /file 同一套）；手机另外只给四种图片、原始字节 <= FILE_MAX；错误是 PageError，code 原样。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "align-phone-file-")));
process.env.DSH_HOME = path.join(tmp, "home");
process.env.ALIGN_STORE = path.join(tmp, "store");
process.env.ALIGN_WORKSPACES = path.join(tmp, "workspace.json");
fs.mkdirSync(process.env.ALIGN_STORE, { recursive: true });
const A = await import("../cli/align.mjs");
const { createPhoneBridge, PHONE_API, PHONE_FILE_MAX, PHONE_FILE_TYPES } = await import("../index.js");

// 项目目录 proj 是可读目录（fileRoots），文件都放在里面，只看手机这层的类型 / 大小 / 登记规则
const proj = path.join(tmp, "proj");
const mk = (name, body) => { const p = path.join(proj, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
const png = mk("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
const jpg = mk("a/photo.JPG", Buffer.from("jpeg-bytes"));
const gif = mk("anim.gif", Buffer.from("GIF89a"));
const webp = mk("pic.webp", Buffer.from("RIFFwebp"));
const svg = mk("icon.svg", "<svg/>");
const txt = mk("notes.md", "# 文本");
const secret = mk("api-token.png", Buffer.from("png"));
const big = mk("big.png", Buffer.alloc(8 * 1024 * 1024 + 1, 7));
const edge = mk("edge.png", Buffer.alloc(8 * 1024 * 1024, 3));
const gone = mk("gone.png", Buffer.from("x"));
const unlisted = mk("unlisted.png", Buffer.from("x"));
// 不在项目目录、不在 git 仓库里的截图（2026-11-01：D:\games 下的截图手机上打不开）
const outside = path.join(tmp, "elsewhere", "shot.png");
fs.mkdirSync(path.dirname(outside), { recursive: true });
fs.writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
const T0 = "2026-10-24T10:00:00+08:00";
const img = (...ps) => ps.map((src) => ({ src, cap: path.basename(src) }));
const data = {
  version: 3, name: "pf", title: "手机附件", owner: "session-fm", updated: T0, projects: [{ id: "p1", title: "项目", cwd: proj }],
  rounds: [{ id: "r1", proj: "p1", sid: "session-a", title: "截图", status: "doing", mode: "new", started: T0, updated: T0, state: "进行中",
    img: img(png, jpg, gif, webp, svg, secret, big, edge, gone, outside), link: [{ href: txt, title: "说明" }] }],
  decisions: [], notes: [],
};
const pageFile = path.join(tmp, "pages", "pf.html");
fs.mkdirSync(path.dirname(pageFile), { recursive: true });
fs.writeFileSync(pageFile, A.render(data));
fs.writeFileSync(path.join(process.env.ALIGN_STORE, "pages.json"), JSON.stringify({ pf: pageFile }));
fs.rmSync(gone);

const bridge = createPhoneBridge(async () => {}, () => [], async () => ({}));
const denied = (p, code, page = "pf") => assert.throws(() => bridge.file(page, p), (e) => {
  assert.equal(e.code, code, p + " → " + e.code + " " + e.message);
  assert.ok(typeof e.message === "string" && /[\u4e00-\u9fff]/.test(e.message), "message 是中文");
  return true;
});

test("手机接口版本 10（file 自 7 起）；FILE_MAX = 8 MiB，四种图片", () => {
  assert.equal(PHONE_API, 10);
  assert.equal(bridge.api, 10);
  assert.equal(PHONE_FILE_MAX, 8 * 1024 * 1024);
  assert.deepEqual([...PHONE_FILE_TYPES].sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
});

test("放行：登记过的四种图片，返回 {type, size, data(base64)}，字节和网页 /file 相同", () => {
  for (const [p, type] of [[png, "image/png"], [jpg, "image/jpeg"], [gif, "image/gif"], [webp, "image/webp"]]) {
    const r = bridge.file("pf", p);
    assert.deepEqual(Object.keys(r).sort(), ["data", "size", "type"]);
    assert.equal(r.type, type);
    const bytes = fs.readFileSync(p);
    assert.equal(r.size, bytes.length);
    assert.deepEqual(Buffer.from(r.data, "base64"), bytes);
    assert.deepEqual(Buffer.from(r.data, "base64"), A.attachmentFile("pf", p).body, "和网页 /file 同一份字节");
  }
  assert.equal(bridge.file("pf", edge).size, 8 * 1024 * 1024, "正好 8 MiB 放行");
});

test("放行：页面上引用的真图片，不在项目目录里也给（和网页 /file 同一条规则）", () => {
  const r = bridge.file("pf", outside);
  assert.equal(r.type, "image/png");
  assert.deepEqual(Buffer.from(r.data, "base64"), fs.readFileSync(outside));
});

test("拒绝：未登记 / 密钥名 / svg / 文本 / 过大 / 文件不在 / 相对路径 / 页面不在 / 参数不是字符串", () => {
  denied(unlisted, "not-attached");
  denied(secret, "secret-like");
  denied(svg, "type-not-served");
  denied(txt, "type-not-served");
  denied(big, "too-large");
  denied(gone, "file-missing");
  denied("shot.png", "bad-path");
  denied(png, "page-not-found", "nope");
  assert.throws(() => bridge.file(1, png), (e) => e.code === "bad-request");
  assert.throws(() => bridge.file("pf", ""), (e) => e.code === "bad-request");
});
