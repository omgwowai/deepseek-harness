#!/usr/bin/env node
// align.mjs — 对齐页 CLI + 本机服务。agent 一律通过它改对齐页，不手动 edit 页面文件。
// 数据有两个版本：版本 2（平铺 items，用 template-v2.html）与版本 3（项目 → 轮次，用 template.html）。
// 本文件就是 CLI 本身：node <本文件> <命令>…（想做成全局命令 align，可加一个指向它的 shim 或 alias）。
// 发给会话的消息和提示里一律写 align …，下面的 node align.mjs … 与之等价。
//
// 通用（两个版本都可用）
//   node align.mjs help [<命令> [<子命令>]]           打印用法（本段注释）；任何命令后加 --help / -h 同样只打印这条命令的用法、不做事
//   node align.mjs init <file.html> --name <slug> --title <标题> [--owner <会话id>] [--proj <默认项目>] [--version 3]
//   node align.mjs del  <页> <id>
//   node align.mjs meta <页> k=v ...                 页面字段: title | next | owner（版本 2 另有 proj）
//   node align.mjs ls   <页> [区块] [--proj <项目>] [k=v ...]   每条一行；版本 3 区块: round | decide | note | project（旧名 doing | done 也认）
//     版本 3 不带区块时最后列出没答完的顺便问（btw/<id>）：挂在哪一轮、转没转给会话、多久前问的；--proj / --sid 看所挂轮次
//   node align.mjs open <页>                          在 DSH 侧栏打开（3080 插件 api >= 页面数据版本时用 3080 的 /alignment 路由，否则 3390 本机服务）
//   node align.mjs url  <页>                          打印同一个地址
//   node align.mjs forget <登记名>                   注销登记（不删页面文件）
//   node align.mjs refresh <页>                      模板升级后按新模板重新生成，数据不变
//   node align.mjs serve [--port 3390] [--dsh-url http://127.0.0.1:3080]
//   node align.mjs migrate <页> [--dry-run] [--force]  版本 2 → 3；非预演时先确认 3080 的 /alignment/health api >= 3（--force 跳过）
//   node align.mjs log   <页> [--since 1d] [--until …] [--type decide.pick,round] [--id <条目>] [--src local|remote|local-3390|app] [--limit 100] [--json]
//                                                    使用日志原始事件，一行一条（--type 可写前缀：decide = decide.*）；--json 给 agent
//   node align.mjs usage <页> [--since 7d] [--until …] [--src …] [--json]   使用摘要：每天时长、区块打开次数、看到→作答中位时长、改主意、常用 / 没用过、来源、报错、慢请求
//     日志在 <ALIGN_STORE>/usage/YYYY-MM-DD.jsonl（今天、昨天明文，更早的 .jsonl.gz，90 天后删），事件含义见 usage.mjs CATALOG
//     坏行（断电留下的 NUL 段等）不中断：去掉 NUL 读得出的照常算，读不出的跳过，两种都在 stderr 列出文件和行号
//
// 版本 2 命令（在版本 3 页面上映射到 round / decide / note）
//   node align.mjs add  <页> <区块> <id> k=v ...     区块: decide | doing | done | note
//   node align.mjs set  <页> <id> k=v ...            k= (空值) 删掉该字段; opt= 可重复, 给了就整组替换
//   node align.mjs done <页> <id> [result=...]        进行中/需要你决定 → 最近完成
//
// 版本 3 命令（版本 2 页面上报错：先 migrate）
//   node align.mjs project add <页> (--cwd <目录> | --ws <workspace id>)
//   node align.mjs project ls  <页>
//   node align.mjs round add  <页> <id> --mode continue|new [--prev <round id>] [--handoff <文件或链接>] [--proj <项目>] [--todo <待办 id>]
//                               title=… sid=… why=… eta=… eta75=… etaconf=高|中|低 [etaadj=… etanote=…] [stitle=…] [state=…] [next=…]
//                               eta / eta75 / etaadj 是时长（40m、1h15m、2h）：中位数 / P75 / First Mate 修正后的预计；etanote 写修正理由
//   node align.mjs round set  <页> <id> k=v… [--mode …] [--handoff …] [--proj …]   status=doing|paused|done|accepted|dropped（暂缓 / 通过 / 放弃；waiting 已取消，问用户用不带 opt 的 decide add）
//     用户点了「修改」（ask=revise）的轮次不能改回 doing：返工用 dispatch <页> <id>-2 --prev <id> --mode continue 登记一轮续发（报错里给整条命令，id 已被占用就顺延）
//   node align.mjs round done <页> <id> visual=true|false [result=…] [img=…]   交了结果 → done（页面「完成」栏，等用户验收）
//     visual 必填：这一轮交付的是不是视觉类（界面、页面、动效、设计稿这类要看截图验收的）。true 时这一轮要挂着至少一张 img
//     （之前 round set 挂的也算，或同一条命令里带 img=<路径>::说明），页面待验收详情把截图放在正文最上面；false 不写进页面，显示同以前。
//     round set status=done 同样要带 visual=；round add --prev 自动收尾的上一轮不要。写 visual=true 前先探测 3080 的
//     /alignment/health api >= 13（旧插件代码不认识 visual，页面会整页读不出来），不够就报错、不写
//   node align.mjs round accept <页> <id> [result=…]     用户在页面上点了「通过」：只接 done → accepted（「已结束」栏）；prev 链上仍是 done 的前序轮次一起改 accepted（dropped / paused 不动）
//   node align.mjs round accept <页> --before <ISO> [--dry-run]   迁移用：ended（没有就按 updated）早于该时刻的 done 全部改 accepted
//     进入 done / accepted / dropped 时写 ended（三者之间互换不改），改回 doing / waiting / paused 时删掉；CLI 改 status 时清掉页面发来的 ask / asknote / asked
//     进入 paused 时在 pauses 追加 {from}，离开 paused 时补 to（api 15；已用不算暂缓时段，见 checkPauses）；3080 还是旧插件时不记，输出里说明怎么补
//     round add --prev / round done 成功后，逐行列出这一轮及前序轮次（prev 链）上仍 open/sent 的决定和处理命令
//   node align.mjs decide add  <页> <id> title=… why=… opt=选项::后果[::once|project|always] opt=… risk=高|中|低 cat=花钱|不可逆|对外发消息|线上配置|方向取舍|其他
//                               [rec=…] [ifnone=…] [like=<「同类」一句话>] [timeout=8h] [sid=…] [--round <round id>] [--proj <项目>]
//     open 的决定必须带 risk + cat（不可逆 / 对外发消息 / 线上配置不能是低风险，花钱要在 why 里写金额）；有 project / always 作用范围要写 like
//     进入 open 时 CLI 写 opened，due = opened + timeout（缺省 8h），改 timeout 重算；到点由 3080 插件处理（index.js timeouts / timeouts.js）
//   数字卡（v8，decide / round 的 add 和 set 都可带）：kpi=标签::数值[::对比值]，可重复、最多 4 个，正文顶部按它画数字卡（不填就从正文里自动挑）；kpi= 清空
//   没有选项的决定（开放问题，v8）：decide add 不写 opt=，用户在页面上直接写回复；不能写 rec
//   node align.mjs rule ls <页>                       长期规则：scope=always 的已处理决定（没撤销的）
//   node align.mjs rule revoke <页> <id>              撤销长期规则（先从 First Mate AGENTS.md 删掉，再跑它）
//   node align.mjs meta <页> timeoutHigh=remind|auto   高风险决定超时后只提醒（缺省）/ 也按推荐自动处理
//   node align.mjs meta <页> projOrder=<id>,<id>…      项目顺序（页面「已完成」栏拖动时由页面写入；未归属写空串）；projOrder= 恢复默认顺序
//   node align.mjs decide add  <页> <id> --pending --round <round id> title=… [why=…] [opt=…]   等信息的决定（不进决定栏，why/opt 可缺）
//                               提升到决定栏：decide set <页> <id> why=… opt=… opt=… status=open（此时校验 why + ≥2 个 opt）
//   node align.mjs decide set  <页> <id> k=v… [--round …] [--proj …]
//   node align.mjs decide done <页> <id> [choice=…] [result=…] [scope=project|always like=…]
//   node align.mjs note add <页> <id> title=… [body=…] [level=info|warn] [--proj …]
//   node align.mjs note set <页> <id> k=v… [--proj …]       acked= 清掉页面上的「已了解」（acked 只由页面写入）
//   node align.mjs note del <页> <id>
//   今日推荐（早报第 4.5 步写入，存成须知 rec-YYYYMMDD-N；页面「决定」页签里另成一组，每条选「派出去做」或「不做」，和决定一起发送）
//   node align.mjs rec set <页> --file <推荐.json> [--date YYYY-MM-DD]   删掉所有旧推荐再加新的；JSON = [{title, why, src?}]，1–5 条
//   node align.mjs rec ls <页>                     已处理（用户选了不做或派出去做）/ 没处理
//   node align.mjs rec clear <页>                  删掉所有推荐
//     不做：只把须知标成已了解，不发消息；派出去做：同时把派活说明作为留言发给 First Mate（末尾是 note del 命令）。不超时、不计入决定数
//   node align.mjs rec take <页> <rec id> [p=… urg=… energy=… eta=… due=… goal=…]   我来做：这条推荐变成放进今天的待办（src=推荐，推荐理由写进 why），推荐标成已处理（api 17）
//   你的待办和目标（api 17，2026-11-02 从 personal-ops 迁来；页面数据顶层 todos / goals，字段见「你的待办和目标」一节的注释）。页面上还没有待办和目标时，写之前先探测 3080 api >= 17
//   node align.mjs todo add <页> 'title=…' [p=P0|P1|P2|P3 urg=紧急|正常|不急 energy=高|中|低 eta=45m due=YYYY-MM-DD goal=<目标 id>[,…] why=… src=手记|推荐|First Mate|导入] [--today]
//   node align.mjs todo set <页> <id> k=v…        同上字段，k= 删掉；status=open|doing|dropped（待办 / 在做 / 放弃；完成用 todo done，派出用 todo dispatch）
//   node align.mjs todo done <页> <id> [note=…]    完成；输出里列出在等它的轮次（通知那个会话后 round set <页> <轮次> wait= 解除）
//   node align.mjs todo today <页> <id> [<id>…] [--off]   放进「今天」/ --off 移出。「今天」一直留到完成或手动移出，跨天不清（2026-11-02 用户定）
//   node align.mjs todo ls <页> [--all] [--goal <目标 id>] [--json]   按 今天 / 以后 / 已派出 分组（--all 加 已完成 / 已放弃），每条一行
//   node align.mjs todo dispatch <页> <待办 id> <轮次 id> --prompt-file <文件> --mode new|continue [其余同 dispatch；title= 缺省取待办标题]
//     把待办派成会话的一轮（= dispatch … --todo <待办 id>；round add 也收 --todo）：待办改 sent、记下轮次；那一轮 round accept 时待办自动完成，
//     放弃（dropped）时回到待办（2026-11-02 用户定）；round add --prev 接着做时跟到新一轮
//   node align.mjs goal add <页> 'title=…' [range=长期|季度|月度|本周 metric=… unit=… base=0 cur=… target=… due=YYYY-MM-DD why=… projs=<项目>[,…]]
//   node align.mjs goal set <页> <id> k=v…        同上字段，k= 删掉；status=doing|dropped（进行中 / 放弃）
//   node align.mjs goal done <页> <id> [note=…]    达成
//   node align.mjs goal progress <页> <id> cur=<数> [note=…] [--kr <k1>]   记进度：改目标（或某条关键结果）的当前值，在目标的 log 记一条
//   node align.mjs goal kr <页> <id> add 'title=…' [cur=… target=…] | set <k1> [title=… cur=… target=… done=true|false] | del <k1>   关键结果（目标里的列表，最多 10 条）
//   node align.mjs goal ls <页> [--all] [--json]   进行中的目标（--all 含达成 / 放弃），每条带进度、关键结果、待办数、轮次数
//   node align.mjs day <页> [--date YYYY-MM-DD] [--json]   一天的轮次和做完的待办（缺省今天，收工 worklog 用）：完成（当天交了结果）/ 新开 /
//     之前开、当天有更新 / 放弃的轮次，当天完成的待办；只读。「之前开、当天有更新」按现在的状态算，查过去的日子只作参考
//   node align.mjs import-po <页> [--dir <personal-ops 数据目录>] [--open-only] [--write]   从 personal-ops 导入任务和目标：默认只预演（只读 tasks / goals / progress.json，
//     逐条列出怎么导）；--write 才写进页面（页面已有导入过的待办就拒绝）。日程块和 rules.json 不导；--open-only 只导没完成的任务
//   轮次挂目标 / 等待办：round add / round set / dispatch 写 goal=<目标 id>（这一轮属于哪个目标）、wait=<待办 id>（这一轮在等用户做完这条待办，页面写「N 个会话在等」）
//   node align.mjs link  <页> [--dry-run]           没挂轮次的 open/sent 决定按 sid / src（会话标题或轮次标题）补挂到轮次（migrate 末尾也跑）
//   node align.mjs stale <页> [--since-user <sid>=<ISO>[,…]] [--idle <sid>[,…]]   列出过时的 open/sent 决定（轮次已完成 / 之后有新一轮 / 会话收到过用户直接消息）；
//     --idle：这些会话已空闲，另列出它们上面 status=doing、无 fault、无 open/pending 决定的轮次（行首「已停没有下一步」，带三条处理命令）
//   附件（round / decide / note 的 add / set 都可用，可重复）：img=<路径或链接>[::说明]  link=<路径、链接或会话 id>[::标题]
//     img=-<路径或链接> 删掉那一项，img= 清空；本地路径必须是已有文件。页面经 /p/<页>/file 只读提供：只限登记过的附件（img / link / 轮次 handoff），
//     且在 ~/.dsh/tmp、页面所在目录、页面项目目录里，或在挂它的会话读写过的 git 仓库里，或本身是真图片（PNG / JPG / GIF / WebP，扩展名是图片、文件头也认得出；见 attachmentFile）；
//     其他的页面上说明原因、给复制路径。Markdown / HTML 附件里引用的图片（HTML 另加样式表）经 /file?path=…&doc=<那份文档> 给，规则见 docImage；
//     HTML 附件在页面上放进不给脚本、不给同源的沙箱 iframe 里按网页显示，引用的文件取回后内嵌
//   轮次出错中断：round set <页> <id> fault=<原因，如 429 限流>；恢复后 fault= 清掉
//   node align.mjs round show <页> <id> [--no-session]   一轮的字段每个一行（含这一轮没答完的顺便问），再从 dsh-threads read_thread 取会话现状（在不在跑、最后一个回合、最后一句回复前 200 字）；
//     取不到就报错（--no-session 只看登记字段）
//   node align.mjs ls <页> [round] --sid <完整 sid 或前 8 位>   按会话过滤；ls 每行末尾是 sid 前 8 位
//   sid 校验：round add / round set 写 sid= 时，格式必须是 session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx，且会话要存在（dsh-threads read_thread）；
//     查不了（3080 不可用）就报错，确认 sid 无误时加 --no-check-sid 跳过存在性检查（格式照查）
//   node align.mjs sids <页>                         只读：列出页面上格式不对的 sid / prevSid（不改）
//   顺便问（btw，api 16）：用户对某一轮提的旁支问题，不是验收标准、不卡任何事。页面上的提问 / 追问经 First Mate 转发，消息里给出 btw forward 命令
//   node align.mjs btw add <页> --round <轮次> 'q=<问题>' [src=chat]   First Mate 登记对话里的顺便问（写之前探测 3080 api >= 16）
//   node align.mjs btw forward <页> <id>               把这一问（含追问和之前的问答）发给所挂轮次的会话（dsh-threads send_message_to_thread），记下 fwd
//   node align.mjs btw answer <页> <id> 'a=<答案>' [img=… link=…]   会话写回答案 → 对齐页决定栏出一张答案卡（用户点「了解」消掉或「继续追问」）
//   node align.mjs btw when <页> <id> 'when=<什么时候能答>'   现在答不了，先说时机；when= 清掉
//   node align.mjs btw end <页> <id> 'why=<为什么不答>'      不答了
//   node align.mjs btw ls <页> [--round <轮次>] [--sid <前 8 位>] [--new] [status=open|answered|ended]
//   round add --prev：上一条链上还在等答的顺便问转到新一轮（写 from）；dispatch --prev 把会话还不知道的那些写在任务后面；round done / round add --prev 输出里逐行列出
//   整条链放弃（最后一轮 dropped，后面没有新一轮）时还在等答的改成 ended（会话结束时没答）；通过（accepted）的不自动结束，一直等答，直到 btw answer / btw end（2026-11-02 用户定）
//   node align.mjs dispatch <页> <id> --prompt-file <文件> --mode new|continue [--prev …] [--handoff …] [--proj … | --cwd <目录>] [--todo <待办 id>] title=… why=… eta=… eta75=… etaconf=… [stitle=… state=… next=…]
//     派活 + 登记一步做完：new 用 dsh-threads create_thread 开新会话（项目取 --proj / --cwd，都没写就取上一轮的），continue 给 --prev 那一轮的会话
//     send_message_to_thread；再 round add，sid 由命令填（不收 sid=）。哪一步失败就停、打印原始错误；会话已建好但登记失败时打印 sid 和补登记命令
//     --cwd <目录>（只用于 --mode new，不和 --proj 同用）：目录还不是 DSH 工作区就先建（dsh-threads create_workspace，已有就直接用），再开会话、登记轮次，
//     页面 projects 里没有就加上；目录不存在、是文件、对应多个工作区时直接报错，不建会话
//     例: align dispatch first-mate fix-x --prompt-file task.md --mode new --cwd D:/work/repo title=修 X why=新任务 eta=40m eta75=1h etaconf=中
//   会话相关的一律经 dsh-threads（scripts/threads-cli/dsh-threads.mjs 的 main()；测试用 ALIGN_THREADS_CLI 换成替身），align 不另存会话状态
//   <项目> = project id、项目标题或目录路径（先查页面 projects，再查 DSH workspace 表，命中后者自动加进 projects）；--proj '' = 未归属
//
// <页> = init 时登记的 --name，或页面文件路径。每次写入：校验 → 写前复核 hash → 临时文件 → 原子 rename。
// 出错时 stderr 一行原因、exit 1、不改文件。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendUsage, readUsage, badLinesText, filterEvents, formatEvent, summarize, summaryText, parseWhen, sourceOf } from './usage.mjs';
import { decodeLog, LOG_NAMES } from '../tool-stats.js';
import { textOf } from './text-split.mjs';

export { textOf };

export class UsageError extends Error {}
const fail = (m) => { throw new UsageError(m); };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const STORE = process.env.ALIGN_STORE || path.join(DSH_HOME, 'storages', 'alignment-page');
const REGISTRY = path.join(STORE, 'pages.json');
/** 使用日志目录（usage.mjs：按天 jsonl，旧的压缩，90 天清理）。 */
export const USAGE_DIR = path.join(STORE, 'usage');
/** 服务端自己记的一条使用事件（手机 App 经网关桥的请求，src = app）。 */
export function recordUsage(page, src, event) { return appendUsage(USAGE_DIR, { page, src, body: { events: [{ t: Date.now(), ...event }] } }); }
const PORT = Number(process.env.ALIGN_PORT || 3390);
/** 按数据版本选模板：版本 2 页面继续用旧模板渲染（迁移前 First Mate 仍在写版本 2）。 */
const TEMPLATES = { 2: path.join(HERE, 'template-v2.html'), 3: path.join(HERE, 'template.html') };
// \r?\n:FM 仓库的 checkout 会把模板转成 CRLF(core.autocrlf),页面里的换行可能是 CRLF
const MARK = /(<script type="application\/json" id="align-data">\r?\n)([\s\S]*?)(\r?\n<\/script>)/;

export const SECS = { decide: '需要你决定', doing: '进行中', done: '最近完成', note: '须知' };
const COMMON = ['title', 'proj', 'src', 'href'];
export const FIELDS = {
  decide: [...COMMON, 'why', 'opt', 'rec', 'ifnone', 'sid', 'status', 'choice', 'reply', 'answered'],
  doing: [...COMMON, 'state', 'next', 'who', 'sid'],
  done: [...COMMON, 'result', 'choice', 'reply'],
  note: [...COMMON, 'body', 'level'],
};
const REQUIRED = { decide: ['title', 'why', 'opt'], doing: ['title', 'state'], done: ['title'], note: ['title'] };
const ENUMS = { status: ['open', 'sent'], who: ['you', 'agent'], level: ['info', 'warn'] };
const META = ['title', 'next', 'owner', 'proj'];
export const DEFAULT_PROJ = '其他';
/** 服务接口版本：/health 报它；align url/open 在 3080 插件报的 api >= 页面数据版本时才用 3080 路由。 */
export const API_VERSION = 19; // 19：answers 里可带 {kind:'todo-add', title, today?} / {kind:'todo', id, action} / {kind:'goal', id, action, cur?, kr?, note?}（网页「我的」页签：记一条、完成、放进 / 移出今天、派出去做、放弃、恢复；目标记进度、达成、放弃、恢复），只写文件、不发消息，页面数据不变，旧服务端报「不认识的 kind」，网页 serverApi < 19 时不发；18：/file?doc= 也认挂在页面上的 .html 附件（它引用的图片、样式表、样式表里的图片），页面把 .html 附件放进沙箱 iframe 按网页显示；服务端低于 18 时页面照样显示网页、不去取它引用的文件；17：页面数据可带顶层 todos / goals（用户自己的待办和目标，见 MINE_API 一节），轮次可带 goal（属于哪个目标）/ wait（在等哪条待办），answers 里可带 {kind:'rec-take', id}（推荐卡「我来做」），旧代码读到它们整页报错，CLI 第一次写进页面前先探测 api >= 17；16：页面数据可带顶层 btw（顺便问，见 BTW_* 和 btw 子命令），answers 里可带 {kind:'btw', round, q} / {kind:'btw-more', id, q} / {kind:'btw-ack', id}，旧代码读到 btw 整页报错，CLI 写 btw 前先探测 api >= 16；15：轮次可带 pauses（暂缓时段 [{from, to?}]，CLI 改 status 进出 paused 时写）和 untimed（暂缓过但时刻不明，已用不准），旧代码读到它们整页报错，CLI 写 pauses 前先探测 api >= 15； 14：POST /p/<页>/image 存留言图片（请求体是图片原始字节，存到 <STORE>/memo-images/<日期>/，单张 ≤ 20 MB），answers 里的留言可带 images:[本机路径]（最多 5 张，可以没有文字），消息里逐行列出路径；/file 也给这些图（留言框缩略图）； 13：轮次可带 visual（"true" = 视觉类交付，待验收详情把截图放在最上面；进待验收的命令必带 visual=true|false，true 要有 img），旧代码读到它整页报错，CLI 写 visual=true 前先探测 api >= 13； 12：/file 出错时回 {ok:false, code, message, hint}（message 是给人看的原因，hint 是下一步），挂它的会话读写过的 git 仓库也算可读目录，轮次 handoff 也能读； 11：POST /p/<页>/log {pid, dev, embed, h, events:[{t, type, …}]} 收使用日志（usage.mjs，页面攒批 / 关闭前 sendBeacon）； 10：POST /p/<页>/order {order:[项目 id]} 存项目顺序（页面 projOrder，「已完成」栏拖动排序，各栏跟随）； 9：answers 里可带一条 {kind:'message', text}（用户留言，不挂在决定或轮次上，消息里写成「用户留言：…」，不带命令）； 8：answers 里轮次可 action:'revise'（待验收的「修改」，意见必填），决定可以没有选项（开放问题，只能文字答复），columnOf 改为会话停了才算「等你决定」、取消「等你回答」； 7：轮次 accepted（done = 等验收），/data 顶层带 live（会话实时状态，3390 为 null），answers 里轮次可 action:'accept'，listPages 的 open 改为要你处理的卡数（另有 decisions）； 6：条目附件 img / link，轮次 fault（出错中断），GET /p/<页>/file?path= 只读提供附件里的本地文件； 5：answers 里可有轮次操作（kind:'round'）和须知已了解（kind:'note'）；4：/answer 支持 {answers:[…]} 一次发出多个决定
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KEEP_DONE = 20;

// ---- 版本 3 字段 ----------------------------------------------------------------------------
const V3_COMMON = ['proj', 'title', 'src', 'href', 'updated', 'img', 'link'];
/** 附件字段：数组（其余字段都是字符串）。img = [{src, cap?}]，link = [{href, title?}]。 */
const ATTACH = ['img', 'link'];
export const V3 = {
  rounds: { fields: [...V3_COMMON, 'status', 'sid', 'stitle', 'mode', 'why', 'prev', 'prevSid', 'handoff', 'state', 'next', 'result', 'started', 'ended',
    'eta', 'eta75', 'etaconf', 'etaadj', 'etanote', 'ask', 'asknote', 'asked', 'fault', 'kpi', 'visual', 'pauses', 'untimed', 'goal', 'wait'],
    required: ['title', 'status'], keep: 40,
    enums: { status: ['doing', 'waiting', 'paused', 'done', 'accepted', 'dropped'], mode: ['continue', 'compact', 'new'], etaconf: ['高', '中', '低'], ask: ['done', 'dropped', 'paused', 'resume', 'accept', 'revise'], visual: ['true'], untimed: ['true'] } },
  // api 7 决策卡：risk / cat（为什么要你定）、like + scope（作用范围、长期规则 revoked / revokeAsked）、opened / timeout / due（超时；auto / autoAt / overdue 由超时处理写）
  decisions: { fields: [...V3_COMMON, 'round', 'why', 'opt', 'rec', 'ifnone', 'sid', 'status', 'choice', 'reply', 'answered', 'result',
    'risk', 'cat', 'like', 'scope', 'opened', 'timeout', 'due', 'auto', 'autoAt', 'overdue', 'revoked', 'revokeAsked', 'kpi'],
    required: ['title', 'status'], enums: { status: ['pending', 'open', 'sent', 'done'], risk: ['高', '中', '低'], cat: ['花钱', '不可逆', '对外发消息', '线上配置', '方向取舍', '其他'],
      scope: ['once', 'project', 'always'], auto: ['timeout'] }, keep: 20 },
  notes: { fields: [...V3_COMMON, 'body', 'level', 'acked'], required: ['title'], enums: { level: ['info', 'warn'] } },
};
const COLLS = ['rounds', 'decisions', 'notes'];
const LABEL = { rounds: 'round', decisions: 'decide', notes: 'note' };
const META3 = ['title', 'next', 'owner', 'timeoutHigh', 'projOrder'];
/** 页面 meta timeoutHigh：高风险决定超时后 remind（缺省，只提醒）或 auto（同样按推荐自动作答）。 */
const TIMEOUT_HIGH = ['remind', 'auto'];
/** 决定的作用范围（选项第三段 / 答复的 scope）：本次 / 这个项目 / 以后同类。 */
const SCOPES = ['once', 'project', 'always'];
/** 这些类别后果重，risk 不能写「低」（First Mate AGENTS.md 授权段：不可逆、对外发消息、改线上服务配置）。 */
const NOT_LOW = ['不可逆', '对外发消息', '线上配置'];
const RISK_HINT = 'risk=高|中|低 cat=花钱|不可逆|对外发消息|线上配置|方向取舍|其他（为什么要你定，对应 First Mate AGENTS.md 授权段）';
const DEFAULT_TIMEOUT = '8h';
const LIKE_MAX = 80;
const MODE_LABEL = { continue: '续发', compact: '压缩后续发', new: '新会话' };
/** round add / set 能写的 mode。compact（压缩后续发）2026-10-23 取消：旧轮次照常显示，不迁移，但不能再新写。 */
const WRITABLE_MODES = ['continue', 'new'];
const MODE_RETIRED = '「压缩后续发」（--mode compact）已于 2026-10-23 取消：在原会话续发用 --mode continue，新开会话用 --mode new --handoff <交接文件>';
function checkWritableMode(mode, cmd) {
  if (mode === 'compact') fail(MODE_RETIRED);
  if (!WRITABLE_MODES.includes(mode)) fail(cmd + ' 要 --mode continue | new');
}
/** 由 CLI 维护的字段，以及要用 --flag 设置的字段：k=v 里出现直接报错。 */
const CLI_KEYS = ['id', 'sec', 'updated', 'started', 'ended', 'prevSid', 'answered', 'opened', 'due', 'auto', 'autoAt', 'overdue', 'revoked', 'pauses', 'untimed'];
/** 用户在页面上对轮次发出的操作（answerBatch 写入）；CLI 改这一轮的 status 时一起删掉，k=v 里不能写。 */
const ASK_KEYS = ['ask', 'asknote', 'asked'];
/** 页面写入的决定字段：用户在页面上点了长期规则的「撤销」（rule revoke 时清掉）。 */
const PAGE_KEYS = ['revokeAsked'];
/**
 * 轮次的两个谓词（api 7）：
 *   isFinished = done | accepted | dropped：这一轮的活结束了 —— 写 ended、stale 判「所挂轮次已完成」、待处理决定、这一轮的产出、ls doing/done、项目「未完成」计数都按它；
 *   isClosed   = accepted | dropped：已结束（页面「已结束」栏）—— 只有裁剪按它（done 在等用户验收，不能裁）。
 */
const FINISHED = ['done', 'accepted', 'dropped'];
export const isFinished = (r) => FINISHED.includes(r.status);
export const isClosed = (r) => r.status === 'accepted' || r.status === 'dropped';
/** 时长字段：40m、1h15m、2h。 */
const DURATION = /^(?:\d+h)?(?:\d+m)?$/;
const DURATION_KEYS = ['eta', 'eta75', 'etaadj', 'timeout'];
/** 时长（40m、1h15m、2h）→ 毫秒。 */
const durMs = (v) => { const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?$/); if (!v || !m) fail('timeout 要写成时长，如 40m、1h15m、2h: ' + v); return ((Number(m[1] || 0) * 60) + Number(m[2] || 0)) * 60000; };
const ETA_HINT = 'eta=<中位数> eta75=<P75> etaconf=高|中|低（时长写成 40m、1h15m、2h；用 task-eta skill 估）';
const FLAG_KEYS = { prev: '--prev', proj: '--proj', mode: '--mode', handoff: '--handoff', round: '--round', todo: '--todo' };

const p2 = (n) => String(n).padStart(2, '0');
/** ALIGN_NOW（ISO）只给测试用：固定「现在」，好造出先后关系。 */
export function nowIso(d = process.env.ALIGN_NOW ? new Date(process.env.ALIGN_NOW) : new Date()) {
  const o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) +
    s + p2(Math.floor(Math.abs(o) / 60)) + ':' + p2(Math.abs(o) % 60);
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- 数据 <-> 页面 -------------------------------------------------------------------------
export function parsePage(text) {
  const m = text.match(MARK);
  if (!m) fail('页面里没有 align-data 数据块（不是对齐页，或数据块被手工改坏）');
  let data;
  try { data = JSON.parse(m[2]); } catch (e) { fail('数据块不是合法 JSON: ' + e.message); }
  upgrade(data);
  validate(data);
  return data;
}

/** 版本 1 没有项目字段：读入时补成页面默认项目（meta proj=…，没有就是「其他」），下次写入即落盘为版本 2。 */
export function upgrade(data) {
  if (data && data.version === 1 && Array.isArray(data.items)) {
    for (const it of data.items) if (it && !it.proj) it.proj = data.proj || DEFAULT_PROJ;
    data.version = 2;
  }
  return data;
}

const headLines = (head) => Object.entries(head).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v));

/** 每条一行，id 在最前：git diff 里一次改动就是一行。 */
export function serialize(data) {
  if (data.version === 3) {
    const lines = headLines({ version: 3, name: data.name, title: data.title, next: data.next, owner: data.owner, timeoutHigh: data.timeoutHigh, projOrder: data.projOrder, updated: data.updated });
    const arr = (k) => JSON.stringify(k) + ':[\n' + data[k].map((x) => JSON.stringify(x)).join(',\n') + '\n]';
    // btw（api 16）、goals / todos（api 17）只在有条目时写：没用过的页面和以前逐字节相同，旧 3080 照样读得了
    const opt = ['btw', 'goals', 'todos'].filter((k) => data[k] && data[k].length);
    return ('{' + [...lines, ...['projects', ...COLLS, ...opt].map(arr)].join(',\n') + '}').replace(/</g, '\\u003c');
  }
  const lines = headLines({ version: 2, name: data.name, title: data.title, proj: data.proj, next: data.next, owner: data.owner, updated: data.updated });
  const items = data.items.map((it) => JSON.stringify(it));
  return ('{' + lines.join(',\n') + ',\n"items":[\n' + items.join(',\n') + '\n]}').replace(/</g, '\\u003c');
}

/** text-split.mjs 里 @inline-begin … @inline-end 之间的源码：版本 3 页面把它注入模板的 /*@text-split*\/ 占位，网页和服务端 textOf 同一份。 */
export function textSplitInline() {
  const src = fs.readFileSync(path.join(HERE, 'text-split.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('// @inline-begin\n'), b = src.indexOf('// @inline-end');
  if (a < 0 || b < a) fail('text-split.mjs 缺 @inline-begin / @inline-end 标记');
  const code = src.slice(a + '// @inline-begin\n'.length, b);
  if (/<\/script|\bimport\b|\bexport\b/i.test(code)) fail('text-split.mjs 的 @inline 段不能有 </script、import、export（要原样注入页面脚本）');
  return code;
}

export function render(data) {
  const file = TEMPLATES[data.version];
  if (!file) fail('没有数据版本 ' + data.version + ' 的模板');
  let tpl = fs.readFileSync(file, 'utf8');
  if (!tpl.includes('__ALIGN_DATA__')) fail('模板缺少 __ALIGN_DATA__ 占位: ' + file);
  if (data.version === 3) {
    if (tpl.split('/*@text-split*/').length !== 2) fail('模板要有且只有一个 /*@text-split*/ 占位: ' + file);
    tpl = tpl.replace('/*@text-split*/', textSplitInline);
  }
  return tpl.replace('__ALIGN_DATA__', () => serialize(data));
}

export function validate(data) {
  if (!data || typeof data !== 'object') fail('数据必须是对象');
  if (data.version === 3) return validate3(data);
  if (data.version !== 2) fail('不认识的数据版本 ' + data.version);
  if (!ID.test(data.name || '')) fail('页面 name 必须是小写字母/数字/连字符: ' + data.name);
  if (!data.title) fail('页面缺 title');
  if (!Array.isArray(data.items)) fail('items 必须是数组');
  const seen = new Set();
  for (const it of data.items) {
    const where = (it.sec || '?') + '/' + (it.id || '?');
    if (!ID.test(it.id || '')) fail(where + ': id 必须是小写字母/数字/连字符(≤48)');
    if (seen.has(it.id)) fail(where + ': id 重复');
    seen.add(it.id);
    if (!SECS[it.sec]) fail(where + ': 区块必须是 ' + Object.keys(SECS).join(' | '));
    const allowed = new Set(['id', 'sec', 'updated', ...FIELDS[it.sec]]);
    for (const k of Object.keys(it)) if (!allowed.has(k)) fail(where + ': 区块 ' + it.sec + ' 没有字段 ' + k + '（可用: ' + FIELDS[it.sec].join(', ') + '）');
    for (const k of ['proj', ...REQUIRED[it.sec]]) if (it[k] === undefined || it[k] === '') fail(where + ': 缺必填字段 ' + k);
    if (it.proj.length > 40) fail(where + ': proj 太长（≤40 字）');
    for (const [k, vals] of Object.entries(ENUMS)) if (it[k] !== undefined && !vals.includes(it[k])) fail(where + ': ' + k + ' 只能是 ' + vals.join(' | '));
    for (const [k, v] of Object.entries(it)) if (k !== 'opt' && typeof v !== 'string') fail(where + ': ' + k + ' 必须是字符串');
    if (it.sec === 'decide') {
      if (!Array.isArray(it.opt) || it.opt.length < 2) fail(where + ': 至少 2 个选项 (opt="选项::后果")');
      const labels = it.opt.map((o) => o.label);
      for (const o of it.opt) if (!o.label || !o.effect || Object.keys(o).length !== 2) fail(where + ': 选项要写成 opt="选项::后果"');
      if (new Set(labels).size !== labels.length) fail(where + ': 选项名重复');
      if (it.rec !== undefined && !labels.includes(it.rec)) fail(where + ': rec 必须是选项名之一: ' + labels.join(' | '));
      if (!it.status) fail(where + ': 缺 status');
      if (it.status === 'sent' && it.choice !== '' && it.choice !== undefined && !labels.includes(it.choice)) fail(where + ': choice 不是选项名');
    }
    if (it.href && !/^(https?:\/\/|file:\/\/\/)/.test(it.href)) fail(where + ': href 只接受 http(s):// 或 file:/// 链接');
  }
}

// ---- 暂缓时段（pauses，api 15）--------------------------------------------------------------------
/**
 * 轮次的暂缓时段 pauses = [{from, to?}]（ISO，按时间排序、不重叠）：CLI 改 status 进入 paused 时追加 {from}，离开 paused 时补上 to；
 * 只有最后一段可以没有 to，且这时轮次必须还是 paused。已用（页面）和 task-eta 的整件任务时长都扣掉这些时段。
 * untimed = "true"：这一轮暂缓过，但暂缓时刻没记下、也没能从会话日志推出来（backfill-pauses.mjs），已用标「约」、不进 task-eta 校准。
 */
function checkPauses(r, where) {
  if (r.pauses === undefined) return;
  if (!Array.isArray(r.pauses) || !r.pauses.length) fail(where + ': pauses 必须是非空数组');
  let last = -Infinity;
  r.pauses.forEach((p, i) => {
    if (!p || typeof p !== 'object') fail(where + ': pauses 每项要是 {from, to?}');
    for (const k of Object.keys(p)) if (k !== 'from' && k !== 'to') fail(where + ': pauses 没有字段 ' + k + '（可用: from, to）');
    const a = Date.parse(p.from), b = p.to === undefined ? null : Date.parse(p.to);
    if (typeof p.from !== 'string' || Number.isNaN(a) || (b !== null && (typeof p.to !== 'string' || Number.isNaN(b)))) fail(where + ': pauses 的 from / to 要是 ISO 时间');
    if (a < last || (b !== null && b < a)) fail(where + ': pauses 要按时间排序、不重叠');
    if (b === null && (i !== r.pauses.length - 1 || r.status !== 'paused')) fail(where + ': 只有暂缓中的轮次的最后一段 pauses 可以没有 to');
    last = b ?? a;
  });
}
/** 进入 paused 时是否追加暂缓时段：main 按 3080 的 api 设（pauseApiReady），旧插件读到 pauses 会整页报错。 */
let pauseLog = true;

// ---- 附件（img / link）--------------------------------------------------------------------------
const isUrl = (s) => /^https?:\/\//i.test(s);
const isSession = (s) => /^session-[0-9a-f-]{8,}$/i.test(s);
function checkAttach(it, where) {
  for (const k of ATTACH) {
    if (it[k] === undefined) continue;
    if (!Array.isArray(it[k]) || !it[k].length) fail(where + ': ' + k + ' 必须是非空数组');
    const [ref, label] = k === 'img' ? ['src', 'cap'] : ['href', 'title'];
    const refs = new Set();
    for (const a of it[k]) {
      if (!a || typeof a !== 'object' || typeof a[ref] !== 'string' || !a[ref]) fail(where + ': ' + k + ' 每项要有 ' + ref);
      for (const f of Object.keys(a)) if (f !== ref && f !== label) fail(where + ': ' + k + ' 没有字段 ' + f + '（可用: ' + ref + ', ' + label + '）');
      if (a[label] !== undefined && (typeof a[label] !== 'string' || !a[label])) fail(where + ': ' + k + ' 的 ' + label + ' 必须是非空字符串');
      const v = a[ref];
      if (!(isUrl(v) || path.isAbsolute(v) || (k === 'link' && isSession(v)))) fail(where + ': ' + k + ' 只接受 http(s) 链接' + (k === 'link' ? '、会话 id' : '') + '或绝对路径: ' + v);
      if (refs.has(v)) fail(where + ': ' + k + ' 重复: ' + v);
      refs.add(v);
    }
  }
}
/** CLI 的 img= / link=：<路径或链接>[::说明] 追加一项；<k>=-<路径或链接> 删掉那一项；<k>= 清空。本地路径展开 ~ 后必须是已有文件。 */
function applyAttach(it, kv) {
  const keys = [];
  for (const [k, v] of kv) {
    if (!ATTACH.includes(k)) continue;
    const [ref, label] = k === 'img' ? ['src', 'cap'] : ['href', 'title'];
    if (v === '') { delete it[k]; keys.push(k); continue; }
    const norm = (s) => (isUrl(s) || (k === 'link' && isSession(s)) ? s : path.resolve(expandHome(s)));
    if (v.startsWith('-')) {
      const target = norm(v.slice(1));
      const list = it[k] || [];
      if (!list.some((a) => a[ref] === target)) fail(it.id + ' 没有这个 ' + k + ': ' + target);
      const rest = list.filter((a) => a[ref] !== target);
      if (rest.length) it[k] = rest; else delete it[k];
      keys.push(k);
      continue;
    }
    const j = v.indexOf('::');
    const raw = (j < 0 ? v : v.slice(0, j)).trim(), text = j < 0 ? '' : v.slice(j + 2).trim();
    const target = norm(raw);
    if (!isUrl(target) && !(k === 'link' && isSession(target)) && !(fs.existsSync(target) && fs.statSync(target).isFile())) fail(k + ' 的本地文件不存在: ' + target);
    const list = it[k] || [];
    if (list.some((a) => a[ref] === target)) fail(k + ' 已经有了: ' + target);
    it[k] = [...list, { [ref]: target, ...(text ? { [label]: text } : {}) }];
    keys.push(k);
  }
  return keys;
}

function validate3(data) {
  const top = new Set(['version', 'name', 'title', 'next', 'owner', 'updated', 'timeoutHigh', 'projOrder', 'projects', ...COLLS, 'btw', 'goals', 'todos']);
  for (const k of Object.keys(data)) if (!top.has(k)) fail('版本 3 页面没有顶层字段 ' + k);
  if (!ID.test(data.name || '')) fail('页面 name 必须是小写字母/数字/连字符: ' + data.name);
  if (!data.title || typeof data.title !== 'string') fail('页面缺 title');
  for (const k of ['next', 'owner', 'updated']) if (data[k] !== undefined && typeof data[k] !== 'string') fail('页面 ' + k + ' 必须是字符串');
  if (data.timeoutHigh !== undefined && !TIMEOUT_HIGH.includes(data.timeoutHigh)) fail('timeoutHigh 只能是 ' + TIMEOUT_HIGH.join(' | '));
  for (const k of ['projects', ...COLLS]) if (!Array.isArray(data[k])) fail(k + ' 必须是数组');
  const pids = new Set();
  for (const p of data.projects) {
    const where = 'project/' + ((p && p.id) || '?');
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) fail(where + ': 缺 id');
    if (pids.has(p.id)) fail(where + ': 项目 id 重复');
    pids.add(p.id);
    for (const k of Object.keys(p)) if (!['id', 'title', 'cwd'].includes(k)) fail(where + ': 项目没有字段 ' + k + '（可用: id, title, cwd）');
    for (const k of ['title', 'cwd']) if (typeof p[k] !== 'string' || !p[k]) fail(where + ': 缺必填字段 ' + k);
  }
  // 项目顺序（api 10）：项目 id 数组，未归属是 ''；不写 = 默认顺序（最急的组在前）
  if (data.projOrder !== undefined) {
    if (!Array.isArray(data.projOrder) || !data.projOrder.length) fail('projOrder 必须是非空数组（项目 id，未归属写空串；恢复默认顺序就删掉它）');
    const op = new Set();
    for (const p of data.projOrder) {
      if (typeof p !== 'string') fail('projOrder 里每项都必须是项目 id 字符串');
      if (p !== '' && !pids.has(p)) fail('projOrder 里的 ' + p + ' 不在 projects 里');
      if (op.has(p)) fail('projOrder 里 ' + JSON.stringify(p) + ' 重复');
      op.add(p);
    }
  }
  const seen = new Set();
  for (const coll of COLLS) {
    const spec = V3[coll];
    for (const it of data[coll]) {
      if (!it || typeof it !== 'object') fail(coll + ' 里每条都必须是对象');
      const where = LABEL[coll] + '/' + (it.id || '?');
      if (!ID.test(it.id || '')) fail(where + ': id 必须是小写字母/数字/连字符(≤48)');
      if (seen.has(it.id)) fail(where + ': id 重复（rounds / decisions / notes 之间也不能重复）');
      seen.add(it.id);
      const allowed = new Set(['id', ...spec.fields]);
      for (const k of Object.keys(it)) if (!allowed.has(k)) fail(where + ': ' + LABEL[coll] + ' 没有字段 ' + k + '（可用: ' + spec.fields.join(', ') + '）');
      for (const k of spec.required) if (it[k] === undefined || it[k] === '') fail(where + ': 缺必填字段 ' + k);
      for (const [k, v] of Object.entries(it)) if (k !== 'opt' && k !== 'kpi' && k !== 'pauses' && !ATTACH.includes(k) && typeof v !== 'string') fail(where + ': ' + k + ' 必须是字符串');
      checkKpi(it, where);
      if (coll === 'rounds') checkPauses(it, where);
      checkAttach(it, where);
      for (const [k, vals] of Object.entries(spec.enums)) if (it[k] !== undefined && !vals.includes(it[k])) fail(where + ': ' + k + ' 只能是 ' + vals.join(' | '));
      for (const k of DURATION_KEYS) if (it[k] !== undefined && (!it[k] || !DURATION.test(it[k]))) fail(where + ': ' + k + ' 要写成时长，如 40m、1h15m、2h: ' + it[k]);
      if (coll === 'rounds' && it.visual === 'true' && it.status === 'done' && !it.img) fail(where + ': ' + VISUAL_NEED_IMG);
      if (it.proj !== undefined && !pids.has(it.proj)) fail(where + ': proj ' + it.proj + ' 不在 projects 里');
      if (it.href && !/^(https?:\/\/|file:\/\/\/)/.test(it.href)) fail(where + ': href 只接受 http(s):// 或 file:/// 链接');
      if (it.handoff !== undefined && !/^https?:\/\//.test(it.handoff) && !path.isAbsolute(it.handoff)) fail(where + ': handoff 要是绝对路径或 http(s) 链接');
      if (coll === 'decisions') {
        // done 的决定可以没有 why/opt（迁移来的「最近完成」只有 choice/reply）；pending（等信息）也可以缺，提升为 open 时才要
        const loose = it.status === 'done' || it.status === 'pending';
        if (!loose && !it.why) fail(where + ': 缺必填字段 why');
        // 开放问题（v8）：open / sent 的决定可以没有选项（不写 opt 或 opt 为空），只能文字答复；没有选项就不能有推荐（超时只提醒）
        const openQ = !loose && (it.opt === undefined || (Array.isArray(it.opt) && !it.opt.length));
        if (openQ && it.rec !== undefined) fail(where + ': 没有选项的决定（开放问题）不能写 rec');
        if (!openQ && (!loose || it.opt !== undefined)) {
          if (!Array.isArray(it.opt) || it.opt.length < 2) fail(where + ': 至少 2 个选项 (opt="选项::后果")');
          for (const o of it.opt) {
            if (!o || !o.label || !o.effect || Object.keys(o).some((k) => !['label', 'effect', 'scope'].includes(k))) fail(where + ': 选项要写成 opt="选项::后果[::once|project|always]"');
            if (o.scope !== undefined && !SCOPES.includes(o.scope)) fail(where + ': 选项的作用范围只能是 ' + SCOPES.join(' | '));
          }
        }
        const labels = (it.opt || []).map((o) => o.label);
        if (new Set(labels).size !== labels.length) fail(where + ': 选项名重复');
        if (it.rec !== undefined && !labels.includes(it.rec)) fail(where + ': rec 必须是选项名之一: ' + labels.join(' | '));
        if (it.status === 'sent' && it.choice !== '' && it.choice !== undefined && !labels.includes(it.choice)) fail(where + ': choice 不是选项名');
        if (it.like !== undefined && it.like.length > LIKE_MAX) fail(where + ': like 最多 ' + LIKE_MAX + ' 字');
        if (!it.like && ((it.opt || []).some((o) => o.scope && o.scope !== 'once') || ['project', 'always'].includes(it.scope))) fail(where + ': 有「这个项目 / 以后同类」的作用范围时要写 like=<「同类」的一句话定义>');
        if (it.risk === '低' && NOT_LOW.includes(it.cat)) fail(where + ': cat=' + it.cat + ' 的 risk 不能是 低');
        if (it.cat === '花钱' && it.why && !/[¥￥元]/.test(it.why)) fail(where + ': cat=花钱 时 why 里要写金额（带 ¥ 或 元）');
      }
    }
  }
  validateBtw(data);
  validateMine(data);
}

/** 今日推荐：须知 id = rec-YYYYMMDD-N（rec set 写入）；页面上在「决定」页签另成一组，用户选派出去做 / 不做发出后 acked。 */
export const REC_ID = /^rec-\d{8}-\d+$/;
const REC_MAX = 5, REC_TITLE_MAX = 80, REC_WHY_MAX = 300;
const isRec = (n) => REC_ID.test(n.id);
/** rec ls：每条一行，已处理 = 用户已选不做或派出去做（派出去做的 First Mate 派完会删掉）。 */
export function recLines(data) {
  const list = data.notes.filter(isRec);
  return list.map((n) => 'rec/' + n.id + ' [' + (n.acked ? '已处理' : '没处理') + '] ' + n.title + ' · ' + n.body).join('\n') || '（没有推荐）';
}
/** 长期规则：作用范围是「以后同类」、已处理且没撤销的决定（裁剪不裁，rule ls 列出）。 */
const isRule = (d) => d.status === 'done' && d.scope === 'always' && !d.revoked;
/** 每次写入的裁剪：版本 2 done 留 20；版本 3 已结束（accepted + dropped，isClosed）轮次合计留 40、done 决定留 20（按 updated 最新）；done（等验收）、paused 和挂着没答的顺便问的轮次不裁。 */
function prune(data) {
  const keep = (arr, n, isDone) => {
    const done = arr.filter(isDone).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const drop = new Set(done.slice(n).map((x) => x.id));
    return arr.filter((x) => !drop.has(x.id));
  };
  if (data.version === 3) {
    const asking = new Set((data.btw || []).filter((b) => b.status === 'open').map((b) => b.round));
    for (const c of ['rounds', 'decisions']) data[c] = keep(data[c], V3[c].keep, c === 'rounds' ? (r) => isClosed(r) && !asking.has(r.id) : (x) => x.status === 'done' && !isRule(x));
    // 顺便问跟着轮次裁：所挂轮次已不在页面上的一起删；删光了就去掉 btw 字段
    if (data.btw) { const ids = new Set(data.rounds.map((r) => r.id)); data.btw = data.btw.filter((b) => ids.has(b.round)); if (!data.btw.length) delete data.btw; }
    // 待办：完成 / 放弃的留 100 条（按 updated 最新）；有轮次在等的不裁
    for (const k of ['todos', 'goals']) if (data[k] && !data[k].length) delete data[k];
    if (data.todos) { const waited = new Set(data.rounds.map((r) => r.wait).filter(Boolean)); data.todos = keep(data.todos, MINE_MAX.keepDone, (t) => (t.status === 'done' || t.status === 'dropped') && !waited.has(t.id)); }
  }
  else data.items = keep(data.items, KEEP_DONE, (x) => x.sec === 'done');
}

// ---- 顺便问（btw，api 16）-------------------------------------------------------------------------
/**
 * 顺便问：用户对某一轮提的旁支问题（不是验收标准、不卡任何事）。页面数据顶层 btw = [{
 *   id: b-…, round: 现在挂的轮次, from?: 最早提问时挂的轮次（--prev 转过才有）, src: web | app | chat,
 *   q, asked, a?, answered?, fwd?: 转给会话的时间（原问题这一问）,
 *   more?: [{q, asked, a?, answered?, fwd?}]（继续追问，最后一项是最新的一问）,
 *   status: open 等答 | answered 已答 | ended 不答了, when?: 会话说的回答时机, endWhy?, ended?,
 *   seen?: 用户在决定栏点「了解」的时间（最新答案晚于它 = 决定栏里有一张答案卡）, img?, link?
 * }]。没有条目时不写这个字段（旧页面逐字节不变）。不计入决定数、不进 columnOf、不触发超时；所挂轮次被裁掉时一起删。
 */
export const BTW_API = 16;
/** dispatch 传给 round add 的内部标记：这些顺便问已写进发给会话的任务（Symbol：命令行的 --flag 写不出来）。 */
const BTW_FWD = Symbol('btwFwd');
const BTW_Q_MAX = 300, BTW_A_MAX = 2000, BTW_MORE_MAX = 10;
const BTW_STATUS = ['open', 'answered', 'ended'];
const BTW_SRC = ['web', 'app', 'chat'];
const BTW_FIELDS = ['id', 'round', 'from', 'src', 'q', 'asked', 'a', 'answered', 'fwd', 'more', 'status', 'when', 'endWhy', 'ended', 'seen', 'img', 'link'];
const BTW_ENTRY = ['q', 'asked', 'a', 'answered', 'fwd'];
/** 一条顺便问的各问：原问题 + 追问，最后一项是最新的。 */
export const btwAsks = (b) => [b, ...(b.more || [])];
const btwLast = (b) => btwAsks(b).pop();
/** 最新答案的时间（还没答过是 ''）。 */
export const btwAnsweredAt = (b) => btwAsks(b).map((x) => x.answered || '').filter(Boolean).pop() || '';
/** 决定栏里该出答案卡：已答，且最新答案晚于用户点「了解」的时间。 */
export const btwUnseen = (b) => b.status === 'answered' && !(b.seen && Date.parse(b.seen) >= Date.parse(btwAnsweredAt(b)));
function validateBtw(data) {
  if (data.btw === undefined) return;
  if (!Array.isArray(data.btw) || !data.btw.length) fail('btw 必须是非空数组（没有顺便问就删掉这个字段）');
  const rounds = new Set(data.rounds.map((r) => r.id)), seen = new Set();
  const str = (v) => typeof v === 'string' && v !== '';
  for (const b of data.btw) {
    if (!b || typeof b !== 'object') fail('btw 里每条都必须是对象');
    const where = 'btw/' + (b.id || '?');
    if (!ID.test(b.id || '')) fail(where + ': id 必须是小写字母/数字/连字符(≤48)');
    if (seen.has(b.id)) fail(where + ': id 重复');
    seen.add(b.id);
    for (const k of Object.keys(b)) if (!BTW_FIELDS.includes(k)) fail(where + ': btw 没有字段 ' + k + '（可用: ' + BTW_FIELDS.join(', ') + '）');
    for (const k of ['round', 'q', 'asked', 'status', 'src']) if (!str(b[k])) fail(where + ': 缺必填字段 ' + k);
    for (const [k, v] of Object.entries(b)) if (!['more', 'img', 'link'].includes(k) && typeof v !== 'string') fail(where + ': ' + k + ' 必须是字符串');
    if (!BTW_STATUS.includes(b.status)) fail(where + ': status 只能是 ' + BTW_STATUS.join(' | '));
    if (!BTW_SRC.includes(b.src)) fail(where + ': src 只能是 ' + BTW_SRC.join(' | '));
    if (!rounds.has(b.round)) fail(where + ': 轮次 ' + b.round + ' 不在页面上');
    if (b.more !== undefined) {
      if (!Array.isArray(b.more) || !b.more.length || b.more.length > BTW_MORE_MAX) fail(where + ': more 是 1–' + BTW_MORE_MAX + ' 条追问');
      for (const m of b.more) {
        if (!m || typeof m !== 'object' || Object.keys(m).some((k) => !BTW_ENTRY.includes(k))) fail(where + ': 追问只有字段 ' + BTW_ENTRY.join(', '));
        if (!str(m.q) || !str(m.asked)) fail(where + ': 追问要有 q 和 asked');
        for (const v of Object.values(m)) if (typeof v !== 'string') fail(where + ': 追问的字段都是字符串');
      }
    }
    for (const x of btwAsks(b)) {
      if (x.q.length > BTW_Q_MAX) fail(where + ': 问题最多 ' + BTW_Q_MAX + ' 字');
      if (x.a !== undefined && (!x.a || x.a.length > BTW_A_MAX)) fail(where + ': 答案是 1–' + BTW_A_MAX + ' 字');
      if ((x.a === undefined) !== (x.answered === undefined)) fail(where + ': a 和 answered 要一起写');
    }
    const asks = btwAsks(b);
    if (asks.slice(0, -1).some((x) => x.a === undefined)) fail(where + ': 前一问还没答，不能有新的追问');
    const last = asks[asks.length - 1];
    if (b.status === 'answered' && last.a === undefined) fail(where + ': status=answered 时最新一问要有答案');
    if (b.status === 'open' && last.a !== undefined) fail(where + ': 最新一问已经有答案，status 应是 answered');
    if (b.status === 'ended' && !b.ended) fail(where + ': status=ended 要有 ended');
    if (b.status !== 'ended' && (b.ended !== undefined || b.endWhy !== undefined)) fail(where + ': 只有 ended 的顺便问才有 ended / endWhy');
    checkAttach(b, where);
  }
}
/**
 * 每次写入（mutate）时收尾：所挂轮次已放弃（dropped）、后面也没有接它的新一轮的 open 顺便问 → ended（会话结束时没答）。
 * 通过（accepted）的不收尾：没答的一直留在 align ls、round show 和页面上，直到会话 btw answer 或有人 btw end（2026-11-02 用户定，防止 First Mate 看不到）。
 * 换会话（round add --prev）在这之前已经把它们转到新一轮，所以只有整条链结束时才会走到这里。
 */
function settleBtw(data, now) {
  if (!data.btw) return;
  for (const b of data.btw) {
    if (b.status !== 'open') continue;
    const r = data.rounds.find((x) => x.id === b.round);
    if (r && r.status === 'dropped' && !data.rounds.some((x) => x.prev === r.id)) Object.assign(b, { status: 'ended', ended: now, endWhy: '会话结束时没答' });
  }
}
/** 新的顺便问 id：b- + 时间（36 进制）+ 序号，和页面上已有的不重。 */
export function newBtwId(data, n = 0, t = Date.parse(nowIso())) {
  const have = new Set((data.btw || []).map((b) => b.id));
  for (let i = n; ; i++) { const id = 'b-' + t.toString(36) + (i ? '-' + i : ''); if (!have.has(id)) return id; }
}
function findBtw(data, id) {
  const b = (data.btw || []).find((x) => x.id === id);
  if (!b) fail('没有 id 为 ' + id + ' 的顺便问（align btw ls <页> 看已有的）');
  return b;
}
const btwText = (v, max, what) => { const s = String(v ?? '').replace(/\r\n?/g, '\n').trim(); if (!s) fail('缺 ' + what); if (s.length > max) fail(what + '最多 ' + max + ' 字，现在 ' + s.length + ' 字'); return s; };
/** 回给会话 / First Mate 照抄的命令。 */
export const btwCmds = (pageArg, id) => ({
  // 页面文件路径里有空格时要加引号，命令才能直接粘贴（psArg：PowerShell 单引号）
  answer: 'align btw answer ' + psArg(pageArg) + ' ' + id + " 'a=<答案>'",
  when: 'align btw when ' + psArg(pageArg) + ' ' + id + " 'when=<什么时候能答>'",
  end: 'align btw end ' + psArg(pageArg) + ' ' + id + " 'why=<为什么不答>'",
  forward: 'align btw forward ' + psArg(pageArg) + ' ' + id,
});
/** 顺便问写给会话的一段（btw forward 的消息、dispatch --prev 附在任务后面）：问题、之前的问答、三条命令。 */
export function btwPromptBlock(data, page, list) {
  const lines = ['对齐页「' + data.title + '」上，用户顺便问了' + (list.length > 1 ? ' ' + list.length + ' 件事' : '一句') + '。这是旁支问题，不改变这一轮的目标和验收，不用停下手上的活；做到能答时再答。', ''];
  list.forEach((b, i) => {
    const asks = btwAsks(b), last = asks[asks.length - 1];
    lines.push((list.length > 1 ? (i + 1) + '. ' : '') + '顺便问 ' + b.id + (asks.length > 1 ? '（追问）' : '') + '：' + last.q.split('\n').join('\n   '));
    if (asks.length > 1) for (const x of asks.slice(0, -1)) lines.push('   之前问：' + x.q, '   之前答：' + x.a);
    if (b.when) lines.push('   你说过的回答时机：' + b.when);
    const c = btwCmds(page, b.id);
    lines.push('   能答时运行：' + c.answer, '   现在答不了，先说什么时候能答：' + c.when, '   不会再答：' + c.end, '');
  });
  lines.push('答案只写结论和关键数字，用户在对齐页上看。');
  return lines.join('\n');
}
/** 这一条所在会话链的最新一轮（沿「下一轮的 prev 是它」往后找，同一轮有多个后继取最晚开始的）。追问发给它、挂到它上面。 */
export function btwTail(data, b) {
  let r = data.rounds.find((x) => x.id === b.round);
  for (let n; r && (n = data.rounds.filter((x) => x.prev === r.id).sort((p, q) => (q.started || q.updated || '').localeCompare(p.started || p.updated || ''))[0]);) r = n;
  return r;
}
/** btw ls / round done / round add --prev 的一行。 */
const btwLine = (head, page, b) => head + ' ' + b.id + ' [' + b.status + '] ' + btwLast(b).q.replace(/\s*\n\s*/g, ' ') + (b.when ? '（' + b.when + '）' : '') + ' → ' + btwCmds(page, b.id).answer + ' | ' + btwCmds(page, b.id).end;
/** round done / round add --prev 之后：这一轮及前序轮次上还在等答的顺便问；新开会话接手的另给转发命令（dispatch 已经写进任务的标「已写进任务」）。 */
export function btwPendingLines(data, rid, page, { carried = false, inPrompt = [] } = {}) {
  const ids = new Set(roundChain(data, rid).map((r) => r.id));
  const r = data.rounds.find((x) => x.id === rid);
  return (data.btw || []).filter((b) => b.status === 'open' && ids.has(b.round)).map((b) => {
    if (!carried || !b.from) return btwLine('待答的顺便问', page, b);
    const fwd = !!btwLast(b).fwd;
    const tail = inPrompt.includes(b.id) ? '（已写进发给会话的任务）' : fwd ? '（同一会话，已经转过）' : '；还没转给会话：' + btwCmds(page, b.id).forward;
    return '转到这一轮的顺便问 ' + b.id + ' ' + btwLast(b).q.replace(/\s*\n\s*/g, ' ') + '（最早问在 ' + b.from + '）' + tail;
  });
}
/** round add --prev：上一条链上还在等答的顺便问转到新一轮（写 from）；新开会话的转发记录清掉（新会话还不知道这些问题）。返回转过来的条目。 */
function carryBtw(data, r, prev, now, fwdIds = []) {
  const chain = new Set(roundChain(data, prev.id).map((x) => x.id)), out = [];
  for (const b of data.btw || []) {
    if (b.status !== 'open' || !chain.has(b.round)) continue;
    if (!b.from) b.from = b.round;
    b.round = r.id;
    if (fwdIds.includes(b.id)) btwLast(b).fwd = now;
    else if (r.mode === 'new') delete btwLast(b).fwd;
    out.push(b);
  }
  return out;
}
/**
 * 与会话 sid 关联、还在等答的顺便问（遍历登记表里的版本 3 页面）：所挂轮次的 sid 是它。dsh-fm 在「会话回合结束」通知末尾列出。
 * 返回 [{page, pageTitle, id, q, round, forwarded, when?, cmds: [answer, when, end]}]；没转给会话的（forwarded=false）先转再说。
 */
export function openBtwForSession(sid) {
  if (typeof sid !== 'string' || !sid) fail('openBtwForSession 要一个会话 sid');
  const out = [];
  for (const [page, file] of Object.entries(readRegistry())) {
    const data = parsePage(fs.readFileSync(file, 'utf8'));
    if (data.version !== 3) continue;
    for (const b of data.btw || []) {
      const r = data.rounds.find((x) => x.id === b.round);
      if (b.status !== 'open' || !r || r.sid !== sid) continue;
      const c = btwCmds(page, b.id), last = btwLast(b);
      out.push({ page, pageTitle: data.title, id: b.id, q: last.q, round: b.round, forwarded: !!last.fwd, ...(b.when ? { when: b.when } : {}), cmds: [c.answer, c.when, c.end] });
    }
  }
  return out;
}
/** 多久前问的（ls / round show 的顺便问行）。 */
function btwAgo(iso) {
  const m = Math.floor((Date.parse(nowIso()) - Date.parse(iso)) / 60000);
  return m < 1 ? '刚问' : (m < 60 ? m + ' 分钟' : m < 1440 ? Math.floor(m / 60) + ' 小时' : Math.floor(m / 1440) + ' 天') + '前问';
}
/** 没答完的顺便问：转没转给会话 · 多久前问的（都按最新一问）· 问题 · 会话说的时机。 */
const btwOpenTail = (b) => { const last = btwLast(b); return (last.fwd ? '已转给会话' : '还没转给会话') + ' · ' + btwAgo(last.asked) + ' · ' + last.q.replace(/\s*\n\s*/g, ' ') + (b.when ? ' · 等：' + b.when : ''); };
export function btwListLines(data, page, kv, flags) {
  let list = data.btw || [];
  if (flags.round !== undefined) list = list.filter((b) => b.round === flags.round || b.from === flags.round);
  if (flags.sid !== undefined) { const q = String(flags.sid).replace(/^session-/, ''); list = list.filter((b) => { const r = data.rounds.find((x) => x.id === b.round); return r && r.sid && r.sid.replace(/^session-/, '').startsWith(q); }); }
  if (flags.new) list = list.filter(btwUnseen);
  for (const [k, v] of kv) { if (k !== 'status') fail('btw ls 只能按 status 过滤（status=open|answered|ended）'); list = list.filter((b) => b.status === v); }
  return list.map((b) => 'btw/' + b.id + ' [' + b.status + (btwUnseen(b) ? '·新' : '') + '] 轮次 ' + b.round + (b.from ? '（问在 ' + b.from + '）' : '') + ' · ' + btwLast(b).q.replace(/\s*\n\s*/g, ' ') +
    (btwLast(b).a ? ' → ' + btwLast(b).a.replace(/\s*\n\s*/g, ' ').slice(0, 80) : b.when ? ' · 等：' + b.when : '') + (b.status === 'open' && !btwLast(b).fwd ? ' · 还没转给会话' : '')).join('\n') || '（没有顺便问）';
}
/** btw 子命令里写文件的几个（btw forward 要先发消息，在 main 里单独处理）。 */
export const btwOps = {
  add(data, now, args, kv, flags) {
    if (args.length) fail('用法: btw add <页> --round <轮次> \'q=<问题>\' [src=chat]');
    if (flags.round === undefined) fail('btw add 要 --round <轮次 id>：顺便问挂在哪一轮');
    const r = data.rounds.find((x) => x.id === flags.round);
    if (!r) fail('没有 id 为 ' + flags.round + ' 的轮次（--round）');
    if (isClosed(r)) fail('round/' + r.id + ' 已经结束（' + r.status + '），顺便问挂到还在做的一轮');
    const o = Object.fromEntries(kv);
    for (const k of Object.keys(o)) if (!['q', 'src'].includes(k)) fail('btw add 只收 q= 和 src=');
    const src = o.src || 'chat';
    if (!BTW_SRC.includes(src)) fail('src 只能是 ' + BTW_SRC.join(' | '));
    const b = { id: newBtwId(data), round: r.id, src, q: btwText(o.q, BTW_Q_MAX, '问题（q=）'), asked: now, status: 'open' };
    (data.btw ||= []).push(b);
    return '加了 btw/' + b.id + '（轮次 ' + r.id + '）；转给会话：' + btwCmds(data.name, b.id).forward;
  },
  when(data, now, [id], kv) {
    const b = findBtw(data, id), o = Object.fromEntries(kv);
    if (kv.some(([k]) => k !== 'when')) fail('btw when 只收 when=');
    if (b.status !== 'open') fail('btw/' + b.id + ' 不在等答（' + b.status + '）');
    if (o.when === '') delete b.when; else b.when = btwText(o.when, 80, '回答时机（when=）');
    return '改了 btw/' + b.id + ' 的回答时机';
  },
  answer(data, now, [id], kv) {
    const b = findBtw(data, id);
    if (kv.some(([k]) => !['a', 'img', 'link'].includes(k))) fail('btw answer 只收 a= img= link=');
    if (b.status === 'ended') fail('btw/' + b.id + ' 已经结束（' + (b.endWhy || '') + '）');
    const last = btwLast(b);
    if (last.a !== undefined) fail('btw/' + b.id + ' 最新一问已经答过了（用户追问后才能再答）');
    last.a = btwText((kv.find(([k]) => k === 'a') || [])[1], BTW_A_MAX, '答案（a=）');
    last.answered = now;
    applyAttach(b, kv.filter(([k]) => k !== 'a'));
    b.status = 'answered';
    delete b.when;
    return 'btw/' + b.id + ' → 已答（对齐页决定栏出一张答案卡）';
  },
  end(data, now, [id], kv) {
    const b = findBtw(data, id);
    if (kv.some(([k]) => k !== 'why')) fail('btw end 只收 why=');
    if (b.status !== 'open') fail('btw/' + b.id + ' 不在等答（' + b.status + '），不用结束');
    Object.assign(b, { status: 'ended', ended: now, endWhy: btwText((kv[0] || [])[1], 200, '原因（why=）') });
    delete b.when;
    return 'btw/' + b.id + ' → 不答了';
  },
};

// ---- 你的待办和目标（todos / goals，api 17）------------------------------------------------------
/**
 * 用户本人的待办和目标（2026-11-02 从 personal-ops 迁来；字段对照见 docs/investigations/2026-11-02-po-to-align/report.md「映射」）。页面数据顶层：
 *   todos = [{id: t-…, title, status: open 待办 | doing 在做 | sent 已派出（round = 派成的轮次）| done 已完成 | dropped 已放弃, src: 手记|推荐|First Mate|导入,
 *     p?: P0–P3, urg?: 紧急|正常|不急, energy?: 高|中|低, eta?: 时长, due?: YYYY-MM-DD, goal?: [目标 id], why?,
 *     today?: YYYY-MM-DD（放进「今天」的日期；只有 todo today --off 去掉，跨天不清，2026-11-02 用户定）,
 *     created, updated, ended?（done / dropped 才有）, round?（sent 必有；done / dropped 可留作记录）, log: [{at, ev, round?, note?}]（最多 50 条）}]
 *   goals = [{id: g-…, title, status: doing 进行中 | done 达成 | dropped 放弃, range?: 长期|季度|月度|本周, metric?, unit?, base? / cur? / target?（数）,
 *     due?: YYYY-MM-DD, why?, projs?: [项目 id], kr?: [{id: k1…, title, cur?, target?, done?}]（关键结果，最多 10 条）,
 *     log?: [{at, cur, kr?, note?}]（进度记录）, created, updated, ended?}]
 *   轮次另有 goal?（这一轮属于哪个目标）、wait?（这一轮在等哪条待办）。
 * 没有条目时不写 todos / goals（旧页面逐字节不变）。旧插件代码读到它们整页报错：页面上还没有时，CLI 写之前先探测 3080 /alignment/health api >= 17。
 * 派给会话的待办自动收尾（settleTodos，每次写入时跑，2026-11-02 用户定）：所派轮次 accepted → done；dropped → 回到 open。
 * 不计入决定数 / cards / open，不进 columnOf、不超时。
 */
export const MINE_API = 17;
const TODO_STATUS = ['open', 'doing', 'sent', 'done', 'dropped'];
const GOAL_STATUS = ['doing', 'done', 'dropped'];
const TODO_SRC = ['手记', '推荐', 'First Mate', '导入'];
/** 待办 log 的 ev：加入 / 从推荐来 / 导入 / 放进今天 / 移出今天 / 在做 / 改回待办 / 派出 / 所派轮次放弃回到待办 / 完成 / 放弃。 */
const TODO_EV = ['add', 'rec', 'import', 'today', 'untoday', 'doing', 'open', 'send', 'back', 'done', 'drop'];
const MINE_ENUMS = { p: ['P0', 'P1', 'P2', 'P3'], urg: ['紧急', '正常', '不急'], energy: ['高', '中', '低'], range: ['长期', '季度', '月度', '本周'] };
const TODO_FIELDS = ['id', 'title', 'status', 'src', 'p', 'urg', 'energy', 'eta', 'due', 'goal', 'today', 'why', 'created', 'updated', 'ended', 'round', 'log'];
const GOAL_FIELDS = ['id', 'title', 'status', 'range', 'metric', 'unit', 'base', 'cur', 'target', 'due', 'why', 'projs', 'kr', 'log', 'created', 'updated', 'ended'];
/** todo add / set、goal add / set 能写的字段（其余由 CLI 维护）。 */
const TODO_KV = ['title', 'p', 'urg', 'energy', 'eta', 'due', 'goal', 'why', 'src', 'status'];
const GOAL_KV = ['title', 'range', 'metric', 'unit', 'base', 'cur', 'target', 'due', 'why', 'projs', 'status'];
const MINE_MAX = { title: 200, why: 4000, note: 500, metric: 40, unit: 10, kr: 10, krTitle: 100, todoLog: 50, goalLog: 200, keepDone: 100 };
export const TODO_LABEL = { open: '待办', doing: '在做', sent: '已派出', done: '已完成', dropped: '已放弃' };
export const GOAL_LABEL = { doing: '进行中', done: '达成', dropped: '放弃' };
const TODO_EV_OF = { open: 'open', doing: 'doing', sent: 'send', done: 'done', dropped: 'drop' };
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
/** b 比 a 晚几天（YYYY-MM-DD，按日历日）。 */
export const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
/** 关键结果算达成：手动标了 done，或有目标值且当前值够了。 */
export const krDone = (k) => !!k.done || (Number.isFinite(k.target) && Number.isFinite(k.cur) && k.cur >= k.target);
/** 目标进度百分比 (cur − base) / (target − base)，base 缺省 0，夹在 0–100；没有 cur 或 target 是 null。 */
export function goalPct(g) {
  if (!Number.isFinite(g.cur) || !Number.isFinite(g.target)) return null;
  const b = Number.isFinite(g.base) ? g.base : 0;
  if (g.target === b) return g.cur >= g.target ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round(((g.cur - b) / (g.target - b)) * 100)));
}
/** 在等这条待办、活还没结束的轮次（wait = 待办 id）；页面「N 个会话在等」按其中不同的 sid 数。 */
export const todoWaiters = (data, tid) => data.rounds.filter((r) => r.wait === tid && !isFinished(r));
export const waitingSessions = (data, tid) => new Set(todoWaiters(data, tid).map((r) => r.sid || r.id)).size;
/** 目标下的轮次：挂了 goal 的，加上从这个目标下的待办派出去的。 */
export function goalRounds(data, gid) {
  const via = new Set((data.todos || []).filter((t) => (t.goal || []).includes(gid) && t.round).map((t) => t.round));
  return data.rounds.filter((r) => r.goal === gid || via.has(r.id));
}
/** 这一轮是从哪条待办派出去的（没有是 undefined）。 */
export const todoOfRound = (data, rid) => (data.todos || []).find((t) => t.round === rid && t.status === 'sent') || (data.todos || []).find((t) => t.round === rid);

function validateMine(data) {
  const str = (v) => typeof v === 'string' && v !== '';
  for (const k of ['goals', 'todos']) if (data[k] !== undefined && (!Array.isArray(data[k]) || !data[k].length)) fail(k + ' 必须是非空数组（没有条目就删掉这个字段）');
  const pids = new Set(data.projects.map((p) => p.id)), rids = new Set(data.rounds.map((r) => r.id));
  const goalIds = new Set(), todoIds = new Set();
  const common = (o, where, fields, max) => {
    if (!o || typeof o !== 'object') fail(where + ': 每条都必须是对象');
    if (!ID.test(o.id || '')) fail(where + ': id 必须是小写字母/数字/连字符(≤48)');
    for (const k of Object.keys(o)) if (!fields.includes(k)) fail(where + ': 没有字段 ' + k + '（可用: ' + fields.join(', ') + '）');
    for (const k of ['title', 'status', 'created', 'updated']) if (!str(o[k])) fail(where + ': 缺必填字段 ' + k);
    if (o.title.length > MINE_MAX.title) fail(where + ': 标题最多 ' + MINE_MAX.title + ' 字');
    if (o.why !== undefined && (!str(o.why) || o.why.length > MINE_MAX.why)) fail(where + ': why 是 1–' + MINE_MAX.why + ' 字');
    for (const k of ['created', 'updated', 'ended']) if (o[k] !== undefined && !isIso(o[k])) fail(where + ': ' + k + ' 要是 ISO 时间');
    if (o.due !== undefined && !isDay(o.due)) fail(where + ': due 要写成 YYYY-MM-DD: ' + o.due);
    if ((o.status === 'done' || o.status === 'dropped') !== (o.ended !== undefined)) fail(where + ': 完成 / 放弃的要有 ended，其它状态不能有');
    for (const [k, vals] of Object.entries(MINE_ENUMS)) if (o[k] !== undefined && !vals.includes(o[k])) fail(where + ': ' + k + ' 只能是 ' + vals.join(' | '));
    if (o.log !== undefined && (!Array.isArray(o.log) || !o.log.length || o.log.length > max)) fail(where + ': log 是 1–' + max + ' 条');
    for (const e of o.log || []) {
      if (!e || typeof e !== 'object' || !isIso(e.at)) fail(where + ': log 每条要有 at（ISO 时间）');
      if (e.note !== undefined && (!str(e.note) || e.note.length > MINE_MAX.note)) fail(where + ': log 的 note 是 1–' + MINE_MAX.note + ' 字');
    }
  };
  for (const g of data.goals || []) {
    const where = 'goal/' + ((g && g.id) || '?');
    common(g, where, GOAL_FIELDS, MINE_MAX.goalLog);
    if (goalIds.has(g.id)) fail(where + ': id 重复');
    goalIds.add(g.id);
    if (!GOAL_STATUS.includes(g.status)) fail(where + ': status 只能是 ' + GOAL_STATUS.join(' | '));
    for (const k of ['range', 'metric', 'unit']) if (g[k] !== undefined && !str(g[k])) fail(where + ': ' + k + ' 必须是非空字符串');
    if (g.metric !== undefined && g.metric.length > MINE_MAX.metric) fail(where + ': metric 最多 ' + MINE_MAX.metric + ' 字');
    if (g.unit !== undefined && g.unit.length > MINE_MAX.unit) fail(where + ': unit 最多 ' + MINE_MAX.unit + ' 字');
    for (const k of ['base', 'cur', 'target']) if (g[k] !== undefined && !Number.isFinite(g[k])) fail(where + ': ' + k + ' 必须是数');
    if (g.projs !== undefined) {
      if (!Array.isArray(g.projs) || !g.projs.length || new Set(g.projs).size !== g.projs.length) fail(where + ': projs 是不重复的项目 id 列表');
      for (const p of g.projs) if (!pids.has(p)) fail(where + ': 项目 ' + p + ' 不在 projects 里');
    }
    if (g.kr !== undefined) {
      if (!Array.isArray(g.kr) || !g.kr.length || g.kr.length > MINE_MAX.kr) fail(where + ': kr（关键结果）是 1–' + MINE_MAX.kr + ' 条');
      const ks = new Set();
      for (const k of g.kr) {
        if (!k || typeof k !== 'object' || !/^k\d+$/.test(k.id || '') || ks.has(k.id)) fail(where + ': 关键结果要有不重复的 id（k1、k2…）');
        ks.add(k.id);
        for (const f of Object.keys(k)) if (!['id', 'title', 'cur', 'target', 'done'].includes(f)) fail(where + ': 关键结果没有字段 ' + f + '（可用: id, title, cur, target, done）');
        if (!str(k.title) || k.title.length > MINE_MAX.krTitle) fail(where + ': 关键结果 ' + k.id + ' 的标题是 1–' + MINE_MAX.krTitle + ' 字');
        for (const f of ['cur', 'target']) if (k[f] !== undefined && !Number.isFinite(k[f])) fail(where + ': 关键结果 ' + k.id + ' 的 ' + f + ' 必须是数');
        if (k.done !== undefined && !isIso(k.done)) fail(where + ': 关键结果 ' + k.id + ' 的 done 要是 ISO 时间');
      }
    }
    for (const e of g.log || []) {
      for (const f of Object.keys(e)) if (!['at', 'cur', 'kr', 'note'].includes(f)) fail(where + ': 进度记录没有字段 ' + f + '（可用: at, cur, kr, note）');
      if (!Number.isFinite(e.cur)) fail(where + ': 进度记录要有 cur（数）');
      if (e.kr !== undefined && !/^k\d+$/.test(e.kr)) fail(where + ': 进度记录的 kr 要是关键结果 id');
    }
  }
  for (const t of data.todos || []) {
    const where = 'todo/' + ((t && t.id) || '?');
    common(t, where, TODO_FIELDS, MINE_MAX.todoLog);
    if (todoIds.has(t.id) || goalIds.has(t.id)) fail(where + ': id 重复');
    todoIds.add(t.id);
    if (!TODO_STATUS.includes(t.status)) fail(where + ': status 只能是 ' + TODO_STATUS.join(' | '));
    if (!TODO_SRC.includes(t.src)) fail(where + ': src 只能是 ' + TODO_SRC.join(' | '));
    if (t.eta !== undefined && (!t.eta || !DURATION.test(t.eta))) fail(where + ': eta 要写成时长，如 10m、45m、2h: ' + t.eta);
    if (t.today !== undefined && !isDay(t.today)) fail(where + ': today 要是 YYYY-MM-DD');
    if (t.goal !== undefined) {
      if (!Array.isArray(t.goal) || !t.goal.length || new Set(t.goal).size !== t.goal.length) fail(where + ': goal 是不重复的目标 id 列表');
      for (const g of t.goal) if (!goalIds.has(g)) fail(where + ': 目标 ' + g + ' 不在 goals 里（align goal ls <页> 看已有的）');
    }
    if (t.round !== undefined && !str(t.round)) fail(where + ': round 必须是轮次 id');
    if (t.status === 'sent' && !rids.has(t.round)) fail(where + ': 已派出的待办要挂在页面上的一轮（round=' + t.round + '）');
    if ((t.status === 'open' || t.status === 'doing') && t.round !== undefined) fail(where + ': 待办 / 在做的不挂轮次（round 只在派出后有）');
    for (const e of t.log || []) {
      for (const f of Object.keys(e)) if (!['at', 'ev', 'round', 'note'].includes(f)) fail(where + ': log 没有字段 ' + f + '（可用: at, ev, round, note）');
      if (!TODO_EV.includes(e.ev)) fail(where + ': log 的 ev 只能是 ' + TODO_EV.join(' | '));
    }
  }
  for (const r of data.rounds) {
    if (r.goal !== undefined && !goalIds.has(r.goal)) fail('round/' + r.id + ': goal ' + r.goal + ' 不在目标里（align goal ls <页> 看已有的）');
    if (r.wait !== undefined && !todoIds.has(r.wait)) fail('round/' + r.id + ': wait ' + r.wait + ' 不在待办里（align todo ls <页> --all 看已有的）');
  }
}

/** 新的待办 / 目标 id：t- / g- + 时间（36 进制）+ 序号，和页面上已有的待办、目标不重。 */
export function newMineId(data, prefix, t = Date.parse(nowIso())) {
  const have = new Set([...(data.todos || []), ...(data.goals || [])].map((x) => x.id));
  for (let i = 0; ; i++) { const id = prefix + '-' + t.toString(36) + (i ? '-' + i : ''); if (!have.has(id)) return id; }
}
function findTodo(data, ref) {
  const id = String(ref || '').split('/').pop();
  const t = (data.todos || []).find((x) => x.id === id);
  if (!t) fail('没有 id 为 ' + id + ' 的待办（align todo ls <页> --all 看已有的）');
  return t;
}
function findGoal(data, ref) {
  const id = String(ref || '').split('/').pop();
  const g = (data.goals || []).find((x) => x.id === id);
  if (!g) fail('没有 id 为 ' + id + ' 的目标（align goal ls <页> --all 看已有的）');
  return g;
}
function findKr(g, id) {
  const k = (g.kr || []).find((x) => x.id === id);
  if (!k) fail('goal/' + g.id + ' 没有关键结果 ' + id + '（有: ' + ((g.kr || []).map((x) => x.id).join(', ') || '无') + '）');
  return k;
}
const mineNum = (v, k) => { const n = Number(v); if (String(v).trim() === '' || !Number.isFinite(n)) fail(k + ' 要是数: ' + v); return n; };
const mineText = (v) => v.replace(/\r\n?/g, '\n').trim();
const idList = (v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
function todoLog(t, now, ev, extra = {}) {
  const e = { at: now, ev };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') e[k] = v;
  (t.log ||= []).push(e);
  if (t.log.length > MINE_MAX.todoLog) t.log = t.log.slice(-MINE_MAX.todoLog);
}
/** 改待办状态：完成 / 放弃写 ended，其余删；改回待办 / 在做时放掉所派轮次（log 里留着）。 */
function todoStatus(t, to, now, ev = TODO_EV_OF[to], extra = {}) {
  if (t.status === to) fail('todo/' + t.id + ' 已经是「' + TODO_LABEL[to] + '」');
  if (to === 'open' || to === 'doing') delete t.round;
  t.status = to;
  if (to === 'done' || to === 'dropped') t.ended = now; else delete t.ended;
  t.updated = now;
  todoLog(t, now, ev, extra);
}
function applyTodoKv(data, t, kv) {
  for (const [k, v] of kv) {
    if (!TODO_KV.includes(k)) fail('待办没有可写的字段 ' + k + '（可写: ' + TODO_KV.join(', ') + '；放进今天用 todo today，完成用 todo done，派出用 todo dispatch）');
    if (k === 'status') continue;
    if ((k === 'title' || k === 'src') && !v.trim()) fail(k + ' 不能为空');
    if (v === '') { delete t[k]; continue; }
    if (k === 'goal') { t.goal = idList(v).map((id) => findGoal(data, id).id); if (!t.goal.length) delete t.goal; continue; }
    t[k] = mineText(v);
  }
}
function applyGoalKv(data, g, kv) {
  for (const [k, v] of kv) {
    if (!GOAL_KV.includes(k)) fail('目标没有可写的字段 ' + k + '（可写: ' + GOAL_KV.join(', ') + '；记进度用 goal progress，关键结果用 goal kr）');
    if (k === 'status') continue;
    if (k === 'title' && !v.trim()) fail('title 不能为空');
    if (v === '') { delete g[k]; continue; }
    if (['base', 'cur', 'target'].includes(k)) { g[k] = mineNum(v, k); continue; }
    if (k === 'projs') { g.projs = [...new Set(idList(v).map((p) => projFromRef(data, p)))]; continue; }
    g[k] = mineText(v);
  }
}
function applyKrKv(k, kv, now) {
  for (const [f, v] of kv) {
    if (!['title', 'cur', 'target', 'done'].includes(f)) fail('关键结果只有 title= cur= target= done=true|false');
    if (f === 'title') { if (!v.trim()) fail('关键结果的 title 不能为空'); k.title = mineText(v); continue; }
    if (f === 'done') { if (v === 'true') k.done ||= now; else if (v === 'false' || v === '') delete k.done; else fail('done 只能是 true 或 false'); continue; }
    if (v === '') delete k[f]; else k[f] = mineNum(v, f);
  }
}
const statusArg = (kv) => kv.filter(([k]) => k === 'status').map(([, v]) => v).pop();
/** 写入时收尾（mutate 每次跑）：派出去的待办所在轮次 accepted → 完成，dropped → 回到待办。返回说明（接在命令输出后面）。 */
function settleTodos(data, now) {
  const out = [];
  for (const t of data.todos || []) {
    if (t.status !== 'sent') continue;
    const r = data.rounds.find((x) => x.id === t.round);
    if (!r) continue; // validateMine 报
    if (r.status === 'accepted') { todoStatus(t, 'done', now, 'done', { round: r.id, note: '所派轮次通过验收' }); t.round = r.id; out.push('待办 ' + t.id + ' 跟着轮次 ' + r.id + ' 通过 → 已完成'); }
    else if (r.status === 'dropped') { todoStatus(t, 'open', now, 'back', { round: r.id, note: '所派轮次放弃' }); out.push('轮次 ' + r.id + ' 放弃了，待办 ' + t.id + ' 回到待办'); }
  }
  return out;
}
/** 网页「我的」页签对一条待办能做的操作（api 19）：why(t) 返回不能做的原因，空串 = 能做。 */
const todoOpen = (t) => t.status === 'open' || t.status === 'doing';
const notOpen = (t) => (todoOpen(t) ? '' : '现在是「' + TODO_LABEL[t.status] + '」');
export const TODO_ACTIONS = {
  done: { label: '完成', why: notOpen },
  today: { label: '放进今天', why: (t) => notOpen(t) || (t.today ? '从 ' + t.today + ' 起已经在今天' : '') },
  untoday: { label: '移出今天', why: (t) => notOpen(t) || (t.today ? '' : '不在今天') },
  send: { label: '派出去做', why: notOpen },
  drop: { label: '放弃', why: notOpen },
  open: { label: '恢复', why: (t) => (t.status === 'done' || t.status === 'dropped' ? '' : '现在是「' + TODO_LABEL[t.status] + '」') },
};
/** answerBatch 写回待办操作：写回时再核一次状态（发送前后别处可能改过）。派出去做只在 log 里记一笔 send（不挂轮次），由 First Mate 跑 todo dispatch 派出。 */
function todoAnswer(d, now, p) {
  const t = (d.todos || []).find((x) => x.id === p.it.id);
  if (!t || TODO_ACTIONS[p.action].why(t)) fail('写回时待办 ' + p.it.id + ' 已不在或状态变了');
  const note = p.note || undefined;
  if (p.action === 'done') return todoStatus(t, 'done', now, 'done', { note });
  if (p.action === 'drop') return todoStatus(t, 'dropped', now, 'drop', { note });
  if (p.action === 'open') return todoStatus(t, 'open', now, 'open', { note });
  if (p.action === 'today') t.today = todayOf(now);
  else if (p.action === 'untoday') delete t.today;
  todoLog(t, now, p.action === 'send' ? 'send' : p.action, p.action === 'send' ? { note: ('在对齐页点了派出去做，等 First Mate 派' + (note ? '：' + note : '')).slice(0, MINE_MAX.note) } : {});
  t.updated = now;
}
/** answerBatch 写回目标操作：记进度和 goal progress 同一套（含关键结果），达成 / 放弃写 ended，恢复（网页撤销）回到进行中。 */
function goalAnswer(d, now, p) {
  const g = (d.goals || []).find((x) => x.id === p.it.id);
  if (!g || (p.action === 'open') !== (g.status !== 'doing')) fail('写回时目标 ' + p.it.id + ' 已不在或状态变了');
  if (p.action === 'open') { g.status = 'doing'; delete g.ended; g.updated = now; return; }
  if (p.action === 'progress') return mineOps['goal progress'](d, now, [g.id], [['cur', String(p.cur)], ...(p.note ? [['note', p.note]] : [])], p.kr ? { kr: p.kr } : {});
  g.status = p.action === 'done' ? 'done' : 'dropped';
  g.ended = g.updated = now;
}
/** 推荐「我来做」：推荐变成放进今天的待办（src=推荐，推荐理由写进 why），推荐标成已处理（acked）。rec take 和页面的 {kind:'rec-take'} 共用。 */
export function recTake(data, now, id, kv = []) {
  if (kv.some(([k]) => k === 'status' || k === 'src')) fail('rec take 不收 status= / src=（新待办是 open，来源是推荐）');
  const n = data.notes.find((x) => x.id === id);
  if (!n || !isRec(n)) fail('没有 id 为 ' + id + ' 的今日推荐（align rec ls <页> 看）');
  if (n.acked) fail('rec/' + id + ' 已经处理过（用户选过不做、派出去做或我来做）');
  const t = { id: newMineId(data, 't'), title: n.title, status: 'open', src: '推荐', created: now, updated: now, today: now.slice(0, 10) };
  if (n.body) t.why = (n.body + (n.src ? '\n来源：' + n.src : '')).slice(0, MINE_MAX.why);
  applyTodoKv(data, t, kv);
  t.log = [{ at: now, ev: 'rec', note: id }, { at: now, ev: 'today' }];
  (data.todos ||= []).push(t);
  n.acked = now;
  n.updated = now;
  return t;
}
const todayOf = (now) => now.slice(0, 10);
const dueNote = (due, today, { left = false } = {}) => {
  const d = dayDiff(due, today);
  return '截止 ' + due.slice(5) + (d > 0 ? ' 已过 ' + d + ' 天' : d === 0 ? ' 今天' : left ? ' 剩 ' + -d + ' 天' : '');
};
const TODO_GROUPS = [['今天', (t) => (t.status === 'open' || t.status === 'doing') && t.today], ['以后', (t) => (t.status === 'open' || t.status === 'doing') && !t.today],
  ['已派出', (t) => t.status === 'sent'], ['已完成', (t) => t.status === 'done'], ['已放弃', (t) => t.status === 'dropped']];
const pRank = (t) => (t.p ? Number(t.p.slice(1)) : 9);
/** todo ls：分组（今天 / 以后 / 已派出，--all 加已完成 / 已放弃），组内 在做 → 优先级 → 截止 → 加入时间；每条一行。 */
export function todoLines(data, flags = {}, now = nowIso()) {
  const today = todayOf(now), goals = new Map((data.goals || []).map((g) => [g.id, g]));
  let list = data.todos || [];
  if (flags.goal !== undefined) { const g = findGoal(data, flags.goal); list = list.filter((t) => (t.goal || []).includes(g.id)); }
  const rows = [];
  for (const [label, ok] of TODO_GROUPS) {
    if (!flags.all && (label === '已完成' || label === '已放弃')) continue;
    const group = list.filter(ok).sort((a, b) => (label === '已完成' || label === '已放弃' ? (b.ended || '').localeCompare(a.ended || '')
      : (b.status === 'doing') - (a.status === 'doing') || pRank(a) - pRank(b) || (a.due || '9').localeCompare(b.due || '9') || a.created.localeCompare(b.created)));
    for (const t of group) {
      const facts = [t.status === 'doing' ? '在做' : '', [t.p, t.urg].filter(Boolean).join(' · '), t.energy ? t.energy + '能量' : '', t.eta || '',
        t.due && !['done', 'dropped'].includes(t.status) ? dueNote(t.due, today) : '', label === '今天' && t.today < today ? '从 ' + t.today.slice(5) + ' 起在今天' : ''].filter(Boolean);
      const tail = [(t.goal || []).map((g) => '目标「' + goals.get(g).title + '」').join(''), waitingSessions(data, t.id) ? waitingSessions(data, t.id) + ' 个会话在等' : '',
        t.status === 'sent' ? '派给轮次 ' + t.round : '', t.ended ? (label === '已完成' ? '完成于 ' : '放弃于 ') + t.ended.slice(5, 16).replace('T', ' ') : ''].filter(Boolean);
      rows.push('todo/' + t.id + ' [' + label + ']' + (facts.length ? ' [' + facts.join(' ') + ']' : '') + ' ' + t.title + tail.map((s) => ' · ' + s).join(''));
    }
  }
  return rows.join('\n') || '（没有待办）';
}
/** goal ls：进行中的目标（--all 含达成 / 放弃），每条一行：范围、截止、进度、关键结果、待办数、轮次数。 */
export function goalLines(data, flags = {}, now = nowIso()) {
  const today = todayOf(now);
  const list = (data.goals || []).filter((g) => flags.all || g.status === 'doing');
  return list.map((g) => {
    const head = [g.range, g.due && g.status === 'doing' ? dueNote(g.due, today, { left: true }) : g.due ? '截止 ' + g.due.slice(5) : ''].filter(Boolean);
    const pct = goalPct(g);
    const prog = Number.isFinite(g.cur) || Number.isFinite(g.target)
      ? [g.metric, (Number.isFinite(g.cur) ? g.cur : '—') + (Number.isFinite(g.target) ? ' / ' + g.target : '') + (g.unit ? ' ' + g.unit : '') + (pct === null ? '' : '（' + pct + '%）')].filter(Boolean).join(' ') : '';
    const todos = (data.todos || []).filter((t) => (t.goal || []).includes(g.id));
    const rs = goalRounds(data, g.id);
    const cnt = (f) => rs.filter(f).length;
    const tail = [prog, g.kr ? '关键结果 ' + g.kr.filter(krDone).length + '/' + g.kr.length : '',
      todos.length ? '待办 ' + todos.filter((t) => ['open', 'doing'].includes(t.status)).length + '（已派出 ' + todos.filter((t) => t.status === 'sent').length + '，已完成 ' + todos.filter((t) => t.status === 'done').length + '）' : '',
      rs.length ? '轮次 进行中 ' + cnt((r) => !isFinished(r)) + ' · 待验收 ' + cnt((r) => r.status === 'done') + ' · 已结束 ' + cnt(isClosed) : ''].filter(Boolean);
    return 'goal/' + g.id + ' [' + GOAL_LABEL[g.status] + ']' + (head.length ? ' [' + head.join(' ') + ']' : '') + ' ' + g.title + tail.map((s) => ' · ' + s).join('');
  }).join('\n') || '（没有目标）';
}
/** align day：某一天的轮次和做完的待办（收工 worklog 的素材，2026-11-03 personal-ops 搬到对齐页第 3 轮）。只读。
 *  完成 = 当天进入 done / accepted（ended 在当天）；放弃 = 当天进入 dropped；新开 = 当天开的、当天没结束；
 *  在做 = 之前开的、现在还没结束、当天有更新（按现在的状态算，查过去的日子时只作参考）；待办 = 当天完成的（done，ended 在当天）。 */
export function dayReport(data, day) {
  const on = (ts) => !!ts && ts.slice(0, 10) === day;
  const row = (r) => ({ id: r.id, title: r.title, stitle: r.stitle, proj: projTitle(data, r.proj), status: r.status, started: r.started, ended: r.ended, result: r.result, state: r.state, sid: r.sid });
  const rs = data.rounds || [];
  const byT = (k) => (a, b) => (a[k] || '').localeCompare(b[k] || '');
  return {
    day,
    done: rs.filter((r) => on(r.ended) && (r.status === 'done' || r.status === 'accepted')).sort(byT('ended')).map(row),
    dropped: rs.filter((r) => on(r.ended) && r.status === 'dropped').sort(byT('ended')).map(row),
    started: rs.filter((r) => on(r.started) && !on(r.ended)).sort(byT('started')).map(row),
    doing: rs.filter((r) => !isFinished(r) && (r.started || '').slice(0, 10) < day && on(r.updated)).sort(byT('started')).map(row),
    todos: (data.todos || []).filter((t) => t.status === 'done' && on(t.ended)).sort(byT('ended')).map((t) => ({ id: t.id, title: t.title, ended: t.ended, round: t.round, why: t.why })),
  };
}
const DAY_STATUS = { done: '待验收', accepted: '已通过', dropped: '已放弃', doing: '进行中', paused: '暂缓' };
export function dayLines(rep) {
  const hm = (ts) => (ts ? ts.slice(11, 16) : '');
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  const rline = (r, ts) => '  round/' + r.id + ' [' + r.proj + '] [' + (DAY_STATUS[r.status] || r.status) + '] ' + r.title + (ts ? ' · ' + ts : '') + (r.result ? ' · 结果：' + cut(r.result, 120) : '');
  const sec = (label, list, f) => (list.length ? [label + ' ' + list.length + '：', ...list.map(f)] : []);
  const L = [rep.day + ' 对齐页',
    ...sec('完成的轮次', rep.done, (r) => rline(r, hm(r.ended) + ' 交')),
    ...sec('新开、还在做的轮次', rep.started, (r) => rline(r, hm(r.started) + ' 开')),
    ...sec('之前开、今天有更新的轮次', rep.doing, (r) => rline(r, '')),
    ...sec('放弃的轮次', rep.dropped, (r) => rline(r, hm(r.ended))),
    ...sec('做完的待办', rep.todos, (t) => '  todo/' + t.id + ' ' + t.title + ' · ' + hm(t.ended) + ' 完成' + (t.round ? '（派给轮次 ' + t.round + '）' : ''))];
  return L.length > 1 ? L.join('\n') : rep.day + ' 对齐页没有轮次或待办的记录';
}
/** 待办 / 目标的写命令（todo ls / goal ls / todo dispatch 在 main 里单独处理）。 */
export const mineOps = {
  'todo add'(data, now, args, kv, flags) {
    if (args.length) fail("用法: todo add <页> 'title=…' [p=… urg=… energy=… eta=… due=… goal=… why=… src=…] [--today]");
    if (kv.some(([k]) => k === 'status')) fail('新待办都是 open：在做用 todo set <页> <id> status=doing');
    const t = { id: newMineId(data, 't'), title: '', status: 'open', src: 'First Mate', created: now, updated: now };
    applyTodoKv(data, t, kv);
    if (!t.title) fail("缺 'title=<要做的事>'");
    t.log = [{ at: now, ev: 'add' }];
    if (flags.today) { t.today = todayOf(now); todoLog(t, now, 'today'); }
    (data.todos ||= []).push(t);
    return '加了 todo/' + t.id + (t.today ? '（放进今天）' : '');
  },
  'todo set'(data, now, [id, ...more], kv) {
    if (!id || more.length || !kv.length) fail('用法: todo set <页> <id> k=v…');
    const t = findTodo(data, id);
    applyTodoKv(data, t, kv);
    const st = statusArg(kv);
    if (st !== undefined) {
      if (!['open', 'doing', 'dropped'].includes(st)) fail('todo set 的 status 只能是 open | doing | dropped（完成用 todo done，派出用 todo dispatch）');
      if (t.status === 'sent') fail('todo/' + t.id + ' 已派成轮次 ' + t.round + '：那一轮通过时自动完成、放弃时回到待办；要收回就 align round set ' + psArg(data.name) + ' ' + t.round + ' status=dropped');
      todoStatus(t, st, now);
    }
    t.updated = now;
    return '改了 todo/' + t.id + ' 的 ' + [...new Set(kv.map(([k]) => k))].join(',');
  },
  'todo done'(data, now, [id, ...more], kv) {
    if (!id || more.length || kv.some(([k]) => k !== 'note')) fail('用法: todo done <页> <id> [note=…]');
    const t = findTodo(data, id);
    todoStatus(t, 'done', now, 'done', { note: (kv.find(([k]) => k === 'note') || [])[1] });
    const waiters = todoWaiters(data, t.id);
    return ['todo/' + t.id + ' → 已完成', ...waiters.map((r) => '在等它的轮次 ' + r.id + (r.sid ? '（会话 ' + r.sid + '）' : '') + '：通知那个会话继续，再 align round set ' + psArg(data.name) + ' ' + r.id + ' wait=')].join('\n');
  },
  'todo today'(data, now, ids, kv, flags) {
    if (!ids.length || kv.length) fail('用法: todo today <页> <id> [<id>…] [--off]');
    const out = [];
    for (const id of ids) {
      const t = findTodo(data, id);
      if (flags.off) {
        if (!t.today) fail('todo/' + t.id + ' 不在今天');
        delete t.today; todoLog(t, now, 'untoday');
      } else {
        if (!['open', 'doing'].includes(t.status)) fail('todo/' + t.id + ' 现在是「' + TODO_LABEL[t.status] + '」，只有待办 / 在做的能放进今天');
        if (t.today) fail('todo/' + t.id + ' 从 ' + t.today + ' 起已经在今天');
        t.today = todayOf(now); todoLog(t, now, 'today');
      }
      t.updated = now;
      out.push(t.id);
    }
    return (flags.off ? '移出今天：' : '放进今天：') + out.join('、');
  },
  'goal add'(data, now, args, kv) {
    if (args.length) fail("用法: goal add <页> 'title=…' [range=… metric=… unit=… base=… cur=… target=… due=… why=… projs=…]");
    if (kv.some(([k]) => k === 'status')) fail('新目标都是进行中（doing）');
    const g = { id: newMineId(data, 'g'), title: '', status: 'doing', created: now, updated: now };
    applyGoalKv(data, g, kv);
    if (!g.title) fail("缺 'title=<目标>'");
    (data.goals ||= []).push(g);
    return '加了 goal/' + g.id;
  },
  'goal set'(data, now, [id, ...more], kv) {
    if (!id || more.length || !kv.length) fail('用法: goal set <页> <id> k=v…');
    const g = findGoal(data, id);
    applyGoalKv(data, g, kv);
    const st = statusArg(kv);
    if (st !== undefined) {
      if (!['doing', 'dropped'].includes(st)) fail('goal set 的 status 只能是 doing | dropped（达成用 goal done）');
      if (g.status === st) fail('goal/' + g.id + ' 已经是「' + GOAL_LABEL[st] + '」');
      g.status = st;
      if (st === 'doing') delete g.ended; else g.ended = now;
    }
    g.updated = now;
    return '改了 goal/' + g.id + ' 的 ' + [...new Set(kv.map(([k]) => k))].join(',');
  },
  'goal done'(data, now, [id, ...more], kv) {
    if (!id || more.length || kv.some(([k]) => k !== 'note')) fail('用法: goal done <页> <id> [note=…]');
    const g = findGoal(data, id);
    if (g.status === 'done') fail('goal/' + g.id + ' 已经达成');
    g.status = 'done';
    g.ended = g.updated = now;
    const note = (kv.find(([k]) => k === 'note') || [])[1];
    if (note && note.trim()) {
      if (!Number.isFinite(g.cur)) fail('goal done 的 note= 记进进度记录，要先有当前值（goal progress … cur=）；不记就去掉 note=');
      (g.log ||= []).push({ at: now, cur: g.cur, note: mineText(note) });
    }
    return 'goal/' + g.id + ' → 达成';
  },
  'goal progress'(data, now, [id, ...more], kv, flags) {
    if (!id || more.length || kv.some(([k]) => k !== 'cur' && k !== 'note')) fail('用法: goal progress <页> <id> cur=<数> [note=…] [--kr <k1>]');
    const g = findGoal(data, id);
    const raw = kv.filter(([k]) => k === 'cur').map(([, v]) => v).pop();
    if (raw === undefined) fail('缺 cur=<当前值>');
    const cur = mineNum(raw, 'cur'), note = (kv.find(([k]) => k === 'note') || [])[1];
    let what = '目标';
    if (flags.kr !== undefined) { const k = findKr(g, flags.kr); k.cur = cur; what = '关键结果 ' + k.id + '「' + k.title + '」'; }
    else g.cur = cur;
    const e = { at: now, cur };
    if (flags.kr !== undefined) e.kr = flags.kr;
    if (note && note.trim()) e.note = mineText(note);
    (g.log ||= []).push(e);
    if (g.log.length > MINE_MAX.goalLog) g.log = g.log.slice(-MINE_MAX.goalLog);
    g.updated = now;
    const pct = flags.kr === undefined ? goalPct(g) : null;
    return 'goal/' + g.id + ' 记了进度：' + what + ' → ' + cur + (pct === null ? '' : '（' + pct + '%）');
  },
  'goal kr'(data, now, [id, op, kid, ...more], kv) {
    const usage = "用法: goal kr <页> <目标 id> add 'title=…' [cur=… target=…] | set <k1> [title=… cur=… target=… done=true|false] | del <k1>";
    if (!id || !['add', 'set', 'del'].includes(op) || more.length) fail(usage);
    const g = findGoal(data, id);
    let msg;
    if (op === 'add') {
      if (kid) fail(usage);
      if ((g.kr || []).length >= MINE_MAX.kr) fail('一个目标最多 ' + MINE_MAX.kr + ' 条关键结果');
      const k = { id: 'k' + (Math.max(0, ...(g.kr || []).map((x) => Number(x.id.slice(1)))) + 1), title: '' };
      applyKrKv(k, kv, now);
      if (!k.title) fail("缺 'title=<关键结果>'");
      (g.kr ||= []).push(k);
      msg = '加了关键结果 ' + k.id;
    } else {
      if (!kid) fail(usage);
      const k = findKr(g, kid);
      if (op === 'set') { if (!kv.length) fail(usage); applyKrKv(k, kv, now); msg = '改了关键结果 ' + k.id; }
      else { if (kv.length) fail(usage); g.kr = g.kr.filter((x) => x !== k); if (!g.kr.length) delete g.kr; msg = '删了关键结果 ' + k.id; }
    }
    g.updated = now;
    return 'goal/' + g.id + ' ' + msg;
  },
  'rec take'(data, now, [id, ...more], kv) {
    if (!id || more.length) fail('用法: rec take <页> <rec id> [p=… urg=… energy=… eta=… due=… goal=…]');
    const t = recTake(data, now, id, kv);
    return 'rec/' + id + ' → 我来做：加了今天的待办 todo/' + t.id;
  },
};
/** 页面上还没有待办和目标时，第一次写进去之前确认 3080 读得了（旧插件代码看到顶层 todos / goals 整页报错）。 */
export async function needMineApi(dshUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080') {
  const url = new URL(ROUTE_PREFIX + '/health', dshUrl).href;
  let j;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); j = await r.json(); }
  catch (e) { fail('第一次往页面里写待办 / 目标前要确认 3080 读得了它们，探测 ' + url + ' 失败（' + e.message + '）：3080 没起来或对齐页插件没加载'); }
  if (!(typeof j.api === 'number' && j.api >= MINE_API)) fail(url + ' 报 api=' + j.api + '：3080 内存里还是旧插件代码，页面里有待办 / 目标它会整页读不出来；3080 重启后再跑这条命令');
}
const hasMine = (d) => !!(d.todos || d.goals);
/** personal-ops → 对齐页的枚举对照（report.md「映射」）。 */
const PO_TASK_STATUS = { '待办': 'open', '进行中': 'doing', '已完成': 'done', '已取消': 'dropped' };
const PO_GOAL_STATUS = { '进行中': 'doing', '已完成': 'done', '放弃': 'dropped' };
const PO_DIR = () => process.env.PO_DATA_DIR || 'D:/llm-wiki/data/personal-ops';
/** 分钟 → 时长字符串（90 → 1h30m）。 */
export const minutesToEta = (m) => { const h = Math.floor(m / 60), r = m % 60; return (h ? h + 'h' : '') + (r ? r + 'm' : ''); };
/**
 * import-po：把 personal-ops 的任务、目标、进度快照换算成待办和目标（纯函数，不写文件）。返回 {goals, todos, lines}；lines 是预演时逐条列出的「怎么导」。
 * 子目标（parentGoalId）导成父目标的关键结果，进度快照导成目标 log；没有对应字段又有值的（任务的依赖 / 子任务）直接报错，不悟悟丢。
 */
export function poToMine(po, data, now, { openOnly = false } = {}) {
  const { tasks = [], goals = [], progress = [] } = po;
  const lines = [], offset = now.slice(19), today = todayOf(now);
  const ids = { todos: [], goals: [] };
  const scratch = { todos: [...(data.todos || [])], goals: [...(data.goals || [])] };
  const mk = (prefix) => { const id = newMineId(scratch, prefix); ids[prefix === 't' ? 'todos' : 'goals'].push(id); scratch[prefix === 't' ? 'todos' : 'goals'].push({ id }); return id; };
  const day = (v, what) => { if (v == null) return undefined; const d = String(v).slice(0, 10); if (!isDay(d)) fail(what + ' 的日期读不懂: ' + v); return d; };
  const top = goals.filter((g) => !g.parentGoalId), kids = goals.filter((g) => g.parentGoalId);
  const goalMap = new Map(), krMap = new Map(), outGoals = [];
  for (const g of top) {
    const st = PO_GOAL_STATUS[g.status];
    if (!st) fail('personal-ops 目标「' + g.title + '」的状态不认识: ' + g.status);
    const x = { id: mk('g'), title: g.title, status: st, created: now, updated: now };
    if (g.timeRange) x.range = g.timeRange;
    if (g.metric) x.metric = g.metric;
    for (const [a, b] of [['baseline', 'base'], ['current', 'cur'], ['target', 'target']]) if (Number.isFinite(g[a])) x[b] = g[a];
    if (g.deadline) x.due = day(g.deadline, '目标「' + g.title + '」的 deadline');
    const why = [g.description, g.area ? '领域：' + g.area : ''].filter(Boolean).join('\n');
    if (why) x.why = why;
    if (st !== 'doing') x.ended = now;
    goalMap.set(g.id, x);
    outGoals.push(x);
    lines.push('goal ' + x.id + ' ← [' + g.status + '] ' + g.title);
  }
  for (const g of kids) {
    const p = goalMap.get(g.parentGoalId);
    if (!p) fail('personal-ops 子目标「' + g.title + '」的上级 ' + g.parentGoalId + ' 不是顶层目标（只支持一层嵌套）');
    const k = { id: 'k' + ((p.kr || []).length + 1), title: g.title };
    if (Number.isFinite(g.current)) k.cur = g.current;
    if (Number.isFinite(g.target)) k.target = g.target;
    if (g.status === '已完成') k.done = now;
    (p.kr ||= []).push(k);
    krMap.set(g.id, [p, k]);
    lines.push('  关键结果 ' + p.id + '/' + k.id + ' ← 子目标 ' + g.title);
  }
  for (const s of [...progress].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const at = day(s.date, '进度快照') + 'T00:00:00' + offset;
    const e = { at, cur: s.current };
    if (s.note) e.note = String(s.note).slice(0, MINE_MAX.note);
    let g = goalMap.get(s.goalId);
    if (!g && krMap.has(s.goalId)) { const [p, k] = krMap.get(s.goalId); g = p; e.kr = k.id; }
    if (!g) fail('进度快照的目标 ' + s.goalId + ' 不在 goals.json 里');
    (g.log ||= []).push(e);
  }
  if (progress.length) lines.push('进度快照 ' + progress.length + ' 条 → 目标的进度记录');
  const outTodos = [];
  for (const t of tasks) {
    const st = PO_TASK_STATUS[t.status];
    if (!st) fail('personal-ops 任务「' + t.title + '」的状态不认识: ' + t.status);
    if (openOnly && (st === 'done' || st === 'dropped')) continue;
    if ((t.blockedBy || []).length || t.parentTaskId) fail('personal-ops 任务「' + t.title + '」有依赖或上级任务，对齐页没有这两个字段：先在 personal-ops 里去掉再导');
    const x = { id: mk('t'), title: t.title, status: st, src: '导入' };
    if (t.importance) x.p = t.importance;
    if (t.urgency) x.urg = t.urgency;
    if (t.energy) x.energy = t.energy;
    if (Number.isFinite(t.estimatedMinutes) && t.estimatedMinutes > 0) x.eta = minutesToEta(t.estimatedMinutes);
    if (t.deadline) x.due = day(t.deadline, '任务「' + t.title + '」的 deadline');
    const g = (t.goalIds || []).map((id) => { const m = goalMap.get(id) || (krMap.get(id) || [])[0]; if (!m) fail('任务「' + t.title + '」关联的目标 ' + id + ' 不在 goals.json 里'); return m.id; });
    if (g.length) x.goal = [...new Set(g)];
    // 「✅ 今天执行」→ 放进今天（只对没做完的）；「🤖 AI候选」按普通待办导入，理由留在说明里
    if (t.todayGroup === '✅ 今天执行' && (st === 'open' || st === 'doing')) x.today = today;
    if (t.description) { if (t.description.length > MINE_MAX.why) fail('任务「' + t.title + '」的说明超过 ' + MINE_MAX.why + ' 字'); x.why = t.description; }
    x.created = x.updated = now;
    if (st === 'done' || st === 'dropped') x.ended = t.completedAt && isIso(t.completedAt) ? t.completedAt : now;
    x.log = [{ at: now, ev: 'import', note: '从 personal-ops 导入（' + t.id + '）' }];
    outTodos.push(x);
    lines.push('todo ' + x.id + ' ← [' + t.status + (t.todayGroup ? ' · ' + t.todayGroup : '') + '] ' + t.title);
  }
  return { goals: outGoals, todos: outTodos, lines };
}
async function importPo(ref, flags) {
  const file = resolvePage(ref);
  const dir = path.resolve(expandHome(flags.dir || PO_DIR()));
  const readItems = (n) => {
    const f = path.join(dir, n + '.json');
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { fail('读不到 ' + f + ': ' + e.message); }
    if (!j || !Array.isArray(j.items)) fail(f + ' 不是 {items:[…]}');
    return j.items;
  };
  const po = { tasks: readItems('tasks'), goals: readItems('goals'), progress: readItems('progress') };
  const d0 = readPage(file);
  need3(d0);
  if ((d0.todos || []).some((t) => (t.log || []).some((e) => e.ev === 'import'))) fail('页面上已经有从 personal-ops 导入的待办，不再导一遍');
  const cnt = (st) => po.tasks.filter((t) => t.status === st).length;
  const head = 'personal-ops（' + dir + '）：任务 ' + po.tasks.length + '（待办 ' + cnt('待办') + '、进行中 ' + cnt('进行中') + '、已完成 ' + cnt('已完成') + '、已取消 ' + cnt('已取消') + '），目标 ' + po.goals.length + '，进度快照 ' + po.progress.length + '；日程块和 rules.json 不导';
  if (!flags.write) {
    const r = poToMine(po, d0, nowIso(), { openOnly: !!flags['open-only'] });
    return ['预演（没写入；加 --write 才写进页面）：' + head, '会加待办 ' + r.todos.length + ' 条、目标 ' + r.goals.length + ' 个', ...r.lines].join('\n');
  }
  if (!hasMine(d0)) await probes.mineApi();
  const { msg } = mutate(file, (d, now) => {
    need3(d);
    const r = poToMine(po, d, now, { openOnly: !!flags['open-only'] });
    if (r.goals.length) (d.goals ||= []).push(...r.goals);
    if (r.todos.length) (d.todos ||= []).push(...r.todos);
    return '导入了待办 ' + r.todos.length + ' 条、目标 ' + r.goals.length + ' 个（' + head + '）';
  });
  return msg + ' → ' + file;
}

// ---- 页面定位与原子写 -----------------------------------------------------------------------
export function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function writeRegistry(reg) {
  fs.mkdirSync(STORE, { recursive: true });
  const tmp = REGISTRY + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  renameOver(tmp, REGISTRY);
}
export function resolvePage(ref) {
  if (!ref) fail('缺 <页>: 登记名或页面文件路径');
  if (/\.html?$/i.test(ref)) return path.resolve(ref);
  const reg = readRegistry();
  if (!reg[ref]) fail('没有登记名为 ' + ref + ' 的页面（已登记: ' + (Object.keys(reg).join(', ') || '无') + '）');
  return reg[ref];
}

/** Windows 上目标文件刚被别的进程（杀毒、索引、文件监视）短暂打开时 rename 报 EPERM/EBUSY/EACCES，
 *  同 graceful-fs 的做法：只对这三种错误等一会儿重试同一个 rename，约 3 秒后仍失败就删临时文件、原样抛错。 */
function renameOver(tmp, file) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(tmp, file); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 30) { fs.rmSync(tmp, { force: true }); throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** fn(data) 在副本上改并返回说明；校验通过且文件没被别人改过才写。fn 可以就地把整份数据换成另一版本（migrate）。 */
export function mutate(file, fn, now = nowIso(), { touch = true } = {}) {
  const before = fs.readFileSync(file);
  const data = parsePage(before.toString('utf8'));
  let msg = fn(data, now);
  if (touch) data.updated = now;
  if (data.version === 3) {
    settleBtw(data, now);
    // 派给会话的待办跟着轮次收尾（api 17）：说明接在命令输出后面
    const settled = settleTodos(data, now);
    if (settled.length && typeof msg === 'string') msg = (msg ? msg + '；' : '') + settled.join('；');
  }
  prune(data);
  validate(data);
  const out = render(data);
  if (sha(fs.readFileSync(file)) !== sha(before)) fail('页面在这期间被改过，没有写入；重跑一次即可');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, out);
  renameOver(tmp, file);
  return { msg, data };
}

// ---- 参数 ---------------------------------------------------------------------------------
const BOOL_FLAGS = new Set(['dry-run', 'force', 'pending', 'json', 'no-check-sid', 'no-session', 'new', 'help', 'all', 'off', 'today', 'write', 'open-only']);
export function parseArgs(argv) { // k=v 的字段名可带数字（eta75）和驼峰（timeoutHigh）
  const pos = [], kv = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      if (BOOL_FLAGS.has(a.slice(2))) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) fail(a + ' 需要一个值');
      flags[a.slice(2)] = argv[++i];
    }
    else if (/^[a-z][a-zA-Z0-9]*=/.test(a)) { const j = a.indexOf('='); kv.push([a.slice(0, j), a.slice(j + 1)]); }
    else pos.push(a);
  }
  return { pos, kv, flags };
}

/** v8 数字卡：kpi=标签::数值[::对比值]，可重复，最多 4 个；页面正文顶部按它画数字卡（填了就不再从正文里自动挑）。kpi= 清空。 */
const KPI_MAX = 4, KPI_LABEL_MAX = 12;
const KPI_HINT = 'kpi 要写成 kpi="标签::数值[::对比值]"，如 kpi="显存::15.2 / 16.3 GB"、kpi="错字率::9.2%::47.6%"';
function checkKpi(it, where) {
  if (it.kpi === undefined) return;
  if (!Array.isArray(it.kpi) || !it.kpi.length || it.kpi.length > KPI_MAX) fail(where + ': kpi 要 1–' + KPI_MAX + ' 个（' + KPI_HINT + '）');
  for (const k of it.kpi) {
    if (!k || typeof k.label !== 'string' || !k.label || typeof k.value !== 'string' || !k.value || (k.from !== undefined && (typeof k.from !== 'string' || !k.from)) || Object.keys(k).some((x) => !['label', 'value', 'from'].includes(x))) fail(where + ': ' + KPI_HINT);
    if (k.label.length > KPI_LABEL_MAX) fail(where + ': kpi 的标签最多 ' + KPI_LABEL_MAX + ' 个字: ' + k.label);
  }
}
function applyKv(it, kv) {
  const keys = [];
  const kpis = kv.filter(([k]) => k === 'kpi');
  if (kpis.length) {
    if (kpis.length === 1 && kpis[0][1] === '') delete it.kpi;
    else it.kpi = kpis.map(([, v]) => {
      const p = v.split('::').map((x) => x.trim());
      if (p.length < 2 || p.length > 3 || !p[0] || !p[1] || (p.length === 3 && !p[2])) fail(KPI_HINT + ': ' + v);
      return p.length === 3 ? { label: p[0], value: p[1], from: p[2] } : { label: p[0], value: p[1] };
    });
    keys.push('kpi');
  }
  const opts = kv.filter(([k]) => k === 'opt');
  if (opts.length) {
    it.opt = opts.map(([, v]) => {
      const j = v.indexOf('::');
      if (j < 0) fail('opt 要写成 opt="选项::后果": ' + v);
      // 第三段是作用范围（api 7）：选项::后果::once|project|always，once 是缺省、不存
      const rest = v.slice(j + 2), sc = rest.match(/^([\s\S]*)::(once|project|always)$/);
      const o = { label: v.slice(0, j).trim(), effect: (sc ? sc[1] : rest).trim() };
      if (sc && sc[2] !== 'once') o.scope = sc[2];
      return o;
    });
    keys.push('opt');
  }
  for (const [k, v] of kv) {
    if (k === 'opt' || k === 'kpi') continue;
    if (['id', 'sec', 'updated'].includes(k)) fail(k + ' 由 CLI 维护，不能直接改');
    if (v === '') delete it[k]; else it[k] = v;
    keys.push(k);
  }
  return keys;
}

const find = (data, ref) => {
  const id = ref.includes('/') ? ref.split('/')[1] : ref;
  const it = data.items.find((x) => x.id === id);
  if (!it) fail('没有 id 为 ' + id + ' 的条目');
  if (ref.includes('/') && ref.split('/')[0] !== it.sec) fail(id + ' 在 ' + it.sec + ' 区块，不在 ' + ref.split('/')[0]);
  return it;
};
const crowd = (data, sec) => {
  const n = data.items.filter((x) => x.sec === sec).length;
  return sec !== 'done' && n > 5 ? '（' + SECS[sec] + '已有 ' + n + ' 条，页面只展开前 5 条）' : '';
};

// ---- 版本 2 操作 ----------------------------------------------------------------------------
export const ops = {
  add(data, now, [sec, id], kv) {
    if (!SECS[sec]) fail('区块必须是 ' + Object.keys(SECS).join(' | '));
    if (!id) fail('用法: add <页> <区块> <id> k=v ...');
    if (data.items.some((x) => x.id === id)) fail('id ' + id + ' 已存在');
    const it = { id, sec };
    applyKv(it, kv);
    if (sec === 'decide' && !it.status) it.status = 'open';
    if (!it.proj) it.proj = data.proj || DEFAULT_PROJ;
    it.updated = now;
    data.items.push(it);
    return '加了 ' + sec + '/' + id + crowd(data, sec);
  },
  set(data, now, [ref], kv) {
    if (!ref || !kv.length) fail('用法: set <页> <id> k=v ...');
    const it = find(data, ref);
    const keys = applyKv(it, kv);
    it.updated = now;
    return '改了 ' + it.sec + '/' + it.id + ' 的 ' + keys.join(',');
  },
  done(data, now, [ref], kv) {
    if (!ref) fail('用法: done <页> <id> [result=...]');
    const it = find(data, ref);
    if (it.sec === 'done' || it.sec === 'note') fail(it.sec + '/' + it.id + ' 不能移到最近完成');
    const from = it.sec;
    const keep = { id: it.id, sec: 'done', title: it.title };
    for (const k of ['proj', 'src', 'href']) if (it[k]) keep[k] = it[k];
    if (from === 'decide') {
      if (it.choice !== undefined) keep.choice = it.choice;
      if (it.reply) keep.reply = it.reply;
    }
    if (from === 'doing' && it.state) keep.result = it.state;
    applyKv(keep, kv);
    if (from === 'decide' && keep.choice === undefined && !keep.result) fail('decide/' + it.id + ' 还没有答复：带上 choice=<选项名> 或 result=<结论>');
    keep.updated = now;
    data.items[data.items.indexOf(it)] = keep;
    return from + '/' + it.id + ' → done/' + it.id;
  },
  del(data, now, [ref]) {
    if (!ref) fail('用法: del <页> <id>');
    const it = find(data, ref);
    data.items.splice(data.items.indexOf(it), 1);
    return '删了 ' + it.sec + '/' + it.id;
  },
  meta(data, now, pos, kv) {
    if (!kv.length) fail('用法: meta <页> k=v ...（' + META.join(' | ') + '）');
    for (const [k, v] of kv) {
      if (!META.includes(k)) fail('页面字段只有 ' + META.join(' | '));
      if (k === 'title' && !v) fail('title 不能为空');
      if (v === '') delete data[k]; else data[k] = v;
    }
    return '改了 页面 的 ' + kv.map(([k]) => k).join(',');
  },
};

export function list(data, [sec], kv) {
  if (sec && !SECS[sec]) fail('区块必须是 ' + Object.keys(SECS).join(' | '));
  const rows = data.items.filter((it) => (!sec || it.sec === sec) && kv.every(([k, v]) => (it[k] ?? '') === v));
  return rows.map((it) => it.sec + '/' + it.id + ' [' + it.proj + ']' + (it.status ? ' [' + it.status + ']' : '') + (it.who ? ' [等' + (it.who === 'you' ? '你' : 'agent') + ']' : '') + ' ' + it.title + ' · ' + (it.updated || '').slice(5, 16).replace('T', ' ')).join('\n') || '（没有匹配的条目）';
}

// ---- DSH workspace 表（项目来源，只读） -------------------------------------------------------
const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
/** 路径规范化比较用：展开 ~、resolve、去尾部分隔符、win32 不分大小写。 */
export function normPath(p) {
  const s = path.resolve(expandHome(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
const isPathLike = (s) => /[\\/]/.test(s) || s.startsWith('~') || path.isAbsolute(s);

/** [{id, title, cwd, sessionIds}]；读不到或形状不对直接报错。 */
export function readWorkspaces(file = process.env.ALIGN_WORKSPACES || path.join(DSH_HOME, 'storages', 'workspace.json')) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail('读不到 workspace 表 ' + file + ': ' + e.message); }
  const t = j && j.tables && j.tables.workspaces;
  if (!t || typeof t !== 'object' || Array.isArray(t)) fail('workspace 表形状不对（要 {tables:{workspaces:{…}}}）: ' + file);
  return Object.entries(t).map(([id, w]) => {
    if (!w || typeof w.path !== 'string' || typeof w.title !== 'string' || !Array.isArray(w.sessionIds)) fail('workspace 表里 ' + id + ' 缺 path / title / sessionIds: ' + file);
    return { id, title: w.title, cwd: w.path, sessionIds: w.sessionIds };
  });
}

/** 找唯一的项目：（byId 时先按 id）→ 标题（不分大小写）→ 目录（规范化，ref 像路径时）；多个命中报错。 */
function matchProject(list, ref, byId = true) {
  const hit = byId && list.find((p) => p.id === ref);
  if (hit) return hit;
  const hits = list.filter((p) => p.title.toLowerCase() === ref.toLowerCase() || (isPathLike(ref) && normPath(p.cwd) === normPath(ref)));
  if (hits.length > 1) fail('项目 ' + ref + ' 有多个匹配（' + hits.map((p) => p.id).join(', ') + '），改用 project id');
  return hits[0];
}
function wsBySid(sid, list) {
  const hits = list.filter((w) => w.sessionIds.includes(sid));
  if (hits.length > 1) fail('会话 ' + sid + ' 同时在多个 workspace 里: ' + hits.map((w) => w.title).join(', '));
  return hits[0];
}
function ensureProject(data, w) {
  const had = data.projects.find((p) => p.id === w.id);
  if (had) return had;
  const p = { id: w.id, title: w.title, cwd: w.cwd };
  data.projects.push(p);
  return p;
}
/** --proj 的解析：页面 projects → workspace 表（命中后加进 projects）。返回 project id。 */
function projFromRef(data, ref) {
  if (!ref) fail('--proj 不能为空');
  const hit = matchProject(data.projects, ref);
  if (hit) return hit.id;
  const w = matchProject(readWorkspaces(), ref);
  if (!w) fail('找不到项目 ' + ref + '（页面 projects 和 workspace 表里都没有；写项目 id、标题或目录，目录还不是 DSH 工作区时：dispatch 用 --cwd <目录>，或先 dsh-threads create_workspace）');
  return ensureProject(data, w).id;
}
const setProj = (data, it, ref) => { if (ref === '') delete it.proj; else it.proj = projFromRef(data, ref); };
const projTitle = (data, id) => (id === undefined ? '未归属' : (data.projects.find((p) => p.id === id) || { title: id }).title);

// ---- 版本 3 操作 ----------------------------------------------------------------------------
const need3 = (data) => { if (data.version !== 3) fail('页面还是版本 2，先运行 align migrate ' + data.name); };
const allIds = (data) => new Set(COLLS.flatMap((c) => data[c].map((x) => x.id)));
function newId(data, id, usage) {
  if (!id) fail('用法: ' + usage);
  if (!ID.test(id)) fail('id 必须是小写字母/数字/连字符(≤48): ' + id);
  if (allIds(data).has(id)) fail('id ' + id + ' 已存在');
}
function find3(data, ref, coll) {
  const id = ref.includes('/') ? ref.split('/').pop() : ref;
  for (const c of coll ? [coll] : COLLS) { const it = data[c].find((x) => x.id === id); if (it) return [c, it]; }
  fail(coll ? '没有 id 为 ' + id + ' 的 ' + LABEL[coll] : '没有 id 为 ' + id + ' 的条目');
}
function applyKv3(it, kv) {
  for (const [k, v] of kv) {
    if (CLI_KEYS.includes(k)) fail(k + ' 由 CLI 维护，不能直接改');
    if (FLAG_KEYS[k]) fail(k + ' 用 ' + FLAG_KEYS[k] + ' 设置');
    if (ASK_KEYS.includes(k)) fail(k + ' 由页面写入（用户在对齐页上对这一轮的操作），CLI 改这一轮的 status 时自动清掉');
    if (PAGE_KEYS.includes(k)) fail(k + ' 由页面写入（用户点了长期规则的「撤销」），rule revoke 时自动清掉');
    if (k === 'acked' && v !== '') fail('acked 由页面写入（用户点了「已了解」），CLI 只能用 acked= 清掉');
    if (k === 'visual' && !['true', 'false', ''].includes(v)) fail('visual 只能是 true 或 false: ' + v);
  }
  const att = applyAttach(it, kv);
  // visual=false 不存：和没写过的旧轮次一样
  const plain = kv.filter(([k]) => !ATTACH.includes(k)).map(([k, v]) => (k === 'visual' && v === 'false' ? [k, ''] : [k, v]));
  return [...new Set([...att, ...applyKv(it, plain)])];
}
function handoffRef(v) {
  if (/^https?:\/\//i.test(v)) return v;
  const abs = path.resolve(expandHome(v));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail('交接文件不存在: ' + abs);
  return abs;
}
/** v8（2026-10-23 用户定）：取消「等你回答」（status=waiting）。要问用户就挂一条没有选项的决定（开放问题），页面上是带输入框的决定卡。旧数据里的 waiting 照常能读。 */
const WAITING_RETIRED = (page, rid) => 'status=waiting（等你回答）已取消：要问用户，就挂一条没有选项的决定 —— align decide add ' + page + ' <决定 id> --round ' + rid + " 'title=<要问的话>' 'why=<为什么要问、答了之后做什么>'（不写 opt=，用户在页面上直接写回复）";
function checkNotWaiting(status, page, rid) { if (status === 'waiting') fail(WAITING_RETIRED(page, rid)); }
/**
 * 视觉类交付（api 13，2026-10-24 用户定：视觉验收的以后带图）：轮次进待验收（round done、round set status=done、旧命令 done / add done）
 * 的那条命令里必须写 visual=true|false。true 存成 visual:"true"，这一轮要挂着至少一张 img（validate3 校验），页面待验收详情把截图放在正文最上面；
 * false 不存（和没写过的旧轮次一样显示）。round add --prev 自动收尾的上一轮不要求：它不是交付，验收跟着链上最新一轮走。
 */
const VISUAL_ARG = 'visual=true|false';
const VISUAL_HINT = VISUAL_ARG + '（这一轮交付的是不是界面、页面、动效、设计稿这类要看截图验收的东西；true 要挂截图 img=<路径>::说明）';
const VISUAL_NEED_IMG = '视觉类交付要带截图：img=<路径>::说明';
function needVisual(kv, id) {
  const v = kv.filter(([k]) => k === 'visual').map(([, x]) => x).pop();
  if (v !== 'true' && v !== 'false') fail('round/' + id + ' 进待验收要带 ' + VISUAL_HINT);
}
function checkRound(r) {
  if (r.mode && !r.why) fail('round/' + r.id + ': 有 mode 时 why 必填（为什么续发 / 压缩 / 新开）');
  if (r.mode === 'new' && r.prev && !r.handoff) fail('round/' + r.id + ': 新开会话接上一轮要带 --handoff <交接文件或链接>');
}
/** 决定挂到某一轮：proj 从该轮复制；同时给了 --proj 且不一致报错。 */
function linkDecision(data, d, flags) {
  if (flags.round !== undefined && flags.round !== '') {
    const r = data.rounds.find((x) => x.id === flags.round);
    if (!r) fail('没有 id 为 ' + flags.round + ' 的轮次（--round）');
    if (flags.proj !== undefined && (flags.proj === '' ? undefined : projFromRef(data, flags.proj)) !== r.proj) fail('--proj 与轮次 ' + r.id + ' 的项目不一致（带 --round 时不用写 --proj）');
    d.round = r.id;
    if (r.proj) d.proj = r.proj; else delete d.proj;
    return;
  }
  if (flags.round === '') delete d.round;
  if (flags.proj !== undefined) setProj(data, d, flags.proj);
}
const syncRoundProj = (data, r) => { for (const d of data.decisions) if (d.round === r.id) { if (r.proj) d.proj = r.proj; else delete d.proj; } };
const where3 = (data, it) => '（项目 ' + projTitle(data, it.proj) + '）';
/**
 * 决定的 status / timeout 改了之后（was 是改之前的 status，keys 是这次改的字段）：进入 open 必须带 risk + cat，记 opened（决定进入 open 的时间）；
 * open 的决定按 opened + timeout（缺省 8h）算 due，改 timeout 时重算，同时清掉 overdue（截止变了，重新计时）。
 */
function decisionChanged(d, was, now, keys) {
  const entered = d.status === 'open' && was !== 'open';
  if (entered) {
    const miss = ['risk', 'cat'].filter((k) => !d[k]);
    if (miss.length) fail('decide/' + d.id + ' 缺 ' + miss.map((k) => k + '=').join(' ') + '：open 的决定要带 ' + RISK_HINT);
    d.opened = now;
  }
  if (d.status === 'open' && (entered || keys.includes('timeout'))) {
    d.due = nowIso(new Date(Date.parse(d.opened || d.updated || now) + durMs(d.timeout || DEFAULT_TIMEOUT)));
    delete d.overdue;
  }
}
function doneDecision(d, kv, now) {
  if (d.status === 'done') fail('decide/' + d.id + ' 已经完成');
  applyKv3(d, kv);
  if (d.choice === undefined && !d.result) fail('decide/' + d.id + ' 还没有答复：带上 choice=<选项名> 或 result=<结论>');
  d.status = 'done';
  d.updated = now;
  return 'decide/' + d.id + ' → 完成';
}
/** CLI 改了轮次的 status（was 是改之前的）：进入 done / accepted / dropped 写 ended（isFinished；三者之间互换不改），改回其他状态删 ended；页面发来的操作一起清掉。 */
function roundStatusChanged(r, was, now) {
  // 暂缓时段（api 15）：进入 paused 开一段，离开（doing / done / dropped …）收尾；已有的 pauses 照常收尾（3080 认得它才写得进来）
  const last = r.pauses && r.pauses[r.pauses.length - 1], open = last && last.to === undefined ? last : null;
  if (r.status !== 'paused') { if (open) open.to = now; }
  else if (was !== 'paused' && !open && pauseLog) (r.pauses ||= []).push({ from: now });
  if (!isFinished(r)) delete r.ended;
  else if (!FINISHED.includes(was)) r.ended = now;
  for (const k of ASK_KEYS) delete r[k];
}
function doneRound(r, kv, now, stateAsResult = false) {
  if (r.status === 'done') fail('round/' + r.id + ' 已经完成（改结果用 round set）');
  if (r.status === 'accepted') fail('round/' + r.id + ' 已经通过（改结果用 round set）');
  if (r.status === 'dropped') fail('round/' + r.id + ' 已经放弃（要改成完成用 round set status=done ' + VISUAL_ARG + '）');
  if (stateAsResult && r.state && !r.result) r.result = r.state;
  const was = r.status;
  applyKv3(r, kv);
  needVisual(kv, r.id);
  r.status = 'done';
  roundStatusChanged(r, was, now);
  r.updated = now;
  return 'round/' + r.id + ' → 完成';
}

export const ops3 = {
  'project add'(data, now, args, kv, flags) {
    if (!!flags.cwd === !!flags.ws) fail('用法: project add <页> (--cwd <目录> | --ws <workspace id>)');
    const all = readWorkspaces();
    let w;
    if (flags.ws) w = all.find((x) => x.id === flags.ws);
    else {
      const hits = all.filter((x) => normPath(x.cwd) === normPath(flags.cwd));
      if (hits.length > 1) fail('目录 ' + flags.cwd + ' 对应多个 workspace（' + hits.map((x) => x.id).join(', ') + '），改用 --ws');
      w = hits[0];
    }
    if (!w) fail('workspace 表里没有 ' + (flags.ws ? 'id ' + flags.ws : '目录 ' + path.resolve(expandHome(flags.cwd))) + '（目录还不是 DSH 工作区就先 dsh-threads create_workspace）');
    if (data.projects.some((p) => p.id === w.id)) fail('项目 ' + w.title + '（' + w.id + '）已存在');
    data.projects.push({ id: w.id, title: w.title, cwd: w.cwd });
    return '加了项目 ' + w.title + '（' + w.id + '，' + w.cwd + '）';
  },
  'round add'(data, now, [id], kv, flags) {
    newId(data, id, 'round add <页> <id> --mode continue|new [--prev <round id>] [--handoff …] [--proj …] title=… sid=… why=… ' + ETA_HINT);
    checkWritableMode(flags.mode, 'round add');
    const r = { id };
    applyKv3(r, kv);
    checkNotWaiting(r.status, data.name || '<页>', id);
    if (r.status !== undefined && r.status !== 'doing') fail('新一轮的 status 只能是 doing（完成用 round done）');
    r.status = r.status || 'doing';
    r.mode = flags.mode;
    let prev;
    if (flags.prev !== undefined) {
      prev = data.rounds.find((x) => x.id === flags.prev);
      if (!prev) fail('没有 id 为 ' + flags.prev + ' 的轮次（--prev）');
      r.prev = prev.id;
      if (prev.sid) r.prevSid = prev.sid;
      if (!r.sid && r.mode !== 'new' && prev.sid) r.sid = prev.sid;
    }
    if (!r.sid) fail('缺 sid=<会话 sid>' + (prev && r.mode !== 'new' ? '（上一轮也没有 sid 可继承）' : ''));
    if (!r.title) fail('缺 title=<这一轮做什么>');
    if (!r.why) fail('缺 why=<为什么' + MODE_LABEL[r.mode] + '>');
    const noEta = ['eta', 'eta75', 'etaconf'].filter((k) => !r[k]);
    if (noEta.length) fail('缺 ' + noEta.map((k) => k + '=').join(' ') + '：round add 要带 ' + ETA_HINT);
    if (flags.handoff !== undefined) r.handoff = handoffRef(flags.handoff);
    const before = data.projects.length;
    if (flags.proj !== undefined) r.proj = projFromRef(data, flags.proj);
    else if (prev && prev.proj) r.proj = prev.proj;
    else {
      const w = wsBySid(r.sid, readWorkspaces());
      if (!w) fail('找不到这一轮属于哪个项目（会话 ' + r.sid + ' 不在 workspace 表里）：用 --proj <项目 id / 标题 / 目录> 指定');
      r.proj = ensureProject(data, w).id;
    }
    r.started = r.updated = now;
    checkRound(r);
    const extra = [];
    if (data.projects.length > before) extra.push('新加项目 ' + projTitle(data, r.proj));
    // 上一轮还没交结果：改为 done（进「完成」等用户验收，不是直接结束）；已 done / accepted / dropped 的不动
    if (prev && !isFinished(prev)) { const was = prev.status; prev.status = 'done'; roundStatusChanged(prev, was, now); prev.updated = now; extra.push('上一轮 ' + prev.id + ' 改为完成'); }
    data.rounds.push(r);
    // 待办派成这一轮（--todo，api 17）：待办改 sent、记下轮次；--prev 接着做时，派到上一轮的待办跟到这一轮（收尾跟着链上最新一轮走）
    if (prev) for (const t of data.todos || []) if (t.status === 'sent' && t.round === prev.id) { t.round = r.id; t.updated = now; todoLog(t, now, 'send', { round: r.id, note: '接上一轮 ' + prev.id }); extra.push('待办 ' + t.id + ' 跟到这一轮'); }
    if (flags.todo !== undefined) {
      const t = findTodo(data, flags.todo);
      if (!['open', 'doing'].includes(t.status)) fail('todo/' + t.id + ' 现在是「' + TODO_LABEL[t.status] + '」，只有待办 / 在做的能派出去');
      todoStatus(t, 'sent', now, 'send', { round: r.id });
      t.round = r.id;
      extra.push('待办 ' + t.id + ' 派成这一轮（这一轮通过时待办自动完成，放弃时回到待办）');
    }
    // 还在等答的顺便问跟着 --prev 转到新一轮（dispatch 把它们写进发给会话的任务时传 btwFwd：记下已转给会话）
    if (prev) { const moved = carryBtw(data, r, prev, now, flags[BTW_FWD] || []); if (moved.length) extra.push(moved.length + ' 条没答的顺便问转到这一轮'); }
    return '项目 ' + projTitle(data, r.proj) + '：新增一轮 ' + id + '（' + MODE_LABEL[r.mode] + (prev ? '，接 ' + prev.id : '') + '）' + extra.map((s) => '；' + s).join('');
  },
  'round set'(data, now, [id], kv, flags) {
    if (!id || (!kv.length && ['mode', 'handoff', 'proj'].every((k) => flags[k] === undefined))) fail('用法: round set <页> <id> k=v… [--mode …] [--handoff …] [--proj …]');
    if (flags.todo !== undefined) fail('--todo 只用于 round add / dispatch（新的一轮从这条待办派出）');
    const [, r] = find3(data, id, 'rounds');
    const was = r.status;
    checkNotWaiting((kv.find(([k]) => k === 'status') || [])[1], data.name || '<页>', r.id);
    // 用户点了「修改」的轮次：返工要登记一轮续发，不能只改回 doing（页面数不到续发，2026-11-03）
    if (r.ask === 'revise' && (kv.find(([k]) => k === 'status') || [])[1] === 'doing') fail('round/' + r.id + ' 用户点了「修改」，返工要登记一轮续发，不要改回 doing：align ' + reviseCmd(data, data.name || '<页>', r.id));
    const keys = applyKv3(r, kv);
    if (keys.includes('status')) { if (r.status === 'done' && was !== 'done') needVisual(kv, r.id); roundStatusChanged(r, was, now); }
    if (flags.mode !== undefined) { if (flags.mode === '') delete r.mode; else { checkWritableMode(flags.mode, 'round set'); r.mode = flags.mode; } keys.push('mode'); }
    if (flags.handoff !== undefined) { if (flags.handoff === '') delete r.handoff; else r.handoff = handoffRef(flags.handoff); keys.push('handoff'); }
    if (flags.proj !== undefined) { setProj(data, r, flags.proj); syncRoundProj(data, r); keys.push('proj'); }
    r.updated = now;
    checkRound(r);
    return '改了 round/' + r.id + ' 的 ' + keys.join(',');
  },
  'round done'(data, now, [id], kv) {
    if (!id) fail('用法: round done <页> <id> ' + VISUAL_ARG + ' [result=…] [img=<路径>::说明]');
    return doneRound(find3(data, id, 'rounds')[1], kv, now);
  },
  /** 用户在页面上点了「通过」：只接 done → accepted（ended 不变）。--before 是迁移用的批量形式（main 先做预演 / 零条不写的判断）。 */
  'round accept'(data, now, [id], kv, flags) {
    if (flags.before !== undefined) {
      if (id) fail(ACCEPT_BEFORE_WITH_ID);
      if (kv.length) fail('round accept --before 不带 k=v');
      const hits = acceptBefore(data, flags.before);
      // 批量迁移不改 updated：裁剪按 updated 排先后，全改成现在会打乱顺序，页面也会把它们全标成「有更新」
      for (const r of hits) { r.status = 'accepted'; roundStatusChanged(r, 'done', now); }
      return hits.length + ' 条 done 改为 accepted（ended 早于 ' + flags.before + '）';
    }
    if (!id) fail('用法: round accept <页> <id> [result=…]  |  round accept <页> --before <ISO> [--dry-run]');
    const [, r] = find3(data, id, 'rounds');
    const ref = data.name + ' ' + r.id;
    if (r.status === 'accepted') fail('round/' + r.id + ' 已经通过');
    if (r.status === 'doing' || r.status === 'waiting') fail('round/' + r.id + ' 还没完成（' + r.status + '）：交了结果先 round done ' + ref + ' result=… ' + VISUAL_ARG + '，用户点了「通过」再 round accept');
    if (r.status === 'paused') fail('round/' + r.id + ' 暂缓中：要接着做 round set ' + ref + ' status=doing，做完了 round done ' + ref + ' ' + VISUAL_ARG);
    if (r.status === 'dropped') fail('round/' + r.id + ' 已放弃：确实要通过，先 round set ' + ref + ' status=done ' + VISUAL_ARG + ' 再 round accept');
    applyKv3(r, kv);
    r.status = 'accepted';
    roundStatusChanged(r, 'done', now);
    r.updated = now;
    // round add --prev 把上一轮收成 done 等验收，用户只验收链上最新一轮时前面的会一直留在「完成」栏：
    // 沿 prev 往前，仍是 done 的一起改 accepted（dropped / paused 不动、跳过继续往前）；同 --before，不改 updated（裁剪按 updated 排序、页面不标「有更新」）
    const earlier = roundChain(data, r.id).slice(1).filter((x) => x.status === 'done');
    for (const x of earlier) { x.status = 'accepted'; roundStatusChanged(x, 'done', now); }
    return 'round/' + r.id + ' → 通过' + (earlier.length ? '；同一条链上停在完成的前序轮次一起结束：' + earlier.map((x) => x.id).join('、') : '');
  },
  'decide add'(data, now, [id], kv, flags) {
    newId(data, id, 'decide add <页> <id> title=… why=… opt=选项::后果 opt=… [rec=…] [ifnone=…] [--pending] [--round …] [--proj …]');
    const d = { id };
    applyKv3(d, kv);
    if (flags.pending) {
      if (d.status !== undefined && d.status !== 'pending') fail('--pending 和 status=' + d.status + ' 冲突');
      d.status = 'pending';
    }
    if (!d.status) d.status = 'open';
    linkDecision(data, d, flags);
    decisionChanged(d, undefined, now, []);
    d.updated = now;
    data.decisions.push(d);
    return '加了 decide/' + id + where3(data, d);
  },
  'decide set'(data, now, [id], kv, flags) {
    if (!id || (!kv.length && flags.round === undefined && flags.proj === undefined)) fail('用法: decide set <页> <id> k=v… [--round …] [--proj …]');
    const [, d] = find3(data, id, 'decisions');
    const was = d.status;
    const keys = applyKv3(d, kv);
    linkDecision(data, d, flags);
    decisionChanged(d, was, now, keys);
    for (const k of ['round', 'proj']) if (flags[k] !== undefined) keys.push(k);
    d.updated = now;
    return '改了 decide/' + d.id + ' 的 ' + keys.join(',');
  },
  'decide done'(data, now, [id], kv) {
    if (!id) fail('用法: decide done <页> <id> [choice=…] [result=…]');
    return doneDecision(find3(data, id, 'decisions')[1], kv, now);
  },
  'note add'(data, now, [id], kv, flags) {
    newId(data, id, 'note add <页> <id> title=… [body=…] [level=info|warn] [--proj …]');
    const n = { id };
    applyKv3(n, kv);
    if (flags.proj !== undefined) setProj(data, n, flags.proj);
    n.updated = now;
    data.notes.push(n);
    return '加了 note/' + id + where3(data, n);
  },
  'note set'(data, now, [id], kv, flags) {
    if (!id || (!kv.length && flags.proj === undefined)) fail('用法: note set <页> <id> k=v… [--proj …]');
    const [, n] = find3(data, id, 'notes');
    const keys = applyKv3(n, kv);
    if (flags.proj !== undefined) { setProj(data, n, flags.proj); keys.push('proj'); }
    n.updated = now;
    return '改了 note/' + n.id + ' 的 ' + keys.join(',');
  },
  /** 撤销长期规则（用户在页面上点了「撤销」，First Mate 先从 AGENTS.md 删掉规则再跑）：写 revoked，规则显示为已撤销。 */
  'rule revoke'(data, now, [id]) {
    if (!id) fail('用法: rule revoke <页> <id>');
    const [, d] = find3(data, id, 'decisions');
    if (d.revoked) fail('rule/' + d.id + ' 已经撤销');
    if (!(d.status === 'done' && d.scope === 'always')) fail('decide/' + d.id + ' 不是长期规则（要已处理且 scope=always）');
    d.revoked = now;
    delete d.revokeAsked;
    d.updated = now;
    return 'rule/' + d.id + ' → 已撤销';
  },
  'note del'(data, now, [id]) {
    if (!id) fail('用法: note del <页> <id>');
    const [, n] = find3(data, id, 'notes');
    data.notes.splice(data.notes.indexOf(n), 1);
    return '删了 note/' + n.id;
  },
  /**
   * 今日推荐（早报第 4.5 步写入）：先删掉页面上所有旧推荐（rec-*，不管处理没处理），再按 --file 的 JSON 加新的。
   * 前一天没处理的不自动留到第二天：早报生成前用 rec ls 看过，还值得做的重新推荐（仍算在 5 条上限里）。
   */
  'rec set'(data, now, args, kv, flags) {
    if (args.length || kv.length || !flags.file) fail('用法: rec set <页> --file <推荐.json> [--date YYYY-MM-DD]');
    const date = flags.date === undefined ? now.slice(0, 10) : String(flags.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('--date 要写成 YYYY-MM-DD: ' + date);
    let list;
    try { list = JSON.parse(fs.readFileSync(expandHome(flags.file), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { fail('读不到推荐文件 ' + flags.file + ': ' + e.message); }
    if (!Array.isArray(list) || !list.length || list.length > REC_MAX) fail('推荐文件要是 1–' + REC_MAX + ' 条的数组 [{title, why, src?}]');
    const recs = list.map((x, i) => {
      const at = '第 ' + (i + 1) + ' 条推荐';
      if (!x || typeof x !== 'object' || Object.keys(x).some((k) => !['title', 'why', 'src'].includes(k))) fail(at + '只能有 title、why、src');
      for (const k of ['title', 'why']) if (typeof x[k] !== 'string' || !x[k].trim()) fail(at + '缺 ' + k);
      if (x.src !== undefined && (typeof x.src !== 'string' || !x.src.trim())) fail(at + '的 src 要是非空字符串');
      if (x.title.length > REC_TITLE_MAX) fail(at + '的 title 最多 ' + REC_TITLE_MAX + ' 字');
      if (x.why.length > REC_WHY_MAX) fail(at + '的 why 最多 ' + REC_WHY_MAX + ' 字');
      return { id: 'rec-' + date.replace(/-/g, '') + '-' + (i + 1), title: x.title.trim(), body: x.why.trim(), ...(x.src ? { src: x.src.trim() } : {}), updated: now };
    });
    const old = data.notes.filter(isRec);
    data.notes = data.notes.filter((n) => !isRec(n));
    const clash = recs.find((r) => allIds(data).has(r.id));
    if (clash) fail('id ' + clash.id + ' 已被别的条目占用');
    data.notes.push(...recs);
    const done = old.filter((n) => n.acked).length;
    return (old.length ? '删了旧推荐 ' + old.length + ' 条（已处理 ' + done + '、没处理 ' + (old.length - done) + '），' : '') + '加了 ' + recs.length + ' 条推荐 ' + recs.map((r) => r.id).join(' ');
  },
  /** 删掉页面上所有推荐（测试数据收尾、停用时用）。 */
  'rec clear'(data, now, args) {
    if (args.length) fail('用法: rec clear <页>');
    const n = data.notes.filter(isRec).length;
    data.notes = data.notes.filter((x) => !isRec(x));
    return '删了 ' + n + ' 条推荐';
  },
};

const ACCEPT_BEFORE_WITH_ID = '--before 不和轮次 id 一起用（单条：round accept <页> <id>；批量：round accept <页> --before <ISO>）';
/** round accept --before：ended（迁移来的没有 ended，按 updated）早于 iso 的 done 轮次。 */
function acceptBefore(data, iso) {
  const t = Date.parse(iso);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || Number.isNaN(t)) fail('--before 要写成 ISO 时间（如 2026-10-23T12:00:00+08:00）: ' + iso);
  return data.rounds.filter((r) => r.status === 'done' && Date.parse(r.ended || r.updated) < t);
}

/** 旧 k=v 到版本 3：proj=<名> 单独拿出来按 --proj 规则解析；轮次上 who=agent → status doing（who=you 即 waiting，v8 起拒收）、src → stitle。 */
function fromLegacyKv(kv, isRound) {
  const out = [];
  let proj;
  for (const [k, v] of kv) {
    if (k === 'proj') proj = v;
    else if (isRound && k === 'who') {
      if (v !== '' && !ENUMS.who.includes(v)) fail('who 只能是 you | agent');
      if (v === 'you') fail(WAITING_RETIRED('<页>', '<轮次 id>')); // v8：「等你回答」取消，旧命令的 who=you 同样拒收
      out.push(['status', 'doing']);
    } else if (isRound && k === 'src') out.push(['stitle', v]);
    else out.push([k, v]);
  }
  return { kv: out, proj };
}
const SEC_COLL = { doing: 'rounds', done: 'rounds', decide: 'decisions', note: 'notes' };

/** 旧命令在版本 3 页面上的映射（add / set / done / del / meta）。 */
export const legacy3 = {
  add(data, now, [sec, id], kv) {
    if (!SECS[sec]) fail('区块必须是 ' + Object.keys(SECS).join(' | '));
    newId(data, id, 'add <页> <区块> <id> k=v ...');
    const coll = SEC_COLL[sec];
    const { kv: rest, proj } = fromLegacyKv(kv, coll === 'rounds');
    const it = { id };
    applyKv3(it, rest);
    if (sec === 'doing' && !it.status) it.status = 'doing';
    if (sec === 'done') it.status = 'done';
    if (sec === 'decide' && !it.status) it.status = 'open';
    if (coll === 'rounds' && it.status === 'done') needVisual(rest, id);
    if (coll === 'rounds' && isFinished(it)) it.ended = now;
    if (coll === 'decisions') decisionChanged(it, undefined, now, []);
    if (proj !== undefined) setProj(data, it, proj);
    else if (coll === 'rounds' && it.sid) { const w = wsBySid(it.sid, readWorkspaces()); if (w) it.proj = ensureProject(data, w).id; }
    if (coll === 'rounds') it.started = now;
    it.updated = now;
    data[coll].push(it);
    return '加了 ' + LABEL[coll] + '/' + id + where3(data, it);
  },
  set(data, now, [ref], kv) {
    if (!ref || !kv.length) fail('用法: set <页> <id> k=v ...');
    const [coll, it] = find3(data, ref);
    const { kv: rest, proj } = fromLegacyKv(kv, coll === 'rounds');
    const was = it.status;
    const keys = applyKv3(it, rest);
    if (coll === 'rounds' && keys.includes('status')) { if (it.status === 'done' && was !== 'done') needVisual(rest, it.id); roundStatusChanged(it, was, now); }
    if (coll === 'decisions') decisionChanged(it, was, now, keys);
    if (proj !== undefined) { setProj(data, it, proj); if (coll === 'rounds') syncRoundProj(data, it); keys.push('proj'); }
    it.updated = now;
    return '改了 ' + LABEL[coll] + '/' + it.id + ' 的 ' + keys.join(',');
  },
  done(data, now, [ref], kv) {
    if (!ref) fail('用法: done <页> <id> [result=...]');
    const [coll, it] = find3(data, ref);
    if (coll === 'notes') fail('note/' + it.id + ' 不能移到最近完成');
    if (coll === 'decisions') return doneDecision(it, kv, now);
    return doneRound(it, fromLegacyKv(kv, true).kv, now, true);
  },
  del(data, now, [ref]) {
    if (!ref) fail('用法: del <页> <id>');
    const [coll, it] = find3(data, ref);
    data[coll].splice(data[coll].indexOf(it), 1);
    return '删了 ' + LABEL[coll] + '/' + it.id;
  },
  meta(data, now, pos, kv) {
    if (!kv.length) fail('用法: meta <页> k=v ...（' + META3.join(' | ') + '）');
    for (const [k, v] of kv) {
      if (k === 'proj') fail('版本 3 页面没有默认项目（proj）：条目用 --proj 归属');
      if (!META3.includes(k)) fail('页面字段只有 ' + META3.join(' | '));
      if (k === 'title' && !v) fail('title 不能为空');
      if (k === 'timeoutHigh' && v !== '' && !TIMEOUT_HIGH.includes(v)) fail('timeoutHigh 只能是 ' + TIMEOUT_HIGH.join(' | ') + '（高风险决定超时后只提醒 / 也按推荐自动处理）');
      if (v === '') delete data[k]; else data[k] = k === 'projOrder' ? v.split(',').map((s) => s.trim()) : v;
    }
    return '改了 页面 的 ' + kv.map(([k]) => k).join(',');
  },
};

const when = (it) => (it.updated || '').slice(5, 16).replace('T', ' ');
/** rule ls：没撤销的长期规则（scope=always 的已处理决定），一行一条：同类 → 选择。 */
export function ruleLines(data) {
  return data.decisions.filter(isRule).map((d) => 'rule/' + d.id + ' 同类：' + d.like + ' → ' + (d.choice || d.result || '（只写了一句话）') + ' · ' + when(d)).join('\n') || '（没有长期规则）';
}
export function listProjects(data) {
  return data.projects.map((p) => {
    const rs = data.rounds.filter((r) => r.proj === p.id);
    const open = data.decisions.filter((d) => d.proj === p.id && d.status === 'open').length;
    return 'project/' + p.id + ' ' + p.title + ' · ' + p.cwd + ' · 轮次 ' + rs.length + '（未完成 ' + rs.filter((r) => !isFinished(r)).length + '）· 待决定 ' + open;
  }).join('\n') || '（还没有项目）';
}
/** 版本 3 的 ls：round | decide | note | project，也认旧区块名 doing（活没结束的轮次，含 paused）/ done（isFinished 的轮次：done / accepted / dropped，和完成的决定）。 */
export function list3(data, [sec], kv, flags = {}) {
  const all = () => true;
  const pick = {
    round: [['rounds', all]], decide: [['decisions', all]], note: [['notes', all]],
    doing: [['rounds', (x) => !isFinished(x)]], done: [['rounds', isFinished], ['decisions', (x) => x.status === 'done']],
  };
  if (sec === 'project') return listProjects(data);
  if (sec && !pick[sec]) fail('区块必须是 round | decide | note | project（旧名 doing | done 也认）');
  let projOk = all;
  if (flags.proj !== undefined) {
    if (flags.proj === '未归属' || flags.proj === '') projOk = (it) => it.proj === undefined;
    else {
      const p = matchProject(data.projects, flags.proj);
      if (!p) fail('页面上没有项目 ' + flags.proj + '（project ls 看已有项目）');
      projOk = (it) => it.proj === p.id;
    }
  }
  let sidOk = all;
  if (flags.sid !== undefined) {
    const q = String(flags.sid).trim().replace(/^session-/, '');
    if (q.length < 8) fail('--sid 要写完整 sid 或至少前 8 位: ' + flags.sid);
    sidOk = (it) => typeof it.sid === 'string' && it.sid.replace(/^session-/, '').startsWith(q);
  }
  const rows = [];
  for (const [coll, ok] of sec ? pick[sec] : COLLS.map((c) => [c, all])) {
    for (const it of data[coll]) {
      if (!ok(it) || !projOk(it) || !sidOk(it) || !kv.every(([k, v]) => (it[k] ?? '') === v)) continue;
      rows.push(LABEL[coll] + '/' + it.id + ' [' + projTitle(data, it.proj) + ']' + (it.status ? ' [' + it.status + ']' : '') + (it.mode ? ' [' + it.mode + ']' : '') +
        (it.level ? ' [' + it.level + ']' : '') + ' ' + it.title + ' · ' + when(it) + (it.sid ? ' · ' + sid8(it.sid) : ''));
    }
  }
  // 不带区块：最后列没答完的顺便问。First Mate 接手和收报看的是这份输出，不列就会漏（2026-11-02 漏过一条）
  if (!sec) for (const b of data.btw || []) {
    const r = data.rounds.find((x) => x.id === b.round);
    if (b.status === 'open' && projOk(r) && sidOk(r) && kv.every(([k, v]) => (b[k] ?? '') === v)) rows.push('btw/' + b.id + ' [open] 轮次 ' + b.round + (b.from ? '（问在 ' + b.from + '）' : '') + ' · ' + btwOpenTail(b));
  }
  return rows.join('\n') || '（没有匹配的条目）';
}

// ---- 决定与轮次的关联：link / stale / 待处理决定 ------------------------------------------------
const live = (d) => d.status === 'open' || d.status === 'sent';
/** 决定是这一轮的产出：所挂轮次的活结束了（isFinished：done / accepted / dropped），且决定在结束（ended，没有就用 updated）前后 10 分钟内写的（调研完就要用户选，是常见情况）。这类不算过时、也不算待处理。 */
const RESULT_WINDOW_MS = 10 * 60 * 1000;
const resultOfRound = (data, d) => { const r = data.rounds.find((x) => x.id === d.round); return !!r && isFinished(r) && Math.abs(Date.parse(d.updated) - Date.parse(r.ended || r.updated)) <= RESULT_WINDOW_MS; };
/** 从 rid 那一轮起沿 prev 往前（含自身）；上一轮已被裁掉就停。 */
function roundChain(data, rid) {
  const out = [];
  for (let r = data.rounds.find((x) => x.id === rid); r; r = data.rounds.find((x) => x.id === r.prev)) {
    if (out.includes(r)) fail('round/' + r.id + ': prev 链成环');
    out.push(r);
  }
  return out;
}
/** 决定关联的会话：decision.sid，加上它所在轮次 prev 链上每一轮的 sid / prevSid。 */
const sessionsOf = (data, d) => new Set([d.sid, ...roundChain(data, d.round).flatMap((r) => [r.sid, r.prevSid])].filter(Boolean));
/** pending（等信息）提升到决定栏的命令。 */
const promoteCmd = (page, id) => 'align decide set ' + page + ' ' + id + " 'why=…' 'opt=…::…' 'opt=…::…' status=open";
/** 给 agent 照抄的两条命令：不用再等用户 → decide done；仍要用户定 → decide set 更新原因（pending 则是补全选项后提升）。 */
const decideCmds = (page, d) => ['align decide done ' + page + ' ' + d.id + " 'result=…'", d.status === 'pending' ? promoteCmd(page, d.id) : 'align decide set ' + page + ' ' + d.id + " 'why=…'"];
const decideLine = (head, page, d, extra = '') => head + ' ' + d.id + ' [' + d.status + '] ' + d.title + extra + ' → ' + decideCmds(page, d).join(' | ');
/** 命令里写的页：登记名指向这个文件就用登记名，否则用文件路径。 */
const pageRef = (data, file) => { const f = readRegistry()[data.name]; return f && normPath(f) === normPath(file) ? data.name : file; };

/** 这一轮及其前序轮次上仍 open/sent（待处理）或 pending（待补信息）的决定，一行一条（round add --prev / round done 之后列出）。 */
export function pendingLines(data, rid, page) {
  const ids = new Set(roundChain(data, rid).map((r) => r.id));
  return data.decisions.filter((d) => ids.has(d.round) && (live(d) || d.status === 'pending') && !resultOfRound(data, d)).map((d) =>
    (d.status === 'pending' ? '待补信息的决定 ' + d.id + ' ' + d.title + ' → 补全选项后提升：' + promoteCmd(page, d.id) : decideLine('待处理决定', page, d)));
}

/**
 * 没挂轮次的 open/sent 决定补挂：decision.sid 等于某轮 sid，或 src 等于某轮 stitle / title（精确）。
 * 候选都在同一条 prev 链上 → 挂到链上最靠后的那一轮，proj 跟着轮次；在不同链上 → 歧义，不挂。
 * 不改决定的 updated（stale 拿它和后续轮次、用户消息比先后）。返回 {n: 挂上条数, lines}。
 */
export function linkRounds(data) {
  const linked = [], missed = [];
  let amb = 0;
  for (const d of data.decisions) {
    if (!live(d) || d.round !== undefined) continue;
    const by = (r) => (d.sid && r.sid === d.sid ? '按 sid' : d.src && r.stitle === d.src ? '按会话标题' : d.src && r.title === d.src ? '按轮次标题' : '');
    const cands = data.rounds.filter(by);
    const top = cands.find((c) => { const ids = new Set(roundChain(data, c.id).map((x) => x.id)); return cands.every((x) => ids.has(x.id)); });
    if (top) {
      d.round = top.id;
      if (top.proj) d.proj = top.proj; else delete d.proj;
      linked.push('挂上 decide/' + d.id + ' ' + d.title + ' → round/' + top.id + ' ' + top.title + '（' + by(top) + '）');
      continue;
    }
    if (cands.length) amb++;
    const why = cands.length ? '歧义：候选 ' + cands.map((r) => 'round/' + r.id).join('、') + ' 不在同一条链上'
      : !d.sid && !d.src ? '没有 sid / src' : '没有匹配的轮次（' + [d.sid && 'sid=' + d.sid, d.src && 'src=' + d.src].filter(Boolean).join('，') + '）';
    missed.push('挂不上 decide/' + d.id + ' ' + d.title + '：' + why);
  }
  const head = '补挂轮次：挂上 ' + linked.length + ' 条，挂不上 ' + missed.length + ' 条' + (amb ? '（其中歧义 ' + amb + ' 条）' : '');
  return { n: linked.length, lines: [head, ...linked, ...missed] };
}

function link(ref, flags) {
  const file = resolvePage(ref);
  const pre = readPage(file);
  need3(pre);
  const r = linkRounds(pre);
  if (flags['dry-run']) r.lines[0] = '预演（没写入）：' + r.lines[0];
  if (flags['dry-run'] || !r.n) return r.lines.join('\n');
  const { msg } = mutate(file, (d) => { need3(d); return linkRounds(d).lines; });
  msg[0] += ' → ' + file;
  return msg.join('\n');
}

/** --since-user <sid>=<ISO>[,…] → Map(sid → 毫秒)。 */
function parseSinceUser(v) {
  const m = new Map();
  if (v === undefined) return m;
  for (const part of v.split(',')) {
    const j = part.indexOf('='), sid = part.slice(0, j).trim(), t = Date.parse(part.slice(j + 1).trim());
    if (j < 1 || !sid || Number.isNaN(t)) fail('--since-user 要写成 <sid>=<ISO 时间>[,…]: ' + part);
    m.set(sid, t);
  }
  return m;
}

/**
 * 过时的 open/sent/pending 决定，一行一条带原因：(a) 关联轮次已完成 / 已放弃（或已不在页面上）；(b) 关联轮次有后续轮（prev 指向它）且后续轮
 * started 晚于决定 updated；(c) 关联会话（见 sessionsOf）在决定 updated 之后收到过用户直接消息（sinceUser: Map(sid → 毫秒)）。
 */
export function staleLines(data, page, sinceUser = new Map()) {
  const out = [];
  for (const d of data.decisions) {
    if (d.status === 'done') continue;
    const t = Date.parse(d.updated), r = roundChain(data, d.round)[0], why = [];
    if (d.round !== undefined && !r) why.push('轮次 ' + d.round + ' 已不在页面上');
    if (r && isFinished(r) && !resultOfRound(data, d)) why.push('轮次 ' + r.id + (r.status === 'dropped' ? ' 已放弃' : ' 已完成'));
    if (r) for (const x of data.rounds) if (x.prev === r.id && Date.parse(x.started) > t) why.push('轮次 ' + r.id + ' 之后有新一轮 ' + x.id + '（' + when({ updated: x.started }) + ' 开始）');
    for (const s of sessionsOf(data, d)) if (sinceUser.get(s) > t) why.push('会话 ' + s + ' 在决定更新后收到过用户直接消息');
    if (why.length) out.push(decideLine('过时决定', page, d, '：' + why.join('；')));
  }
  return out.length ? out : ['没有过时的决定'];
}

/**
 * 与会话 sid 关联的 open/sent/pending 决定（遍历登记表里的版本 3 页面，版本 2 跳过）。供 dsh-fm 插件进程内调用；读页面出错直接抛。
 * 关联 = decision.sid === sid，或 decision.round 所在 prev 链上任一轮的 sid / prevSid === sid。
 * 返回 [{page, pageTitle, id, title, status, round?, cmds: [decide done 命令, decide set 命令（pending 是补全选项后提升的命令）]}]。
 */
export function openDecisionsForSession(sid) {
  if (typeof sid !== 'string' || !sid) fail('openDecisionsForSession 要一个会话 sid');
  const out = [];
  for (const [page, file] of Object.entries(readRegistry())) {
    const data = parsePage(fs.readFileSync(file, 'utf8'));
    if (data.version !== 3) continue;
    for (const d of data.decisions) {
      if (d.status === 'done' || !sessionsOf(data, d).has(sid)) continue;
      out.push({ page, pageTitle: data.title, id: d.id, title: d.title, status: d.status, ...(d.round !== undefined ? { round: d.round } : {}), cmds: decideCmds(page, d) });
    }
  }
  return out;
}

// ---- 会话实时状态：四栏与「已停，没有下一步」（api 7） --------------------------------------------
/** live 的取值：3080 插件按 ctx.agents 判 running / idle；回合结束但子 agent 或后台任务还在跑给 subagent / job；unknown 留给拿不到状态的实现。 */
export const LIVE_STATES = ['running', 'subagent', 'job', 'idle', 'unknown'];
/**
 * work（2026-10-24）：会话正在执行的子 agent 和后台任务，{sid: {subagents: [{id, name, since}], jobs: [{id, name, since}]}}，
 * 只列有东西在跑的会话（不管主回合在不在跑）。name 是子 agent 创建时的名字（subagent 工具的 description、workflow agent 的 label）
 * 或后台任务的名字（启动它的那次调用的 description，没有就从命令认出来的名字，见 job-title.js），取不到是 null；since 是子 agent 这一轮 / 后台任务开始的时刻（毫秒），
 * 取不到是 null；后台任务另有 cmd（pwsh / bash 的命令原文，别的种类是 null）。
 * 校验 work(sids) 的返回：只能是 sids 里的会话、形状不对就抛（不猜）。返回同一个对象。
 */
export function checkWork(got, sids) {
  if (!got || typeof got !== 'object' || Array.isArray(got)) throw new Error('work(sids) 没有返回对象: ' + JSON.stringify(got));
  const item = (x, where) => {
    if (!x || typeof x.id !== 'string' || !(x.name === null || typeof x.name === 'string') || !(x.since === null || Number.isFinite(x.since)) || !(x.cmd === undefined || x.cmd === null || typeof x.cmd === 'string')) throw new Error('work(sids) 的 ' + where + ' 形状不对（要 {id, name: string | null, since: 毫秒 | null[, cmd: string | null]}）: ' + JSON.stringify(x));
  };
  for (const [sid, w] of Object.entries(got)) {
    if (!sids.includes(sid)) throw new Error('work(sids) 返回了没问到的会话 ' + sid);
    if (!w || !Array.isArray(w.subagents) || !Array.isArray(w.jobs)) throw new Error('work(sids) 对会话 ' + sid + ' 没有 subagents[] / jobs[]: ' + JSON.stringify(w));
    w.subagents.forEach((x) => item(x, sid + ' 的子 agent'));
    w.jobs.forEach((x) => item(x, sid + ' 的后台任务'));
  }
  return got;
}
/**
 * 页面分栏（模板在 // @columns-begin … // @columns-end 里内联同一份规则）。live = /data 顶层的 live（{sid: running|idle|unknown}），或 null（3390：没有会话状态）。
 * 返回 {col:'closed'} 已结束（accepted | dropped）| {col:'done'} 完成（等用户验收）| {col:'blocked', reason, reasons} 阻塞 | {col:'doing', warn?:'fault', wait?:'subagent'|'job', unknown?:true} 进行中。
 * live 是 subagent / job（回合结束，在等子 agent 或后台任务）时和 running 一样不判 stopped / decide / info / fault，进行中并带 wait。
 * 阻塞原因按优先级（reason = reasons[0]，reasons 是全部）：
 *   decide  挂着 open 决定
 *   answer  status=waiting（等你回答）
 *   stopped status=doing、会话空闲、无 fault、无 open/pending 决定：会话已停，没有下一步
 *   fault   有 fault，且会话不是在跑（在跑时 fault 视为旧的：仍算进行中，warn:'fault'）
 *   info    挂着 pending 决定，且会话空闲
 *   paused  暂缓
 * live 未知（null、'unknown'、轮次没有 sid 或 live 里没有它）时不判 stopped / info（不猜）：doing 没有别的原因就放进行中并标 unknown:true。
 */
export function columnOf(data, r, live) {
  if (isClosed(r)) return { col: 'closed' };
  if (r.status === 'done') return { col: 'done' };
  const state = live && r.sid && Object.hasOwn(live, r.sid) ? live[r.sid] : 'unknown';
  const mine = (data.decisions || []).filter((d) => d.round === r.id);
  const open = mine.filter((d) => d.status === 'open').length, pending = mine.some((d) => d.status === 'pending');
  // v8（2026-10-23 用户定）：轮次状态和决定状态分开算。会话还在跑，挂着决定也是进行中；会话停了、在等决定才算阻塞「等你决定」。
  // 「等你回答」取消：旧数据里的 waiting 按 doing 算（问题改用没有选项的决定）。
  const active = r.status === 'doing' || r.status === 'waiting';
  // 2026-10-24：回合结束、但子 agent 或后台任务还在跑（live = subagent | job）的会话没停，和 running 一样算在跑，返回 wait 说明在等什么。
  const bg = state === 'subagent' || state === 'job';
  const reasons = [];
  if (open && state === 'idle') reasons.push('decide');
  if (active && state === 'idle' && !r.fault && !open && !pending) reasons.push('stopped');
  if (r.fault && state !== 'running' && !bg) reasons.push('fault');
  if (pending && state === 'idle') reasons.push('info');
  if (r.status === 'paused') reasons.push('paused');
  if (reasons.length) return { col: 'blocked', reason: reasons[0], reasons, open };
  return { col: 'doing', open, ...(r.fault ? { warn: 'fault' } : {}), ...(bg ? { wait: state } : {}), ...(state === 'unknown' ? { unknown: true } : {}) };
}
/** 会话空闲时「已停，没有下一步」：status=doing、无 fault、没挂 open / pending 决定（sent 的不挡：用户已回复，这一轮却没接着做）。与 columnOf 的 stopped 同一判据。 */
const stuckRound = (data, r) => r.status === 'doing' && !r.fault && !data.decisions.some((d) => d.round === r.id && (d.status === 'open' || d.status === 'pending'));
/** 给 First Mate 照抄的三条命令：交了结果 → round done；要用户回答 → 挂一条没有选项的决定；出错停了 → fault。 */
const stuckCmds = (page, r) => ['align round done ' + page + ' ' + r.id + " 'result=…' " + VISUAL_ARG, 'align decide add ' + page + ' <决定 id> --round ' + r.id + " 'title=<要问的话>' 'why=…'", 'align round set ' + page + ' ' + r.id + " 'fault=…'"];
/**
 * decide done 之后（2026-11-02）：决定挂的轮次还是 doing、也没有别的 open / pending 决定时，提示一行怎么收轮（只提示，不改）。
 * 起因：决定关了（尤其是「不做」），轮次却留在 doing，会话早已空闲，页面一直显示「已停」（cua-hold 停了 4.5 小时）。
 */
export function decideDoneHint(data, did, page) {
  const d = data.decisions.find((x) => x.id === did), r = d && d.round && data.rounds.find((x) => x.id === d.round);
  if (!r || !stuckRound(data, r)) return [];
  return ['轮次 ' + r.id + ' 还是进行中，没有别的待决定：会话要接着做就把答复转给它；不做了 align round set ' + page + ' ' + r.id + " status=dropped 'result=<原因>'；已经交了结果 align round done " + page + ' ' + r.id + " 'result=…' " + VISUAL_ARG];
}
/** stale --idle：这些已空闲会话上的「已停没有下一步」轮次，一行一条。 */
export function idleLines(data, page, sids) {
  return data.rounds.filter((r) => sids.includes(r.sid) && stuckRound(data, r)).map((r) => '已停没有下一步 round/' + r.id + ' ' + r.title + '（会话 ' + r.sid + '） → ' + stuckCmds(page, r).join(' | '));
}
/**
 * 会话 sid 上「已停，没有下一步」的轮次（遍历登记表里的版本 3 页面，版本 2 跳过；读页面出错直接抛）。dsh-fm 在该会话 turn/end 时调用（此时会话一定空闲），
 * 结果附在「会话回合结束」通知末尾。返回 [{page, pageTitle, id, title, cmds: [round done, decide add（没有选项的决定）, round set fault=…]}]。
 */
export function stuckRoundsForSession(sid) {
  if (typeof sid !== 'string' || !sid) fail('stuckRoundsForSession 要一个会话 sid');
  const out = [];
  for (const [page, file] of Object.entries(readRegistry())) {
    const data = parsePage(fs.readFileSync(file, 'utf8'));
    if (data.version !== 3) continue;
    for (const r of data.rounds) if (r.sid === sid && stuckRound(data, r)) out.push({ page, pageTitle: data.title, id: r.id, title: r.title, cmds: stuckCmds(page, r) });
  }
  return out;
}
/** 轮次「已停」满这么久就提醒 First Mate 一次（2026-11-02：会话交了结果、轮次却在阻塞栏一停几小时，8 段里 6 段跨了 First Mate 交接）。 */
export const STUCK_REMIND_MS = 10 * 60 * 1000;
const END_WORD = { completed: '正常结束', error: '出错结束', aborted: '被停止', interrupted: '被打断', 'max-tokens': '输出超长结束' };
/**
 * 该提醒 First Mate 的「已停没有下一步」轮次（3080 插件定时调用，stuck.js）：stuckRound（doing、无 fault、没挂 open / pending 决定）、
 * 会话 live 是 idle（子 agent、后台任务在跑的不算停），且停了满 minMs。since = max(会话最后一次回合结束, 这一轮和它的决定最后一次改动)：
 * First Mate 刚改过这一轮（写 state、关掉决定）就从那时重新计时。turns[sid] = {at, kind}（lastTurn）| null（回合没收尾，比如被重启切断）。
 * key = 轮次 id + 回合结束时间：同一次回合结束只提醒一次，会话再跑一回合、停下后可以再提醒；sent 里已有的 key 不返回。
 * 返回 [{id, sid, title, since, at, end, key}]（at / end：回合结束时间和方式，没收尾时都是 null）。
 */
export function stuckReminders(data, now, live, turns, sent, minMs = STUCK_REMIND_MS) {
  const out = [];
  for (const r of data.rounds) {
    if (!r.sid || !live || live[r.sid] !== 'idle' || !stuckRound(data, r)) continue;
    if (!Object.hasOwn(turns, r.sid)) throw new Error('stuckReminders 缺会话 ' + r.sid + ' 的回合结束时间');
    const t = turns[r.sid];
    const touched = [r.updated, ...data.decisions.filter((d) => d.round === r.id).map((d) => d.updated)].map((x) => Date.parse(x || '')).filter((x) => !Number.isNaN(x));
    const since = Math.max(t ? t.at : -Infinity, ...touched);
    if (!Number.isFinite(since) || now - since < minMs) continue;
    const key = r.id + '@' + (t ? t.at : 'cut');
    if (sent.has(key)) continue;
    out.push({ id: r.id, sid: r.sid, title: r.title, since, at: t ? t.at : null, end: t ? t.kind : null, key });
  }
  return out;
}
/** 提醒的标题（消息卡上那一句）：回合正常结束 = 待登记（页面同名），其余 = 已停。 */
export const stuckSummary = (it) => (it.end === 'completed' ? '轮次待登记' : '轮次已停');
/** 发给页面 owner（First Mate）的提醒全文：第一行 [fm] + 标题、第二行 sid（DSH 聊天里按 dsh-fm 通知画卡、链到这个会话），再写停了多久和三条命令。 */
export function stuckReminderText(data, page, it, now) {
  const r = data.rounds.find((x) => x.id === it.id);
  if (!r) fail('轮次 ' + it.id + ' 不在页面「' + data.title + '」上');
  const hhmm = (ms) => nowIso(new Date(ms)).slice(11, 16);
  const how = it.at === null ? '回合没有收尾（多半被重启切断）' : hhmm(it.at) + ' 回合' + (END_WORD[it.end] || it.end);
  return [
    '[fm] ' + stuckSummary(it),
    'sid: ' + it.sid,
    '对齐页「' + data.title + '」轮次 ' + r.id + '「' + r.title + '」：会话' + how + '，之后 ' + Math.max(1, Math.round((now - it.since) / 60000)) + ' 分钟没有动静，轮次还是进行中（页面上在「阻塞」栏）。',
    '核对会话的交付是否满足验收标准，再三选一：' + stuckCmds(page, r).join(' | '),
    '在等外部资源或等你自己做的事（重启、别的轮次）也算交了结果：先 round done 已交付的部分、result 写清还差什么，剩下的记进计划；不挂暂缓，也不要只写 next。',
  ].join('\n');
}

// ---- 决策卡排序与超时（api 7） ----------------------------------------------------------------------
const RISK_RANK = { 高: 0, 中: 1, 低: 2 };
/** 缺 risk 的旧决定按「中」。 */
const riskRank = (d) => RISK_RANK[d.risk] ?? 1;
/** 等待起点：opened（进入 open 的时间），旧数据没有就用 updated。 */
const waitFrom = (d) => Date.parse(d.opened || d.updated || '');
const byNum = (a, b) => (a === b ? 0 : Number.isNaN(a) ? 1 : Number.isNaN(b) ? -1 : a - b);
/** 决定子卡的顺序（页面在 // @sort-begin … // @sort-end 里内联同一份）：risk 高 → 低，同级等得久的（opened 早）在前；不改原数组。 */
export function sortDecisions(list, now) {
  return list.map((d, i) => [d, i]).sort(([a, i], [b, j]) => riskRank(a) - riskRank(b) || byNum(waitFrom(a), waitFrom(b)) || i - j).map(([d]) => d);
}
const BLOCK_RANK = { stopped: 0, fault: 1, info: 2, paused: 3 };
/**
 * 阻塞栏卡片的顺序。card = {reason（columnOf 的 reason；项目卡写 'decide'）, decisions: [卡里的 open 决定], answer?: 等你回答开始的时间（ISO，waiting 轮次的 updated）}。
 * 挂着已超时（overdue）决定的卡最前；然后是要你答的卡（有 open 决定或回答子卡）：卡风险 = 卡内决定的最高风险（回答子卡算「中」），同级按最早开始等的；
 * 其余按原因 stopped > fault > info > paused。同序保持原顺序；不改原数组。
 */
export function sortBlocked(cards, now) {
  const key = (c) => {
    const ds = c.decisions || [], asks = ds.length > 0 || c.answer !== undefined;
    const risk = Math.min(...ds.map(riskRank), c.answer !== undefined ? 1 : 9);
    const wait = Math.min(...ds.map(waitFrom).filter((x) => !Number.isNaN(x)), c.answer !== undefined ? Date.parse(c.answer) : Infinity);
    return [ds.some((d) => d.overdue) ? 0 : 1, asks ? 0 : 1, asks ? risk : BLOCK_RANK[c.reason] ?? 9, asks ? wait : 0];
  };
  return cards.map((c, i) => [c, key(c), i]).sort(([, a, i], [, b, j]) => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
    return i - j;
  }).map(([c]) => c);
}
/** 停机期间超时很久的不自动作答：推荐可能已过时，宁可再问一次。 */
const STALE_MS = 24 * 3600 * 1000;
/**
 * 到了截止（due）的 open 决定该怎么处理（3080 插件的轮询调用）：[{id, action:'auto'}]（按推荐自动作答，用 answerTimeout）或
 * [{id, action:'remind', why}]（不自动、提醒 owner 一次，用 remindOverdue）。why：no-rec 没有推荐；high 风险高且页面 timeoutHigh 不是 auto；
 * stale 超时超过 24 小时（多半是 3080 停机期间超时）。没有 due 的（api 7 之前建的）不处理；已写 overdue 的不再提醒。
 */
export function timeoutCheck(data, now) {
  const out = [];
  for (const d of data.decisions) {
    if (d.status !== 'open' || !d.due || d.auto) continue;
    const due = Date.parse(d.due);
    if (Number.isNaN(due)) fail('decide/' + d.id + ': due 不是时间: ' + d.due);
    if (now < due) continue;
    const why = !d.rec ? 'no-rec' : d.risk === '高' && data.timeoutHigh !== 'auto' ? 'high' : now - due > STALE_MS ? 'stale' : null;
    if (!why) out.push({ id: d.id, action: 'auto' });
    else if (!d.overdue) out.push({ id: d.id, action: 'remind', why });
  }
  return out;
}

// ---- 迁移（版本 2 → 3） ----------------------------------------------------------------------
/** 返回 {data, summary, unowned}；按 sid → 旧项目名（workspace 标题 / 目录）归属，都不中就是未归属。 */
export function migrateData(v2, workspaces) {
  if (v2.version !== 2) fail('只能从版本 2 迁移（这页已经是版本 ' + v2.version + '）');
  const out = { version: 3, name: v2.name, title: v2.title };
  for (const k of ['next', 'owner', 'updated']) if (v2[k] !== undefined) out[k] = v2[k];
  Object.assign(out, { projects: [], rounds: [], decisions: [], notes: [] });
  const unowned = [];
  const owner = (it) => {
    const w = (it.sid && wsBySid(it.sid, workspaces)) || (it.proj && matchProject(workspaces, it.proj, false));
    if (!w) { unowned.push(it.sec + '/' + it.id + ' [' + it.proj + '] ' + it.title); return {}; }
    return { proj: ensureProject(out, w).id };
  };
  for (const it of v2.items) {
    const { id, sec, proj: _p, who, src, ...rest } = it;
    const head = { id, ...owner(it) };
    const asStitle = src !== undefined ? { stitle: src } : {}, asSrc = src !== undefined ? { src } : {};
    if (sec === 'doing') out.rounds.push({ ...head, ...rest, ...asStitle, status: who === 'you' ? 'waiting' : 'doing', started: it.updated });
    else if (sec === 'done' && (it.choice !== undefined || it.reply !== undefined)) out.decisions.push({ ...head, ...rest, ...asSrc, status: 'done' });
    else if (sec === 'done') out.rounds.push({ ...head, ...rest, ...asStitle, status: 'done', started: it.updated });
    else out[sec === 'decide' ? 'decisions' : 'notes'].push({ ...head, ...rest, ...asSrc });
  }
  for (const c of COLLS) for (const x of out[c]) for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k];
  const cnt = (arr, s) => arr.filter((x) => x.status === s).length;
  const summary = '项目 ' + out.projects.length + ' 个（' + (out.projects.map((p) => p.title).join('、') || '无') + '），' +
    '轮次 ' + out.rounds.length + '（进行中 ' + cnt(out.rounds, 'doing') + '，等你 ' + cnt(out.rounds, 'waiting') + '，完成 ' + cnt(out.rounds, 'done') + '），' +
    '决定 ' + out.decisions.length + '（open ' + cnt(out.decisions, 'open') + '，sent ' + cnt(out.decisions, 'sent') + '，done ' + cnt(out.decisions, 'done') + '），' +
    '须知 ' + out.notes.length + '；未归属 ' + unowned.length + ' 条';
  return { data: out, summary, unowned };
}

/** 迁移前确认 3080 内存里的插件已是版本 3 代码（否则旧代码会按版本 2 读迁移后的页面而报错）。 */
export async function probeDshApi(dshUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080') {
  const url = new URL(ROUTE_PREFIX + '/health', dshUrl).href;
  let j;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); j = await r.json(); }
  catch (e) { fail('探测 ' + url + ' 失败（' + e.message + '）：3080 没起来或对齐页插件没加载；确认无妨可加 --force'); }
  if (!(typeof j.api === 'number' && j.api >= 3)) fail(url + ' 报 api=' + j.api + '：3080 内存里还是旧插件代码，重启 3080 后再迁（确认无妨可加 --force）');
  return j.api;
}
/** 写 visual=true 前确认 3080 内存里的插件认得 visual（api 13）：旧代码按旧字段表校验，页面里出现 visual 就整页读不出来（侧栏、手机、角标一起挂）。 */
export const VISUAL_API = 13;
/**
 * 写 pauses 前确认 3080 认得它（api 15）。探测不到（3080 没起来）算可以：起来时加载的就是这份代码。
 * 旧插件时不写暂缓时刻（status 照改），main 打印一行说明：暂缓不能因为没重启就做不了；时刻事后可由 backfill-pauses.mjs 从会话日志补。
 */
export const PAUSE_API = 15;
export async function pauseApiReady(dshUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080') {
  let j;
  try { const r = await fetch(new URL(ROUTE_PREFIX + '/health', dshUrl).href, { signal: AbortSignal.timeout(3000) }); j = await r.json(); }
  catch { return true; }
  return typeof j.api === 'number' && j.api >= PAUSE_API;
}
/** 测试替换探测用。 */
export const probes = { pauseApi: pauseApiReady, btwApi: (...a) => needBtwApi(...a), mineApi: (...a) => needMineApi(...a) };
export async function needVisualApi(dshUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080') {
  const url = new URL(ROUTE_PREFIX + '/health', dshUrl).href;
  let j;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); j = await r.json(); }
  catch (e) { fail('写 visual=true 前要确认 3080 读得了它，探测 ' + url + ' 失败（' + e.message + '）：3080 没起来或对齐页插件没加载'); }
  if (!(typeof j.api === 'number' && j.api >= VISUAL_API)) fail(url + ' 报 api=' + j.api + '：3080 内存里还是旧插件代码，页面里有 visual 它会整页读不出来；3080 重启后再跑这条命令（visual=false 不受影响）');
}

/** 写 btw 前确认 3080 读得了它：旧插件代码看到顶层 btw 整页报错（validate3 不认识这个字段）。 */
export async function needBtwApi(dshUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080') {
  const url = new URL(ROUTE_PREFIX + '/health', dshUrl).href;
  let j;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); j = await r.json(); }
  catch (e) { fail('写顺便问前要确认 3080 读得了它，探测 ' + url + ' 失败（' + e.message + '）：3080 没起来或对齐页插件没加载'); }
  if (!(typeof j.api === 'number' && j.api >= BTW_API)) fail(url + ' 报 api=' + j.api + '：3080 内存里还是旧插件代码，页面里有顺便问它会整页读不出来；3080 重启后再跑这条命令');
}

async function migrate(ref, flags) {
  const file = resolvePage(ref);
  const ws = readWorkspaces();
  const report = (r) => [r.summary, ...r.unowned.map((l) => '未归属 ' + l), ...linkRounds(r.data).lines];
  if (flags['dry-run']) {
    const r = migrateData(readPage(file), ws);
    const lines = report(r);
    r.data.updated = nowIso();
    prune(r.data);
    validate(r.data);
    lines[0] = '预演（没写入）：' + lines[0];
    return lines.join('\n');
  }
  if (!flags.force) await probeDshApi();
  const { msg } = mutate(file, (d) => {
    const r = migrateData(d, ws);
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, r.data);
    return report(r);
  });
  msg[0] = '迁移到版本 3：' + msg[0] + ' → ' + file;
  return msg.join('\n');
}

/** 版本 3 数据投影成版本 2 形状（手机网关用，App 只认版本 2）；版本 2 原样返回。 */
export function legacyView(data) {
  if (data.version !== 3) return data;
  const pt = (id) => {
    if (id === undefined) return '未归属';
    const p = data.projects.find((x) => x.id === id);
    if (!p) fail('proj ' + id + ' 不在 projects 里');
    return p.title;
  };
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  const decide = [], doing = [], done = [], note = [];
  for (const d of data.decisions) {
    if (d.status === 'pending') continue; // 等信息的决定不给手机（不进决定栏）
    // 开放问题（没有选项）旧格式放不进决定栏（要 ≥2 个选项）：投影成「等你回答」的进行中条目，手机照旧显示
    if ((d.status === 'open' || d.status === 'sent') && !(d.opt || []).length) { doing.push({ id: d.id, sec: 'doing', proj: pt(d.proj), title: d.title, state: d.why || d.title, who: d.status === 'open' ? 'you' : 'agent', ...pick(d, ['src', 'href', 'sid', 'updated']) }); continue; }
    if (d.status === 'done') done.push({ id: d.id, sec: 'done', proj: pt(d.proj), ...pick(d, ['title', 'src', 'href', 'result', 'choice', 'reply', 'updated']) });
    else decide.push({ id: d.id, sec: 'decide', proj: pt(d.proj), ...pick(d, ['title', 'src', 'href', 'why', 'opt', 'rec', 'ifnone', 'sid', 'status', 'choice', 'reply', 'answered', 'updated']) });
  }
  for (const r of data.rounds) {
    const src = r.stitle ?? r.src;
    const base = { id: r.id, proj: pt(r.proj), title: r.title, ...(src !== undefined ? { src } : {}), ...pick(r, ['href']) };
    // 手机只认 doing / done：dropped 放进最近完成、结果前加「已放弃」；done（等验收）与 accepted 都进最近完成，done 的结果前加「待验收」；paused 留在进行中、state 写「已暂缓」
    if (r.status === 'dropped') done.push({ ...base, sec: 'done', result: r.result ? '已放弃：' + r.result : '已放弃', ...pick(r, ['updated']) });
    else if (r.status === 'done') done.push({ ...base, sec: 'done', result: r.result ? '待验收：' + r.result : '待验收', ...pick(r, ['updated']) });
    else if (r.status === 'accepted') done.push({ ...base, sec: 'done', ...pick(r, ['result', 'updated']) });
    else doing.push({ ...base, sec: 'doing', state: r.status === 'paused' ? '已暂缓' : r.state || r.next || '进行中', ...pick(r, ['next', 'sid']), who: r.status === 'waiting' ? 'you' : 'agent', ...pick(r, ['updated']) });
  }
  for (const n of data.notes) note.push({ id: n.id, sec: 'note', proj: pt(n.proj), ...pick(n, ['title', 'src', 'href', 'body', 'level', 'updated']) });
  done.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const out = { version: 2, name: data.name, title: data.title };
  for (const k of ['next', 'owner', 'updated']) if (data[k] !== undefined) out[k] = data[k];
  out.items = [...decide, ...doing, ...done, ...note];
  validate(out);
  return out;
}

export function init(file, flags, now = nowIso()) {
  const name = flags.name, title = flags.title;
  if (!name || !title) fail('用法: init <file.html> --name <slug> --title <标题> [--owner <会话id>] [--proj <默认项目>] [--version 3]');
  if (flags.version !== undefined && flags.version !== '3') fail('--version 只能是 3（不写就是版本 2）');
  if (flags.version === '3' && flags.proj !== undefined) fail('版本 3 页面没有默认项目（--proj）');
  if (!/\.html?$/i.test(file)) fail('页面文件要以 .html 结尾');
  const abs = path.resolve(file);
  if (fs.existsSync(abs)) fail('文件已存在: ' + abs);
  const reg = readRegistry();
  if (reg[name] && reg[name] !== abs) fail('登记名 ' + name + ' 已指向 ' + reg[name]);
  const data = flags.version === '3'
    ? { version: 3, name, title, owner: flags.owner, updated: now, projects: [], rounds: [], decisions: [], notes: [] }
    : { version: 2, name, title, proj: flags.proj, owner: flags.owner, updated: now, items: [] };
  if (data.version === 3 && data.owner === undefined) delete data.owner;
  validate(data);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, render(data), { flag: 'wx' });
  reg[name] = abs;
  writeRegistry(reg);
  return '建了 ' + name + ' → ' + abs;
}

// ---- 本机服务：只监听 127.0.0.1 --------------------------------------------------------------
export const ROUTE_PREFIX = '/alignment';
const standaloneUrl = (name, port = PORT) => 'http://127.0.0.1:' + port + '/p/' + name;
const dshRouteUrl = (dshUrl, name) => new URL(ROUTE_PREFIX + '/p/' + name, dshUrl).href;

export function messageFor(data, it, choice, note, file) {
  const tail = data.version === 3
    ? '（决定 ' + it.id + '。处理完运行 align decide done ' + data.name + ' ' + it.id + ' 把它标成完成；如果处理不了，运行 align decide set ' + data.name + ' ' + it.id + ' status=open 改回待决定，并在 why 里写明原因。）'
    : '（条目 decide/' + it.id + '。处理完运行 align done ' + data.name + ' ' + it.id + ' 把它移到「最近完成」；如果处理不了，用 set 改回 status=open 并在 why 里写明原因。）';
  return [
    '对齐页「' + data.title + '」上，用户对这件事做了决定：' + it.title,
    choice ? '选择：' + choice : '没有选选项，只写了一句话。',
    note ? '备注：' + note : '',
    '',
    tail,
  ].filter((l, i) => l !== '' || i === 3).join('\n');
}

// ---- 会话（一律经 dsh-threads；align 不另存会话状态） -----------------------------------------------
/** 会话 sid 的完整格式。 */
export const SID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sid8 = (sid) => String(sid).replace(/^session-/, '').slice(0, 8);
export function checkSidFormat(sid, what = 'sid') {
  if (!SID_RE.test(sid)) fail(what + ' 格式不对: ' + sid + '（要写完整的会话 id：session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx；不确定就 dsh-threads list_threads 查）');
}
/**
 * dsh-threads CLI（会话相关的都经它）与 sidebar CLI（align open 在侧栏打开页面）默认取 $DSH_HOME/scripts 下的本机脚本，
 * 也可以用 ALIGN_THREADS_CLI / ALIGN_SIDEBAR_CLI 指向任意位置的脚本；没有就在用到时明确报错，不静默降级。
 */
const threadsCli = () => process.env.ALIGN_THREADS_CLI || path.join(DSH_HOME, 'scripts', 'threads-cli', 'dsh-threads.mjs');
const sidebarCli = () => process.env.ALIGN_SIDEBAR_CLI || path.join(DSH_HOME, 'scripts', 'sidebar-cli', 'dsh-sidebar.mjs');
function needCli(file, env, what) {
  if (!fs.existsSync(file)) fail(what + ' 需要 dsh-threads / dsh-sidebar 脚本：找不到 ' + file + '。用环境变量 ' + env + ' 指向它的全路径（见 README「可选依赖」）。');
  return file;
}
/**
 * 调一次 dsh-threads 工具（复用 dsh-threads.mjs 的 main()，同 threadsSender），返回解析后的值；失败抛 UsageError，带 dsh-threads 的原始报错。
 * caller：带上调用方会话（$DSH_SESSION_ID），和直接跑 dsh-threads 一样（派活要它：新会话认得出是谁派的）。
 */
export async function threadsCall(tool, args, { caller = false } = {}) {
  const mod = await import(pathToFileURL(needCli(threadsCli(), 'ALIGN_THREADS_CLI', 'dsh-threads ' + tool)).href);
  let out = '', err = '', code;
  const env = { DSH_HOME, DSH_WEB_URL: process.env.DSH_WEB_URL || 'http://127.0.0.1:3080' };
  if (caller && process.env.DSH_SESSION_ID) env.DSH_SESSION_ID = process.env.DSH_SESSION_ID;
  try { code = await mod.main([tool, JSON.stringify(args)], env, { write: (s) => { out += s; } }, { write: (s) => { err += s; } }); }
  catch (e) { fail('dsh-threads ' + tool + ' 失败: ' + e.message); }
  if (code !== 0) fail('dsh-threads ' + tool + ' 失败: ' + (err.trim() || 'exit ' + code));
  try { return JSON.parse(out); } catch { fail('dsh-threads ' + tool + ' 的输出不是 JSON: ' + out.slice(0, 300)); }
}
/** 会话在不在：read_thread 报「No dsh thread found」就是不存在；别的错（3080 不可用等）原样报出，不当成存在。 */
export async function checkSidExists(sid) {
  try { await threadsCall('read_thread', { threadId: sid, turnLimit: 1 }); }
  catch (e) {
    if (/No dsh thread found/i.test(e.message)) fail('会话 ' + sid + ' 不存在（' + e.message + '）：核对 sid 再登记');
    fail('查不了会话 ' + sid + ' 在不在：' + e.message + '；确认 sid 无误、只是 3080 暂时不可用时，加 --no-check-sid 跳过存在性检查');
  }
}
/** round add / round set 的 sid= 校验：格式 + 存在（--no-check-sid 只跳过存在性）。sid= 空值（删掉）不查。 */
async function checkSidArg(kv, flags) {
  const v = kv.filter(([k]) => k === 'sid').map(([, x]) => x).pop();
  if (v === undefined || v === '') return;
  checkSidFormat(v);
  if (!flags['no-check-sid']) await checkSidExists(v);
}
const THREAD_STATUS = { active: '在跑', idle: '空闲', notLoaded: '空闲（没加载）', systemError: '出错' };
const TURN_END = { completed: '正常结束', failed: '出错', interrupted: '被打断', inProgress: '还在跑' };
const secWhen = (s) => (typeof s === 'number' ? nowIso(new Date(s * 1000)).slice(5, 16).replace('T', ' ') : '?');
/** 会话现状（read_thread）：在不在跑、最后一个回合（开始、结束、结束方式）、最后一句回复前 200 字。形状不符就报错。 */
export async function sessionNow(sid) {
  const v = await threadsCall('read_thread', { threadId: sid, turnLimit: 3, maxOutputCharsPerItem: 1000 });
  const st = v && v.thread && v.thread.status;
  if (!st || typeof st.type !== 'string' || !Array.isArray(v.turns) || (v.page && v.page.order !== 'newest_first')) fail('dsh-threads read_thread 返回的形状不对（缺 thread.status / turns，或不是 newest_first）: ' + JSON.stringify(v).slice(0, 300));
  const flagsTxt = Array.isArray(st.activeFlags) && st.activeFlags.length ? '（' + st.activeFlags.join(', ') + '）' : '';
  const lines = ['会话: ' + (THREAD_STATUS[st.type] || st.type) + flagsTxt + (v.thread.title ? ' · ' + v.thread.title : '')];
  const t = v.turns[0];
  if (!t) lines.push('最后回合: 还没有回合');
  else {
    const err = t.error ? '：' + (typeof t.error === 'string' ? t.error : t.error.message || JSON.stringify(t.error)) : '';
    lines.push('最后回合: ' + secWhen(t.startedAt) + ' 开始' + (t.completedAt ? '，' + secWhen(t.completedAt) + ' 结束' : '') + ' · ' + (TURN_END[t.status] || t.status) + err);
  }
  let reply;
  for (const turn of v.turns) {
    for (const it of [...(turn.items || [])].reverse()) if (it.type === 'agentMessage' && typeof it.text === 'string' && it.text.trim()) { reply = it.text; break; }
    if (reply !== undefined) break;
  }
  const flat = reply === undefined ? '' : reply.replace(/\s+/g, ' ').trim();
  lines.push('最后回复: ' + (reply === undefined ? '（最近 ' + v.turns.length + ' 个回合里没有文字回复）' : flat.slice(0, 200) + (flat.length > 200 ? '…' : '')));
  return lines;
}
/** round show：一轮的登记字段，每个一行（没有的写「—」），再加暂缓时段和挂着的决定。 */
export function roundShowLines(data, r) {
  const dash = (v) => (v === undefined || v === '' ? '—' : String(v));
  const lines = [
    'id: ' + r.id, 'title: ' + dash(r.title), '项目: ' + projTitle(data, r.proj) + (r.proj ? '（' + r.proj + '）' : ''),
    'status: ' + dash(r.status) + (r.mode ? ' · mode ' + r.mode : ''), 'sid: ' + dash(r.sid), 'stitle: ' + dash(r.stitle),
    'state: ' + dash(r.state), 'next: ' + dash(r.next), 'fault: ' + dash(r.fault), 'prev: ' + dash(r.prev) + (r.prevSid ? ' · prevSid ' + r.prevSid : ''),
    'handoff: ' + dash(r.handoff), 'started: ' + dash(r.started), 'updated: ' + dash(r.updated),
  ];
  if (r.ended) lines.push('ended: ' + r.ended);
  if (r.result) lines.push('result: ' + r.result);
  for (const p of r.pauses || []) lines.push('暂缓: ' + p.from + ' → ' + (p.to || '现在'));
  if (r.goal) lines.push('目标: ' + r.goal + ' ' + findGoal(data, r.goal).title);
  if (r.wait) { const w = findTodo(data, r.wait); lines.push('在等待办: ' + w.id + ' [' + TODO_LABEL[w.status] + '] ' + w.title); }
  const src = todoOfRound(data, r.id);
  if (src) lines.push('源自待办: ' + src.id + ' [' + TODO_LABEL[src.status] + '] ' + src.title);
  for (const d of data.decisions.filter((x) => x.round === r.id && ['open', 'sent', 'pending'].includes(x.status))) lines.push('决定: ' + d.id + ' [' + d.status + '] ' + d.title);
  for (const b of (data.btw || []).filter((x) => x.round === r.id && x.status === 'open')) lines.push('顺便问: ' + b.id + ' [open] ' + btwOpenTail(b));
  return lines;
}
/** sids：只读列出格式不对的 sid / prevSid（轮次、决定）。 */
export function badSidLines(data) {
  const out = [];
  for (const coll of ['rounds', 'decisions']) for (const it of data[coll]) for (const k of ['sid', 'prevSid']) {
    if (it[k] !== undefined && !SID_RE.test(it[k])) out.push(LABEL[coll] + '/' + it.id + ' ' + k + '=' + it[k] + ' · ' + it.title);
  }
  return out.length ? ['格式不对的 sid ' + out.length + ' 条（只列不改；改用 round set <页> <id> sid=<完整 sid>）', ...out].join('\n') : '没有格式不对的 sid（轮次 ' + data.rounds.length + ' 条、决定 ' + data.decisions.length + ' 条）';
}
/** pwsh 里可直接粘贴的一个参数。 */
const psArg = (s) => (/^[\p{L}\p{N}_./:=@-]+$/u.test(s) ? s : "'" + s.replace(/'/g, "''") + "'");
/** --cwd 试跑时的占位项目 id（工作区还没建）：只出现在试跑的页面副本里。 */
const CWD_TRIAL = 'dispatch-cwd-pending';
/** dispatch 的 --cwd：只用于 --mode new、不和 --proj 同用；目录要存在且是目录。返回绝对路径（没写 --cwd 返回 undefined）。 */
function dispatchCwd(flags) {
  if (flags.cwd === undefined) return undefined;
  if (!flags.cwd) fail('--cwd 不能为空');
  if (flags.proj !== undefined) fail('--cwd 和 --proj 只能写一个（--cwd <目录> 按目录找工作区，没有就建）');
  if (flags.mode !== 'new') fail('--cwd 只用于 --mode new（续发的会话已经有项目）');
  const dir = path.resolve(expandHome(flags.cwd));
  let st;
  try { st = fs.statSync(dir); } catch (e) { fail(e.code === 'ENOENT' ? '目录不存在: ' + dir : '读不了 ' + dir + ': ' + e.message); }
  if (!st.isDirectory()) fail('不是目录（是文件）: ' + dir);
  return dir;
}
/** 目录 → DSH 工作区（dsh-threads create_workspace：没有就由 3080 建，已有就返回），{projectId, path, title, created}；形状不对直接报错。 */
export async function ensureWorkspace(dir) {
  const v = await threadsCall('create_workspace', { path: dir });
  if (!v || typeof v.projectId !== 'string' || !v.projectId || typeof v.path !== 'string' || typeof v.title !== 'string' || typeof v.created !== 'boolean') {
    fail('dsh-threads create_workspace 返回的形状不对（要 {projectId, path, title, created}）: ' + JSON.stringify(v).slice(0, 300));
  }
  return v;
}
/**
 * dispatch：派活 + 登记。先在页面副本上把 round add 试跑一遍（参数错就不建会话），再 create_thread / send_message_to_thread，最后 round add。
 * --cwd：试跑之后、开会话之前先 create_workspace（目录已是工作区就直接用），新开的会话开在这个工作区里。
 */
async function dispatch(ref, [id, ...extra], kv, flags) {
  const usage = 'dispatch <页> <id> --prompt-file <文件> --mode new|continue [--prev <轮次>] [--handoff …] [--proj … | --cwd <目录>] title=… why=… ' + ETA_HINT;
  if (!id || extra.length) fail('用法: ' + usage);
  if (!flags['prompt-file']) fail('dispatch 要 --prompt-file <任务文件>（发给会话的 prompt）');
  const pf = path.resolve(expandHome(flags['prompt-file']));
  if (!fs.existsSync(pf) || !fs.statSync(pf).isFile()) fail('prompt 文件不存在: ' + pf);
  const prompt = fs.readFileSync(pf, 'utf8');
  if (!prompt.trim()) fail('prompt 文件是空的: ' + pf);
  if (kv.some(([k]) => k === 'sid')) fail('dispatch 自己填 sid（新开会话取 create_thread 返回的，续发取上一轮的），不要写 sid=');
  checkWritableMode(flags.mode, 'dispatch');
  const cwd = dispatchCwd(flags);
  const file = resolvePage(ref);
  const trial = readPage(file);
  need3(trial);
  const prev = flags.prev === undefined ? undefined : trial.rounds.find((x) => x.id === flags.prev);
  if (flags.prev !== undefined && !prev) fail('没有 id 为 ' + flags.prev + ' 的轮次（--prev）');
  const fresh = flags.mode === 'new';
  let sid;
  if (!fresh) {
    if (!prev) fail('续发（--mode continue）要 --prev <上一轮>：任务发给那一轮的会话');
    if (!prev.sid) fail('上一轮 ' + prev.id + ' 没有 sid，没法续发');
    checkSidFormat(prev.sid, '上一轮 ' + prev.id + ' 的 sid');
    sid = prev.sid;
  } else if (flags.proj === undefined && cwd === undefined && !(prev && prev.proj)) fail('新开会话要知道开在哪个项目：写 --proj <项目 id / 标题 / 目录> 或 --cwd <目录>（或 --prev 接一轮有项目的）');
  // 试跑：参数、项目、eta、handoff 都在建会话前查完（--cwd：工作区还没建，用占位项目试）
  const placeholder = sid || 'session-00000000-0000-4000-8000-000000000000';
  if (cwd !== undefined) trial.projects.push({ id: CWD_TRIAL, title: path.basename(cwd) || cwd, cwd });
  ops3['round add'](trial, nowIso(), [id], [...kv, ['sid', placeholder]], cwd === undefined ? flags : { ...flags, proj: CWD_TRIAL });
  prune(trial);
  validate(trial);
  const tr = trial.rounds.find((x) => x.id === id);
  if (fresh && !tr.proj) fail('新开会话要有项目（--proj 不能是未归属）');
  // 跟着 --prev 转过来、会话还不知道的顺便问（新开会话：全部；续发：还没转过的）写在任务后面
  const carried = (trial.btw || []).filter((b) => b.round === id && b.from && b.status === 'open' && (fresh || !btwLast(b).fwd));
  const sent = carried.length ? prompt.replace(/\s*$/, '') + '\n\n---\n\n' + btwPromptBlock(trial, pageRef(trial, file), carried) + '\n' : prompt;
  const ws = cwd === undefined ? undefined : await ensureWorkspace(cwd);
  const proj = ws ? ws.projectId : tr.proj;
  if (fresh) {
    const target = { type: 'project', projectId: proj, environment: { type: 'local' } };
    const v = await threadsCall('create_thread', { title: tr.stitle || tr.title, prompt: sent, target }, { caller: true });
    if (!v || !SID_RE.test(v.threadId)) fail('dsh-threads create_thread 没返回会话 id: ' + JSON.stringify(v).slice(0, 300));
    sid = v.threadId;
  } else await threadsCall('send_message_to_thread', { threadId: sid, prompt: sent }, { caller: true });
  const addFlags = { ...flags, proj: proj === undefined ? flags.proj : proj, [BTW_FWD]: carried.map((b) => b.id) };
  try {
    const { msg, data } = mutate(file, (d, now) => {
      need3(d);
      if (ws) ensureProject(d, { id: ws.projectId, title: ws.title, cwd: ws.path });
      return ops3['round add'](d, now, [id], [...kv, ['sid', sid]], addFlags);
    });
    const lines = [msg + ' → ' + file];
    if (ws) lines.push('工作区 ' + ws.title + '（' + ws.projectId + '，' + (ws.created ? '新建' : '已有') + '）：' + ws.path);
    lines.push('会话 ' + sid + (fresh ? '（新开，已发任务）' : '（续发，已发任务）'));
    if (prev) lines.push(...pendingLines(data, id, pageRef(data, file)), ...btwPendingLines(data, id, pageRef(data, file), { carried: true, inPrompt: carried.map((b) => b.id) }));
    return lines.join('\n');
  } catch (e) {
    const cmd = ['align', 'round', 'add', ref, id, '--mode', flags.mode, ...(flags.prev !== undefined ? ['--prev', flags.prev] : []), ...(flags.handoff !== undefined ? ['--handoff', flags.handoff] : []),
      ...(addFlags.proj !== undefined ? ['--proj', addFlags.proj] : []), ...(flags.todo !== undefined ? ['--todo', flags.todo] : []), ...kv.map(([k, v]) => k + '=' + v), 'sid=' + sid].map(psArg).join(' ');
    fail('会话 ' + sid + ' 已' + (fresh ? '新开并发了任务' : '收到任务') + '，但登记轮次失败：' + e.message + '\n会话 sid: ' + sid + '\n补登记: ' + cmd);
  }
}

/** 默认发送器：复用 dsh-threads CLI 的 main()，不带调用方会话（消息里没有来源会话）。 */
export function threadsSender(dshUrl, cli = threadsCli()) {
  return async (threadId, prompt) => {
    const mod = await import(pathToFileURL(needCli(cli, 'ALIGN_THREADS_CLI', '把决定 / 顺便问发到会话')).href);
    let out = '', err = '';
    const env = { DSH_HOME, DSH_WEB_URL: dshUrl };
    const code = await mod.main(['send_message_to_thread', JSON.stringify({ threadId, prompt })], env, { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
    if (code !== 0) throw new Error('发送到会话 ' + threadId + ' 失败: ' + err.trim());
    return out;
  };
}

/** 页面操作的出错：status 是 HTTP 状态码，code 是给手机等调用方的稳定错误码。 */
export class PageError extends Error {
  constructor(status, code, message, hint) { super(message); this.status = status; this.code = code; if (hint) this.hint = hint; }
}

/**
 * 所有登记的页面（只看登记表：forget 掉的不算）：[{name, title, updated, open, decisions}]。
 * 版本 3：open = 要你处理的卡数（api 7）—— 有 open 决定或 status=waiting 的轮次各算 1（决定嵌在轮次卡里，按轮次去重）；
 *   没挂轮次（或所挂轮次已不在页面上）的 open 决定嵌在项目卡里，每个项目算 1、未归属算 1。decisions = open 决定数（api 6 以前的 open）。
 * 版本 2：open = decisions = open 决定数。
 */
export function listPages() {
  return Object.entries(readRegistry()).map(([name, file]) => {
    const d = parsePage(fs.readFileSync(file, 'utf8'));
    if (d.version !== 3) { const n = d.items.filter((x) => x.sec === 'decide' && x.status === 'open').length; return { name, title: d.title, updated: d.updated, open: n, decisions: n }; }
    // btwNew（api 16）：顺便问里有新回答、还没「了解」的条数；不进 open（要你处理的卡数）
    return { name, title: d.title, updated: d.updated, open: cardCount(d), decisions: d.decisions.filter((x) => x.status === 'open').length, btwNew: (d.btw || []).filter(btwUnseen).length };
  });
}
/** 版本 3 页面上要你处理的卡数（见 listPages）。 */
export function cardCount(data) {
  const rounds = new Set(data.rounds.map((r) => r.id)), cards = new Set();
  for (const r of data.rounds) if (r.status === 'waiting') cards.add('round/' + r.id);
  for (const d of data.decisions) if (d.status === 'open') cards.add(rounds.has(d.round) ? 'round/' + d.round : 'proj/' + (d.proj ?? ''));
  return cards.size;
}

function pageFile(name) {
  const file = typeof name === 'string' ? readRegistry()[name] : undefined;
  if (!file) throw new PageError(404, 'page-not-found', '没有登记名为 ' + name + ' 的页面');
  return file;
}

// ---- 附件里的本地文件（只读）-----------------------------------------------------------------------
const FILE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const TEXT_EXT = new Set(['.md', '.txt', '.log', '.json', '.jsonl', '.csv', '.yml', '.yaml', '.html', '.htm', '.mjs', '.js', '.ts', '.ps1', '.py']);
/** 看起来像密钥 / 凭据的文件名一律不给（即使被挂成附件）。 */
const SECRET_NAME = /(^\.env|\.(pem|key|p12|pfx|kdbx)$|token|secret|credential|password|id_rsa|id_ed25519)/i;
/** 可读的目录：DSH_HOME/tmp、页面文件所在目录、页面各项目目录。 */
function fileRoots(data, pagePath) {
  // 真实路径比较（8.3 短名、符号链接都展开）；不存在的目录跳过
  const real = (p) => { try { return fs.realpathSync.native(path.resolve(expandHome(p))); } catch { return null; } };
  return [path.join(DSH_HOME, 'tmp'), path.dirname(pagePath), ...(data.projects || []).map((p) => p.cwd)].map(real).filter(Boolean).map(normPath);
}
const inside = (p, root) => p === root || p.startsWith(root + path.sep);
/** 文件所在的 git 仓库根（往上找 .git，目录或 worktree 的 .git 文件都算）；不在仓库里是 null。 */
export function gitRoot(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
/** 盘符根、用户主目录本身是仓库时不算（不能借它放开整个盘或整个主目录）。 */
const tooBroad = (dir) => path.parse(dir).root === dir || normPath(dir) === normPath(os.homedir());
/** 会话日志 DSH_HOME/sessions/<项目>/<sid>/session.v4.jsonl.zstd；没有就是 null（这时不多给可读目录）。 */
function sessionLog(sid) {
  if (typeof sid !== 'string' || !/^[a-z0-9-]{8,80}$/i.test(sid)) return null;
  const root = path.join(DSH_HOME, 'sessions');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  for (const d of dirs) for (const n of LOG_NAMES) { const f = path.join(root, d, sid, n); if (fs.existsSync(f)) return f; }
  return null;
}
const usedCache = new Map();
/**
 * 会话读写过的绝对路径（normPath 后）：会话 cwd，加上每次工具调用参数里的 file_path / path / workdir / cwd
 * （直接调用的 tool/call 和 run_code 里的 tool/ptc-dispatch 都算）。日志按 mtime + 大小缓存。
 */
export function sessionPaths(sid) {
  const f = sessionLog(sid);
  if (!f) return [];
  const st = fs.statSync(f), k = st.mtimeMs + ':' + st.size, hit = usedCache.get(f);
  if (hit && hit.k === k) return hit.paths;
  const out = new Set();
  const add = (p) => { if (typeof p === 'string' && p && path.isAbsolute(p)) out.add(normPath(p)); };
  for (const line of decodeLog(fs.readFileSync(f)).split('\n')) {
    const head = line.startsWith('{"type":"session"'), call = line.startsWith('{"type":"tool/call"') || line.startsWith('{"type":"tool/ptc-dispatch"');
    if (!head && !call) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; } // 正在写的最后一行可能不完整
    if (head) { add(ev.cwd); continue; }
    let a = ev.data && ev.data.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { continue; } }
    if (a && typeof a === 'object') for (const key of ['file_path', 'path', 'workdir', 'cwd']) add(a[key]);
  }
  const paths = [...out];
  usedCache.set(f, { k, paths });
  return paths;
}
const listsRef = (it, ref) => (it.img || []).some((a) => a.src === ref) || (it.link || []).some((a) => a.href === ref) || it.handoff === ref;
const COPY_HINT = '复制路径后在本机打开。';
/**
 * 页面附件里的本地文件：只给这一页某条目 img / link / handoff 里登记过的绝对路径，文件名不像密钥，且真实路径（解析符号链接后）
 *   ① 在 fileRoots 里，或
 *   ② 在某个 git 仓库里（仓库根不是盘符根、不是用户主目录），而挂它的条目所属会话（轮次 sid；决定取自己的 sid 或所挂轮次的 sid）
 *      在会话日志里读写过这个仓库里的路径（sessionPaths），或
 *   ③ 本身是真图片（isImageFile）：不看目录。截图常放在项目外（2026-11-01：D:\games 下的截图在家里电脑和手机上都打不开）；
 *      能登记附件的只有本机 agent 经 align CLI，页面接口写不了 img / link / handoff，所以远程也只能看到页面上引用了的图片，读不到别的文件。
 * 图片按类型返回，文本一律 text/plain（不在 DSH 的源上执行页面或脚本），其他类型拒绝。
 * 返回 {type, body}；不允许时抛 PageError(403 / 404)：message 是给人看的原因，hint 是下一步。
 */
export function attachmentFile(name, ref, via) {
  const file = pageFile(name);
  const data = parsePage(fs.readFileSync(file, 'utf8'));
  if (data.version !== 3) throw new PageError(404, 'no-attachments', '这一页没有附件');
  if (typeof ref !== 'string' || !path.isAbsolute(ref)) throw new PageError(400, 'bad-path', 'path 要是绝对路径');
  if (via != null) return docImage(name, ref, via);
  const owners = [...COLLS.flatMap((c) => data[c].filter((it) => listsRef(it, ref))), ...(data.btw || []).filter((it) => listsRef(it, ref))];
  if (!owners.length) throw new PageError(403, 'not-attached', '这个文件没有挂在这一页上，对齐页不提供', COPY_HINT);
  let real;
  try { real = fs.realpathSync.native(ref); } catch { throw new PageError(404, 'file-missing', '文件不在了，可能被移走或删掉了', '让负责的会话重新挂一次附件。'); }
  const key = process.platform === 'win32' ? real.toLowerCase() : real;
  if (!fileRoots(data, file).some((r) => inside(key, r)) && !isImageFile(real)) {
    const repo = gitRoot(real);
    const sids = new Set(owners.map((it) => it.sid || (it.round && (data.rounds.find((r) => r.id === it.round) || {}).sid)).filter(Boolean));
    const used = repo && !tooBroad(repo) && [...sids].some((sid) => sessionPaths(sid).some((p) => inside(p, normPath(repo))));
    if (!used) {
      throw new PageError(403, 'outside-roots', repo && !tooBroad(repo)
        ? '这个文件在 ' + path.basename(repo) + ' 仓库里，负责的会话没用过这个仓库，对齐页没权限读'
        : '这个文件不在项目目录或 git 仓库里，对齐页没权限读', COPY_HINT);
    }
  }
  if (SECRET_NAME.test(path.basename(real))) throw new PageError(403, 'secret-like', '文件名像密钥或凭据，对齐页不显示这类文件', COPY_HINT);
  if (!fs.statSync(real).isFile()) throw new PageError(404, 'file-missing', '这是文件夹，对齐页只显示文件', COPY_HINT);
  const ext = path.extname(real).toLowerCase();
  const type = FILE_TYPES[ext] || (TEXT_EXT.has(ext) ? 'text/plain; charset=utf-8' : null);
  if (!type) throw new PageError(403, 'type-not-served', '对齐页不显示 ' + (ext || '没有扩展名的') + ' 文件', COPY_HINT);
  return { type, body: fs.readFileSync(real) };
}

// ---- 留言图片（api 14）：留言框里粘贴 / 拖进来的图片先单独上传存成文件；留言发出时消息里带本机绝对路径，First Mate 用 read_image 直接读 ----
/** 一条留言最多几张图、单张最大字节（单张上限同 DSH 附件存储的默认值：再大 read_image 也收不下）。页面同名常量与它一致。 */
export const MEMO_IMAGES_MAX = 5;
export const MEMO_IMAGE_BYTES = 20 * 1024 * 1024;
const MEMO_NOT_IMAGE = '仅支持 PNG、JPG、WebP、GIF 格式的图片';
const MEMO_TOO_BIG = '图片超过 ' + MEMO_IMAGE_BYTES / 1048576 + ' MB';
/** <STORE>/memo-images/<YYYY-MM-DD>/<内容 sha256 前 16 位>.<扩展名>：按天分目录，同一天同一张图只存一份；上传时顺带删 30 天前的日期目录（pruneMemoImages）。 */
const MEMO_IMAGE_DIR = path.join(STORE, 'memo-images');
const MEMO_IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 按文件头认格式（不信请求里声明的类型）；不是这四种返回 null。 */
function sniffImage(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
/** 真图片：是文件，扩展名是图片，文件头也认得出是 PNG / JPG / GIF / WebP（SVG 是文本、认不出，不算）。页面引用的文件只有过了这一条才不看目录（见 attachmentFile ③）。 */
function isImageFile(real) {
  if (!FILE_TYPES[path.extname(real).toLowerCase()] || !fs.statSync(real).isFile()) return false;
  const fd = fs.openSync(real, 'r'), head = Buffer.alloc(12);
  try { return sniffImage(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0))) !== null; } finally { fs.closeSync(fd); }
}
/** 存一张留言图片，返回 {path（真实绝对路径）, type, bytes}；太大、不是图片抛 PageError。 */
export function saveMemoImage(body) {
  if (body.length > MEMO_IMAGE_BYTES) throw new PageError(413, 'image-too-large', MEMO_TOO_BIG);
  const ext = sniffImage(body);
  if (!ext) throw new PageError(400, 'not-image', MEMO_NOT_IMAGE);
  const day = path.join(MEMO_IMAGE_DIR, nowIso().slice(0, 10));
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(fs.realpathSync.native(day), sha(body).slice(0, 16) + '.' + ext);
  if (!fs.existsSync(file)) {
    const tmp = file + '.' + process.pid + '-' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, body);
    renameOver(tmp, file);
  }
  return { path: file, type: MEMO_IMAGE_TYPES[ext], bytes: body.length };
}
/** 留言图片保留天数：日期目录比今天早 30 天以上（目录里最晚的图也满 30 天）就整个删掉。 */
export const MEMO_KEEP_DAYS = 30;
/** 'YYYY-MM-DD' → 距 1970-01-01 的天数；不是真实日期（名字不对、2026-02-31）返回 null。 */
function dayNumber(name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return null;
  const [y, m, d] = name.split('-').map(Number), t = Date.UTC(y, m - 1, d);
  return new Date(t).toISOString().slice(0, 10) === name ? t / 864e5 : null;
}
/** 删过期的留言图片日期目录，返回删掉的目录名。只动 memo-images 下一层、名字是真实日期的真目录（junction / 符号链接 / 文件 / 别的名字都不动），
 *  删前核对它的真实路径就在 memo-images 下，不在就抛错不删。由 POST /image 回复之后顺带调用（3080、3390 共用），不另起常驻任务。 */
export function pruneMemoImages() {
  if (!fs.existsSync(MEMO_IMAGE_DIR)) return [];
  const root = fs.realpathSync.native(MEMO_IMAGE_DIR), today = dayNumber(nowIso().slice(0, 10)), out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const day = dayNumber(name);
    if (day === null || today - day <= MEMO_KEEP_DAYS) continue;
    const full = path.join(root, name), st = fs.lstatSync(full);
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const real = fs.realpathSync.native(full);
    if (normPath(path.dirname(real)) !== normPath(root) || normPath(real) !== normPath(full)) throw new Error('留言图片日期目录不在 memo-images 下，不删: ' + full + ' -> ' + real);
    fs.rmSync(full, { recursive: true });
    out.push(name);
  }
  return out;
}
const memoRoot = () => { try { return normPath(fs.realpathSync.native(MEMO_IMAGE_DIR)); } catch { return null; } };
/** 路径写在 memo-images 下：/file 按留言图片给，不按条目附件查。 */
const isMemoImageRef = (ref) => typeof ref === 'string' && path.isAbsolute(ref) && [normPath(MEMO_IMAGE_DIR), memoRoot()].some((r) => r && inside(normPath(ref), r));
/** 留言图片的真实路径：解析符号链接后仍在 memo-images 下、是文件、扩展名是这四种图片；否则 null。 */
function memoImageReal(ref) {
  const root = memoRoot();
  if (!root || typeof ref !== 'string' || !path.isAbsolute(ref)) return null;
  let real;
  try { real = fs.realpathSync.native(ref); } catch { return null; }
  if (!inside(normPath(real), root) || !MEMO_IMAGE_TYPES[path.extname(real).slice(1).toLowerCase()] || !fs.statSync(real).isFile()) return null;
  return real;
}
/** /file 给留言图片（留言框里的缩略图，刷新后从这里重新取）。 */
export function memoImageFile(ref) {
  const real = memoImageReal(ref);
  if (!real) throw new PageError(404, 'file-missing', '图片不在了，可能已被移走或删掉', '移除后重新粘贴');
  return { type: MEMO_IMAGE_TYPES[path.extname(real).slice(1).toLowerCase()], body: fs.readFileSync(real) };
}
/** answers 里留言的 images：每项都要是存在的留言图片，返回去重后的真实路径。 */
function memoImagesOf(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) throw new PageError(400, 'bad-request', 'images 要是图片路径的数组');
  if (list.length > MEMO_IMAGES_MAX) throw new PageError(400, 'too-many-images', '一条留言最多 ' + MEMO_IMAGES_MAX + ' 张图片，现在 ' + list.length + ' 张');
  const out = [];
  for (const [i, p] of list.entries()) {
    const real = memoImageReal(p);
    if (!real) throw new PageError(400, 'bad-image', '图片 ' + (i + 1) + ' 不在了，可能已被移走或删掉', '移除后重新粘贴');
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** Markdown 里的图片地址：![说明](地址 "标题")、![说明](<地址>)。 */
export const mdImageRefs = (text) => [...text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g)].map((m) => m[1] || m[2]);
/**
 * 样式里的地址：按 CSS 分词规则只认真的 url(…)（带不带引号都算）；注释、字符串里的、xurl( 这类别的函数不算；
 * 带反斜杠转义、换行或写得不合法的地址跳过（浏览器会还原成别的字，只会少放行）。
 */
export function cssRefs(s) {
  const out = [], WS = /[\t\n\f\r ]/;
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1; i = j + 1; continue; }
    if (c === '\\') { i += 2; continue; }
    if (!/^url\(/i.test(s.slice(i, i + 4)) || /[\w\u0080-\uffff-]/.test(s[i - 1] || '')) { i++; continue; }
    let j = i + 4;
    while (j < s.length && WS.test(s[j])) j++;
    let v = null;
    if (s[j] === '"' || s[j] === "'") {
      const e = s.indexOf(s[j], j + 1);
      if (e > 0) { const body = s.slice(j + 1, e); let k = e + 1; while (k < s.length && WS.test(s[k])) k++; if (s[k] === ')' && !/[\\\n]/.test(body)) v = body; j = k; } else j = s.length;
    } else {
      const e = s.indexOf(')', j);
      const body = s.slice(j, e < 0 ? s.length : e).replace(/[\t\n\f\r ]+$/, '');
      if (e > 0 && !/[\t\n\f\r "'(\\]/.test(body)) v = body;
      j = e < 0 ? s.length : e;
    }
    if (v !== null && v.trim()) out.push(v.trim());
    i = j + 1;
  }
  return out;
}
const NAMED_REF = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
/**
 * 属性值里的字符引用按浏览器还原：&#32; / &#x20;（分号可省）和带分号的 &amp; &lt; &gt; &quot; &apos; &nbsp;。
 * 还原不准的（别的名字、不带分号的名字、C1 区和超范围的编号这类浏览器会换成别的字、单独的 &）整个值作废，返回 null：
 * 放行按的是还原后的路径，和浏览器不一致就可能放行到另一个文件。
 */
function decodeAttr(s) {
  let bad = false;
  const out = s.replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*);|)/g, (all, d, h, n) => {
    if (n !== undefined) { if (Object.hasOwn(NAMED_REF, n)) return NAMED_REF[n]; bad = true; return all; }
    if (d === undefined && h === undefined) { bad = true; return all; }
    const c = parseInt(d ?? h, d !== undefined ? 10 : 16);
    if (c === 0 || c > 0x10ffff || (c >= 0x80 && c <= 0x9f) || (c >= 0xd800 && c <= 0xdfff)) { bad = true; return all; }
    return String.fromCodePoint(c);
  });
  return bad ? null : out;
}
const HTML_WS = /[\t\n\f\r ]/;
/**
 * 一个标签从标签名读到 '>'（i 指向标签名第一个字符），按 HTML 规范的分词规则读属性：引号、斜杠、等号的各种写法，重名属性取第一个。
 * 返回 {name, at, end, closed}：end 是 '>' 之后的位置；读到头都没有 '>' 时 closed=false（浏览器不生成这个元素）。
 */
function readTag(s, i) {
  let j = i;
  while (j < s.length && !HTML_WS.test(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
  const name = s.slice(i, j).toLowerCase(), at = {};
  for (;;) {
    while (j < s.length && (HTML_WS.test(s[j]) || s[j] === '/')) j++;
    if (j >= s.length) return { name, at, end: s.length, closed: false };
    if (s[j] === '>') return { name, at, end: j + 1, closed: true };
    const k = j++; // 属性名的第一个字符可以是 '='
    while (j < s.length && !HTML_WS.test(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++;
    const an = s.slice(k, j).toLowerCase();
    while (j < s.length && HTML_WS.test(s[j])) j++;
    let v = '';
    if (s[j] === '=') {
      j++;
      while (j < s.length && HTML_WS.test(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0) return { name, at, end: s.length, closed: false };
        v = s.slice(j + 1, e); j = e + 1;
      } else if (q !== '>') { const v0 = j; while (j < s.length && !HTML_WS.test(s[j]) && s[j] !== '>') j++; v = s.slice(v0, j); }
    }
    if (!Object.hasOwn(at, an)) at[an] = decodeAttr(v);
  }
}
/** 脚本的结束位置（按规范的 script data / escaped / double escaped 三个状态：<!--<script> 里的 </script> 不结束脚本）；没有就是长度。 */
function scriptEnd(s, i) {
  const re = /<!--|-->|<\/script[\t\n\f\r />]|<script[\t\n\f\r />]/gi;
  let st = 'data';
  re.lastIndex = i;
  for (let m; (m = re.exec(s));) {
    const t = m[0].toLowerCase();
    if (t === '<!--') { if (st === 'data') { st = 'escaped'; re.lastIndex = m.index + 2; } }
    else if (t === '-->') { if (st !== 'data') st = 'data'; }
    else if (t.startsWith('</')) { if (st === 'double') st = 'escaped'; else return m.index; }
    else if (st === 'escaped') st = 'double';
  }
  return s.length;
}
// 内容不按标签读的元素（RAWTEXT / RCDATA）；在 SVG / MathML 里它们其实按标签读，这里一律跳过：只会少放行
const RAW_TEXT = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes', 'textarea', 'title']);
/**
 * 网页里会被页面取回内嵌的地址（与 template.html 的 htmlFrame 一致）：<img src>、<video poster>、<link rel=stylesheet href>、style 属性和 <style> 里的 url(…)。
 * 按 HTML 规范从左到右分词：注释、<!…> / <?…>、CDATA、属性值里的尖括号、脚本和 RAW_TEXT 元素的内容、<template> 里（可嵌套）、没写完的标签都不算；
 * <select> 里的不算（各版本浏览器丢弃的规则不同）；出现 <frameset> 就一个都不算（它会把整个正文换掉）；<plaintext> 之后不再算。
 * 浏览器会改写的、拿不准的地方一律少算（最多是某张图不显示），不多算：template.html 的 doc-diff 探针拿 Chromium 的解析结果对拍过。
 * 返回 {refs, sheets}：sheets 是 <link rel=stylesheet> 的 href（它们里面 url(…) 引用的图片也给）。
 */
export function htmlRefs(text) {
  const s = text.replace(/\r\n?/g, '\n'), refs = [], sheets = [];
  // foreign：还没关上的 <svg> / <math>（栈；只有和栈顶同名的结束标签才弹出，浏览器跳出外部内容的其他情形不跟，只会少放行）。
  // 在里面的元素不是网页元素，style 等也不按原文读，一律不算
  let i = 0, tpl = 0, sel = false;
  const foreign = [];
  const skipTo = (str, from) => { const e = s.indexOf(str, from); return e < 0 ? s.length : e + str.length; };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;
    if (s.startsWith('!--', i)) {
      if (s.startsWith('>', i + 3)) { i += 4; continue; }
      if (s.startsWith('->', i + 3)) { i += 5; continue; }
      const m = /--!?>/g; m.lastIndex = i + 3;
      const e = m.exec(s); i = e ? e.index + e[0].length : s.length; continue;
    }
    // CDATA 只在 SVG / MathML 里是真的；网页里它是一段到第一个 '>' 为止的注释
    if (s.startsWith('![CDATA[', i) && foreign.length) { i = skipTo(']]>', i); continue; }
    if (s[i] === '!' || s[i] === '?') { i = skipTo('>', i); continue; }
    if (s[i] === '/') {
      if (/[a-zA-Z]/.test(s[i + 1] || '')) { const t = readTag(s, i + 1); i = t.end; if (t.name === 'template' && tpl > 0) tpl--; if (foreign.at(-1) === t.name) foreign.pop(); if (t.name === 'select') sel = false; }
      else i = s[i + 1] === '>' ? i + 2 : skipTo('>', i);
      continue;
    }
    if (!/[a-zA-Z]/.test(s[i] || '')) continue;
    const t = readTag(s, i);
    if (!t.closed) break;
    i = t.end;
    if (t.name === 'frameset') return { refs: [], sheets: [] };
    if (t.name === 'plaintext') break;
    if (t.name === 'select') { sel = true; continue; }
    if (t.name === 'template') { tpl++; continue; }
    if (t.name === 'svg' || t.name === 'math') { foreign.push(t.name); continue; }
    if (t.name === 'script') { i = scriptEnd(s, i); continue; }
    if (RAW_TEXT.has(t.name)) {
      const m = new RegExp('</' + t.name + '[\\t\\n\\f\\r />]', 'gi'); m.lastIndex = i;
      const e = m.exec(s), body = s.slice(i, e ? e.index : s.length);
      i = e ? e.index : s.length;
      // 样式里有 '<' 时可能是 SVG 里的 <style>（内容按标签读），不算
      if (t.name === 'style' && tpl === 0 && !foreign.length && !sel && !body.includes('<')) refs.push(...cssRefs(body));
      continue;
    }
    if (tpl > 0 || foreign.length || sel) continue;
    const at = t.at;
    // 值是 null：字符引用还原不准，不算
    if (at.style) refs.push(...cssRefs(at.style));
    if ((t.name === 'img' || t.name === 'image') && at.src) refs.push(at.src.trim()); // 网页里的 <image> 浏览器当 <img>
    else if (t.name === 'video' && at.poster) refs.push(at.poster.trim());
    else if (t.name === 'link' && at.href && typeof at.rel === 'string' && /(^|[\t\n\f\r ])stylesheet([\t\n\f\r ]|$)/i.test(at.rel)) { refs.push(at.href.trim()); sheets.push(at.href.trim()); }
  }
  return { refs, sheets };
}
const DOC_MD = /\.(md|markdown)$/i, DOC_HTML = /\.html?$/i;
/** 文档里的本地地址 → 绝对路径（normPath 后）：去掉 ?查询 和 #锚点，相对路径按 dir 解析；网址、data:、站内锚点不算。 */
const localRefs = (list, dir) => list
  .filter((s) => s && !s.startsWith('#') && !s.startsWith('//') && (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[a-z]:[\\/]/i.test(s)))
  .map((s) => { s = s.split(/[?#]/)[0]; try { s = decodeURI(s); } catch { /* 原样 */ } return s && path.resolve(dir, s); })
  // 网络路径（\\主机\共享）不算：连判断文件头都会向那台机器发起登录
  .filter((p) => p && !/^[\\/]{2}/.test(p))
  .map(normPath);
/**
 * 页面上 Markdown / HTML 附件里引用的文件（via = 那份文档的路径，同样要过 attachmentFile 的全部检查）：
 * Markdown 只给图片；HTML 给图片和样式表（.css），以及它用 <link rel=stylesheet> 引用的样式表里 url(…) 引用的图片（再往下的 @import 不算）；哪些算引用见 htmlRefs。
 * 都要文档里确实引用了它（相对路径按文档所在目录解析，样式表里的按样式表所在目录），真实路径在文档所在的 git 仓库里（不在仓库里就限文档所在目录）
 * 或本身是真图片（isImageFile）；样式表只认仓库里的。
 */
function docImage(name, ref, via) {
  const html = typeof via === 'string' && DOC_HTML.test(via);
  if (typeof via !== 'string' || !(html || DOC_MD.test(via))) throw new PageError(400, 'bad-path', '只能取这一页挂着的 Markdown 或 HTML 文件里引用的文件');
  const doc = attachmentFile(name, via);
  const ext = path.extname(ref).toLowerCase();
  const type = FILE_TYPES[ext] || (html && ext === '.css' ? 'text/css; charset=utf-8' : null);
  if (!type) throw new PageError(403, 'type-not-served', html ? '网页里这个文件不是图片或样式表，对齐页不提供' : '文档里这张图的文件不是图片格式，对齐页不显示', COPY_HINT);
  const realDoc = fs.realpathSync.native(via), repo = gitRoot(realDoc);
  const scope = normPath(repo && !tooBroad(repo) ? repo : path.dirname(realDoc));
  const text = doc.body.toString('utf8'), dir = path.dirname(via);
  const got = html ? htmlRefs(text) : { refs: mdImageRefs(text), sheets: [] };
  const refs = localRefs(got.refs, dir);
  const want = normPath(ref);
  if (html && !refs.includes(want) && FILE_TYPES[ext]) {
    // 网页用 <link rel=stylesheet> 引用的样式表（仓库里、名字不像密钥的文件）里提到的图片
    for (const css of new Set(localRefs(got.sheets, dir))) {
      let real;
      try { real = fs.realpathSync.native(css); } catch { continue; }
      if (!inside(normPath(real), scope) || SECRET_NAME.test(path.basename(real)) || !fs.statSync(real).isFile()) continue;
      if (localRefs(cssRefs(fs.readFileSync(real, 'utf8')), path.dirname(css)).includes(want)) { refs.push(want); break; }
    }
  }
  const what = ext === '.css' ? '样式表' : '图片';
  if (!refs.includes(want)) throw new PageError(403, 'not-attached', '这个' + what + '不在这份文档里，对齐页不提供', COPY_HINT);
  let real;
  try { real = fs.realpathSync.native(ref); } catch { throw new PageError(404, 'file-missing', what + '文件不在了，可能被移走或删掉了', '让写文档的会话检查文件路径。'); }
  if (!inside(normPath(real), scope) && !isImageFile(real)) throw new PageError(403, 'outside-roots', '这个' + what + '不在文档所在的仓库里，对齐页没权限读', COPY_HINT);
  if (SECRET_NAME.test(path.basename(real))) throw new PageError(403, 'secret-like', '文件名像密钥或凭据，对齐页不显示这类文件', COPY_HINT);
  if (!fs.statSync(real).isFile()) throw new PageError(404, 'file-missing', '这是文件夹，对齐页只显示文件', COPY_HINT);
  return { type, body: fs.readFileSync(real) };
}

/** 页面在详情区排版 Markdown 用的两个库（cli/vendor，原样拷自 marked 16.4.2、DOMPurify 3.4.14），按需加载。 */
const VENDOR = { marked: 'marked.js', purify: 'purify.js' }, vendorCache = {};
export function vendorFile(n) {
  if (!Object.hasOwn(VENDOR, n)) throw new PageError(404, 'no-lib', '没有这个库');
  return (vendorCache[n] ??= fs.readFileSync(path.join(HERE, 'vendor', VENDOR[n])));
}

/** 一页的数据对象（与页面里的数据块相同，版本 2 或 3 原样）。 */
export function pageData(name) {
  return parsePage(fs.readFileSync(pageFile(name), 'utf8'));
}

/**
 * 回复一个决定：校验 → send(会话 id, 消息, 卡片数据) 发给负责的会话 → 条目改成 sent。返回 {data, sid, item, choice}。
 * body = {id, choice, note}；send 失败时抛 PageError(500, 'send-failed', 原始原因)，页面不变。
 * 版本 3 只针对 decisions（open / sent；done 的视为已不在页面上）。
 */
export async function answerDecision(name, body, send) {
  const file = pageFile(name);
  if (!body || typeof body !== 'object') throw new PageError(400, 'bad-request', '请求内容必须是对象');
  const choice = typeof body.choice === 'string' ? body.choice : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  const data = parsePage(fs.readFileSync(file, 'utf8'));
  const pool = (d) => (d.version === 3 ? d.decisions.filter(live) : d.items.filter((x) => x.sec === 'decide'));
  const it = pool(data).find((x) => x.id === body.id);
  if (!it) throw new PageError(404, 'decision-not-found', '这条决定已不在页面上（可能已处理），刷新看看');
  if (choice && !(it.opt || []).some((o) => o.label === choice)) throw new PageError(400, 'unknown-option', '没有这个选项: ' + choice);
  if (!choice && !note) throw new PageError(400, 'empty-answer', '没有选项也没有文字');
  const sid = it.sid || data.owner;
  if (!sid) throw new PageError(400, 'no-target-session', '这条决定没有记录该发给哪个会话，请在对话里回复');
  try { await send(sid, messageFor(data, it, choice, note, file), decisionCard(data, [{ it, choice, note }])); }
  catch (e) { throw new PageError(500, 'send-failed', e.message); }
  const { data: after } = mutate(file, (d, now) => {
    const x = pool(d).find((y) => y.id === it.id);
    if (!x) fail('写回时条目已不在');
    Object.assign(x, { status: 'sent', choice, answered: now, updated: now });
    if (note) x.reply = note; else delete x.reply;
    delete x.auto; delete x.autoAt; // 用户自己答了：不再是超时按推荐
    return '';
  });
  return { data: after, sid, item: it.id, choice };
}

/** 页面上的轮次操作 → 中文名（消息与卡片里用）、允许的轮次状态、给 First Mate 的处理命令。 */
const ROUND_ACTIONS = {
  done: { label: '已完成', from: ['doing', 'waiting'], cmd: (page, id) => 'round done ' + page + ' ' + id + ' result=… ' + VISUAL_ARG },
  // done（交了结果、等验收）上给「确认」「修改」和「放弃」：验收不通过可以放弃；不给暂缓 —— 结果已经交了，没有在跑的活可停，要返工由 First Mate 登记一轮续发（dispatch --prev --mode continue）
  // 暂缓的轮次也能放弃（2026-10-27：用户在手机上放弃暂缓的轮次被 400 拒）
  dropped: { label: '放弃', from: ['doing', 'waiting', 'paused', 'done'], cmd: (page, id) => 'round set ' + page + ' ' + id + ' status=dropped result=<放弃原因>' },
  paused: { label: '暂缓', from: ['doing', 'waiting'], cmd: (page, id) => 'round set ' + page + ' ' + id + ' status=paused' },
  resume: { label: '恢复', from: ['paused'], cmd: (page, id) => 'round set ' + page + ' ' + id + ' status=doing' },
  accept: { label: '确认', from: ['done'], cmd: (page, id) => 'round accept ' + page + ' ' + id },
  // v8：待验收的「修改」—— 意见必填，First Mate 按意见返工：登记一轮续发（2026-11-03：只 round set status=doing 时页面数不到续发 ⟲N）
  revise: { label: '修改', from: ['done'], cmd: (page, id, data) => reviseCmd(data, page, id) },
};
/** 「修改」续发的新轮次 id：<id>-2，已被占用就顺延 -3、-4…；本身以 -N 结尾的接着编号（job-2 → job-3，不叠成 job-2-2）。 */
export function reviseId(data, id) {
  const m = /^(.*\D)-(\d+)$/.exec(id) || /^(.*)-(\d+)$/.exec(id);
  const base = m ? m[1] : id, used = allIds(data);
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) {
    const tail = '-' + n, nid = base.slice(0, 48 - tail.length).replace(/-+$/, '') + tail;
    if (!used.has(nid)) return nid;
  }
}
/** 「修改」的处理命令（不带前面的 align）：登记一轮续发；换会话写法跟在括号里。 */
function reviseCmd(data, page, id) {
  const r = data.rounds.find((x) => x.id === id);
  return 'dispatch ' + page + ' ' + reviseId(data, id) + ' --prompt-file <返工任务文件> --prev ' + id + ' --mode continue ' + psArg('title=返工：' + (r ? r.title : '…')) + " 'why=用户点了修改' eta=… eta75=… etaconf=…"
    + '（任务文件写修改意见和验收；要换会话就把 --mode continue 换成 --mode new --handoff <交接文件>）';
}
const kindOf = (p) => p.kind || 'decision';
/** 用户留言（answers 里的 {kind:'message'}）上限；页面输入框的 maxlength 与它一致。 */
export const MESSAGE_MAX = 4000;
/** 答复的作用范围：卡片里接在选择后面的词、消息里的说明。 */
const SCOPE_CARD = { project: '（这个项目都这样）', always: '（以后同类都这样）' };
const SCOPE_TEXT = { project: '这个项目', always: '以后同类都这样' };
const ruleChoice = (d) => d.choice || d.result || '（只写了一句话）';

/**
 * 卡片数据：send 的第三个参数。3080 插件按它把消息在 DSH 网页里画成卡片（只显示这些字段），
 * 模型收到的仍是 messageFor / batchMessageFor 的全文；3390 本机服务的 threadsSender 不用它。
 * 形状固定 {page, decisions:[{title, choice, note}]}：轮次写成「轮次：<标题>」+ 操作中文名，须知写成「须知：<标题>」+ 已了解 / 恢复为未读。
 */
export function decisionCard(data, picks) {
  return { page: data.title, decisions: picks.map((p) => {
    const kind = kindOf(p);
    if (kind === 'round') return { title: '轮次：' + p.it.title, choice: ROUND_ACTIONS[p.action].label, note: p.note };
    if (kind === 'note') return { title: '须知：' + p.it.title, choice: p.ack ? '已了解' : '恢复为未读', note: p.note };
    if (kind === 'rule') return { title: '长期规则：' + p.it.like, choice: '撤销', note: p.note };
    if (kind === 'message') return { title: '用户留言', choice: '', note: [p.text, p.images && p.images.length ? '附图 ' + p.images.length + ' 张' : ''].filter(Boolean).join('\n') };
    if (kind === 'btw') return { title: '顺便问：' + p.r.title, choice: '', note: p.q };
    if (kind === 'btw-more') return { title: '继续追问：' + btwLast(p.b).q, choice: '', note: p.q };
    return { title: p.it.title, choice: p.choice + (SCOPE_CARD[p.scope] || ''), note: p.note };
  }) };
}

/**
 * 多项合并成一条消息（发给页面 owner）：决定写标题、选择、备注和 decide done 命令；轮次写用户选的操作和对应的 round 命令；
 * 须知（只有带备注的才进消息）写已了解 / 恢复为未读和备注。只有决定时首行是「一次做了 N 个决定」，否则「一次发来 N 项」。
 */
export function batchMessageFor(data, picks) {
  const cmd = 'align ';
  const onlyDecisions = picks.every((p) => kindOf(p) === 'decision');
  const lines = ['对齐页「' + data.title + '」上，' + (onlyDecisions ? '用户一次做了 ' + picks.length + ' 个决定' : '用户一次发来 ' + picks.length + ' 项') + '，请逐条处理：', ''];
  picks.forEach((p, i) => {
    const { it, note } = p, n = (i + 1) + '. ', kind = kindOf(p);
    if (kind === 'btw' || kind === 'btw-more') {
      const fwd = '   转给负责的会话' + (p.r.sid ? '（' + p.r.sid + '）' : '') + '：运行 ' + cmd + 'btw forward ' + data.name + ' ' + p.id + '（不用自己回答；会话答了会写回对齐页）';
      if (kind === 'btw') lines.push(n + '顺便问，挂在轮次「' + p.r.title + '」（' + p.r.id + '）：' + p.q.split('\n').join('\n   '));
      else lines.push(n + '继续追问顺便问 ' + p.id + '：' + p.q.split('\n').join('\n   '), '   原问题：' + btwLast(p.b).q, '   之前的答案：' + btwLast(p.b).a);
      lines.push(fwd);
    } else if (kind === 'message') {
      // 多行原文：续行缩进 3 格，留在这一项里
      lines.push(n + '用户留言：' + (p.text ? p.text.split('\n').join('\n   ') : '（没写字，只有图片）'));
      // 图片：本机绝对路径一行一个，First Mate 用 read_image 直接读
      if (p.images && p.images.length) lines.push('   附图 ' + p.images.length + ' 张（本机路径，用 read_image 看）：', ...p.images.map((f) => '   ' + f));
    } else if (kind === 'round') {
      lines.push(n + '轮次「' + it.title + '」（' + it.id + '）', '   用户选择：' + ROUND_ACTIONS[p.action].label);
      if (note) lines.push('   备注：' + note);
      lines.push('   处理完运行 ' + cmd + ROUND_ACTIONS[p.action].cmd(data.name, it.id, data));
    } else if (kind === 'note') {
      lines.push(n + '须知「' + it.title + '」', '   ' + (p.ack ? '用户已了解' : '用户把它恢复为未读'));
      if (note) lines.push('   备注：' + note);
      lines.push('   需要时 note set 或 note del 处理（' + cmd + 'note set ' + data.name + ' ' + it.id + ' … / note del ' + data.name + ' ' + it.id + '）');
    } else if (kind === 'rule') {
      lines.push(n + '长期规则「' + it.like + ' → ' + ruleChoice(it) + '」（' + it.id + '）', '   用户选择：撤销');
      if (note) lines.push('   备注：' + note);
      lines.push('   先从 First Mate AGENTS.md 授权段删掉这条规则，再运行 ' + cmd + 'rule revoke ' + data.name + ' ' + it.id);
    } else {
      lines.push(n + it.title, '   ' + (p.choice ? '选择：' + p.choice : '用户回复：' + note));
      if (it.auto === 'timeout') lines.push('   推翻超时自动选择（原来按推荐「' + it.choice + '」自动发出）');
      if (note && p.choice) lines.push('   备注：' + note);
      if (it.sid && it.sid !== data.owner) lines.push('   这条决定原本记在会话 ' + it.sid + ' 上。');
      if (p.scope && p.scope !== 'once') {
        const only = p.scope === 'project' ? '只对项目 ' + projTitle(data, it.proj) + ' 生效；' : '';
        lines.push('   作用范围：' + SCOPE_TEXT[p.scope] + '（scope=' + p.scope + '）', '   同类：' + p.like,
          '   先把这条规则写进 First Mate AGENTS.md 授权段（' + only + '同类：' + p.like + ' → ' + p.choice + '），再运行 ' + cmd + 'decide done ' + data.name + ' ' + it.id +
          " 'choice=" + p.choice + "' scope=" + p.scope + " 'like=" + p.like + "'");
      } else lines.push('   处理完运行 ' + cmd + 'decide done ' + data.name + ' ' + it.id);
    }
    lines.push('');
  });
  const fixD = '运行 ' + cmd + 'decide set ' + data.name + ' <决定 id> status=open 改回待决定，并在 why 里写明原因';
  const fixR = '运行 ' + cmd + 'round set ' + data.name + ' <轮次 id> status=<原状态> 恢复原状态，并在 state 里写明原因';
  const hasD = picks.some((p) => kindOf(p) === 'decision'), hasR = picks.some((p) => kindOf(p) === 'round');
  if (hasD && hasR) lines.push('某一条处理不了：决定' + fixD + '；轮次' + fixR + '。');
  else if (hasD || hasR) lines.push('某一条处理不了，' + (hasD ? fixD : fixR) + '。');
  else lines.pop();
  return lines.join('\n');
}

/**
 * 一次回复多项：body = {answers:[…]}，每项三种（kind 缺省 = decision）：
 *   决定 {id, choice, note}（open / sent 的决定）→ status sent；
 *   轮次 {kind:'round', id, action, note}（done | paused 要求 doing / waiting，dropped 要求 doing / waiting / paused / done，resume 要求 paused，accept 要求 done）→ 记 ask / asknote / asked，status 不改；
 *   须知 {kind:'note', id, ack, note}（ack true 写 acked，false 删）→ updated 不改；
 *   留言 {kind:'message', text}（api 9，最多一条，不挂在任何条目上）→ 只进消息，不写文件；
 *   「我的」页签（api 19）{kind:'todo-add', title, today?} / {kind:'todo', id, action: done|today|untoday|send|drop|open, note?} / {kind:'goal', id, action: progress|done|drop|open, cur?, kr?, note?} → 只写文件、不发消息
 *   （待办「派出去做」的派活说明由网页并进留言发给 First Mate，这里只在待办 log 里记一笔 send、不挂轮次，派出由 First Mate 跑 todo dispatch）。
 * 全部校验通过才动；决定、轮次操作、带备注的须知合并成一条消息先发给页面 owner，发送成功才写文件（全成或全败）。
 * 只有不带备注的须知时不发消息、不要 owner。send 失败抛 PageError(500, 'send-failed')，页面不变。
 */
export async function answerBatch(name, body, send, { btwGuard = null, mineGuard = null } = {}) {
  const file = pageFile(name);
  const answers = body && Array.isArray(body.answers) ? body.answers : null;
  if (!answers) throw new PageError(400, 'bad-request', '请求里没有 answers 列表');
  if (!answers.length) throw new PageError(400, 'empty-answer', '没有要发送的内容');
  if (answers.length > 50) throw new PageError(400, 'bad-request', '一次最多发 50 项');
  const data = parsePage(fs.readFileSync(file, 'utf8'));
  if (data.version !== 3) throw new PageError(400, 'needs-migrate', '页面「' + data.title + '」是旧版格式，不能一次发出多项。先运行 align migrate ' + data.name + ' 升级（加 --dry-run 可先预演）');
  const seen = new Set();
  let newIds = 0;
  const picks = answers.map((a) => {
    if (!a || typeof a !== 'object') throw new PageError(400, 'bad-request', 'answers 里每一项必须是对象');
    const kind = a.kind === undefined ? 'decision' : a.kind;
    if (!['decision', 'round', 'note', 'rule', 'due', 'message', 'btw', 'btw-more', 'btw-ack', 'rec-take', 'todo-add', 'todo', 'goal'].includes(kind)) throw new PageError(400, 'bad-request', '不认识的 kind: ' + kind + '（只能是 decision | round | note | rule | due | message | btw | btw-more | btw-ack | rec-take | todo-add | todo | goal）');
    // 「我的」页签（api 19）：记一条待办（可以一次记几条）、待办和目标的操作；全部只写文件
    if (kind === 'todo-add') {
      const title = typeof a.title === 'string' ? mineText(a.title) : '';
      if (!title) throw new PageError(400, 'empty-answer', '记一条：要做的事是空的');
      if (title.length > MINE_MAX.title) throw new PageError(400, 'too-long', '记一条最多 ' + MINE_MAX.title + ' 字，现在 ' + title.length + ' 字');
      if (a.today !== undefined && typeof a.today !== 'boolean') throw new PageError(400, 'bad-request', '记一条的 today 要是 true 或 false');
      return { kind, title, today: a.today === true };
    }
    if (kind === 'todo' || kind === 'goal') {
      if (seen.has(kind + '/' + a.id)) throw new PageError(400, 'bad-request', '同一项出现了两次: ' + kind + '/' + a.id);
      seen.add(kind + '/' + a.id);
      const note = typeof a.note === 'string' ? mineText(a.note).slice(0, MINE_MAX.note) : '';
      if (kind === 'todo') {
        const it = (data.todos || []).find((x) => x.id === a.id);
        if (!it) throw new PageError(404, 'todo-not-found', '待办 ' + a.id + ' 已不在页面上，刷新看看');
        const act = Object.hasOwn(TODO_ACTIONS, a.action) ? TODO_ACTIONS[a.action] : null;
        if (!act) throw new PageError(400, 'bad-action', '待办「' + it.title + '」的操作只能是 ' + Object.keys(TODO_ACTIONS).join(' | ') + ': ' + a.action);
        const why = act.why(it);
        if (why) throw new PageError(400, 'bad-action', '待办「' + it.title + '」' + why + '，不能「' + act.label + '」，刷新看看');
        return { kind, it, action: a.action, note };
      }
      const it = (data.goals || []).find((x) => x.id === a.id);
      if (!it) throw new PageError(404, 'goal-not-found', '目标 ' + a.id + ' 已不在页面上，刷新看看');
      if (!['progress', 'done', 'drop', 'open'].includes(a.action)) throw new PageError(400, 'bad-action', '目标「' + it.title + '」的操作只能是 progress | done | drop | open: ' + a.action);
      if ((a.action === 'open') !== (it.status !== 'doing')) throw new PageError(400, 'bad-action', '目标「' + it.title + '」现在是「' + GOAL_LABEL[it.status] + '」，' + (a.action === 'open' ? '不用恢复' : '不能再改') + '，刷新看看');
      if (a.action !== 'progress') return { kind, it, action: a.action, note };
      if (typeof a.cur !== 'number' || !Number.isFinite(a.cur)) throw new PageError(400, 'bad-request', '目标「' + it.title + '」记进度要有当前值（数）');
      if (a.kr !== undefined && !(it.kr || []).some((k) => k.id === a.kr)) throw new PageError(400, 'bad-request', '目标「' + it.title + '」没有关键结果 ' + a.kr + '，刷新看看');
      return { kind, it, action: 'progress', cur: a.cur, kr: a.kr, note };
    }
    if (kind === 'btw') {
      const r = data.rounds.find((x) => x.id === a.round);
      if (!r) throw new PageError(404, 'round-not-found', '轮次 ' + a.round + ' 已不在页面上，刷新看看');
      if (isClosed(r)) throw new PageError(400, 'bad-action', '「' + r.title + '」已经结束，不能再顺便问');
      const q = typeof a.q === 'string' ? a.q.replace(/\r\n?/g, '\n').trim() : '';
      if (!q) throw new PageError(400, 'empty-answer', '顺便问是空的');
      if (q.length > BTW_Q_MAX) throw new PageError(400, 'too-long', '顺便问最多 ' + BTW_Q_MAX + ' 字，现在 ' + q.length + ' 字');
      if (seen.has('btw/' + r.id)) throw new PageError(400, 'bad-request', '同一轮一次只能顺便问一句');
      seen.add('btw/' + r.id);
      return { kind, r, q, id: newBtwId(data, newIds++) };
    }
    if (kind === 'btw-more' || kind === 'btw-ack') {
      if (seen.has('btw#' + a.id)) throw new PageError(400, 'bad-request', '同一条顺便问出现了两次: ' + a.id);
      seen.add('btw#' + a.id);
      const b = (data.btw || []).find((x) => x.id === a.id);
      if (!b) throw new PageError(404, 'btw-not-found', '顺便问 ' + a.id + ' 已不在页面上，刷新看看');
      if (b.status !== 'answered') throw new PageError(400, 'bad-action', '顺便问「' + btwLast(b).q + '」现在' + (b.status === 'open' ? '还在等回答' : '已经结束') + '，刷新看看');
      const r = data.rounds.find((x) => x.id === b.round);
      if (kind === 'btw-ack') return { kind, b, id: b.id, r };
      // 追问挂到会话链的最新一轮（换过会话时由新会话来答）；那一轮已结束就没人接
      const tail = btwTail(data, b);
      if (!tail || isClosed(tail)) throw new PageError(400, 'bad-action', '「' + (r ? r.title : b.round) + '」这条会话链已经结束，不能再追问；要问就在还在做的一轮里重新顺便问');
      const q = typeof a.q === 'string' ? a.q.replace(/\r\n?/g, '\n').trim() : '';
      if (!q) throw new PageError(400, 'empty-answer', '追问是空的');
      if (q.length > BTW_Q_MAX) throw new PageError(400, 'too-long', '追问最多 ' + BTW_Q_MAX + ' 字，现在 ' + q.length + ' 字');
      if ((b.more || []).length >= BTW_MORE_MAX) throw new PageError(400, 'too-many', '一条顺便问最多追问 ' + BTW_MORE_MAX + ' 次，换个问题重新问');
      return { kind, b, r: tail, q, id: b.id };
    }
    if (kind === 'message') {
      if (seen.has('message')) throw new PageError(400, 'bad-request', '一次只能带一条留言');
      seen.add('message');
      const text = typeof a.text === 'string' ? a.text.replace(/\r\n?/g, '\n').trim() : '';
      const images = memoImagesOf(a.images);
      if (!text && !images.length) throw new PageError(400, 'empty-answer', '留言是空的');
      if (text.length > MESSAGE_MAX) throw new PageError(400, 'too-long', '留言最多 ' + MESSAGE_MAX + ' 字，现在 ' + text.length + ' 字');
      return { kind, text, images };
    }
    // 推荐卡「我来做」（api 17）：变成放进今天的待办，推荐标成已处理；只写文件、不发消息。和同一条推荐的「不做」/「派出去做」（kind note）互斥
    if (kind === 'rec-take') {
      if (seen.has('note/' + a.id)) throw new PageError(400, 'bad-request', '同一条推荐出现了两次: ' + a.id);
      seen.add('note/' + a.id);
      const it = data.notes.find((x) => x.id === a.id && isRec(x));
      if (!it) throw new PageError(404, 'note-not-found', '这条推荐已不在页面上，刷新看看');
      if (it.acked) throw new PageError(400, 'bad-action', '推荐「' + it.title + '」已经处理过，刷新看看');
      return { kind, it };
    }
    if (seen.has(kind + '/' + a.id)) throw new PageError(400, 'bad-request', '同一项出现了两次: ' + kind + '/' + a.id);
    seen.add(kind + '/' + a.id);
    const note = typeof a.note === 'string' ? a.note.trim().slice(0, 2000) : '';
    if (kind === 'round') {
      const it = data.rounds.find((x) => x.id === a.id);
      if (!it) throw new PageError(404, 'round-not-found', '轮次 ' + a.id + ' 已不在页面上，刷新看看');
      const act = Object.hasOwn(ROUND_ACTIONS, a.action) ? ROUND_ACTIONS[a.action] : null;
      if (!act) throw new PageError(400, 'bad-action', '「' + it.title + '」的操作只能是 ' + Object.keys(ROUND_ACTIONS).join(' | ') + ': ' + a.action);
      if (!act.from.includes(it.status)) throw new PageError(400, 'bad-action', '「' + it.title + '」现在是 ' + it.status + '，不能做「' + act.label + '」（要求 ' + act.from.join(' / ') + '），刷新看看');
      if (a.action === 'revise' && !note) throw new PageError(400, 'needs-note', '「' + it.title + '」选了「修改」，要写修改意见');
      return { kind, it, action: a.action, note };
    }
    if (kind === 'rule') {
      const it = data.decisions.find((x) => x.id === a.id && isRule(x));
      if (!it) throw new PageError(404, 'rule-not-found', '长期规则 ' + a.id + ' 已不在（可能已撤销），刷新看看');
      if (a.action !== 'revoke') throw new PageError(400, 'bad-action', '长期规则「' + it.like + '」的操作只能是 revoke: ' + a.action);
      return { kind, it, note };
    }
    if (kind === 'due') {
      const it = data.decisions.find((x) => x.id === a.id && x.status === 'open');
      if (!it) throw new PageError(404, 'decision-not-found', '决定 ' + a.id + ' 已不在待决定里，刷新看看');
      const t = typeof a.due === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a.due) ? Date.parse(a.due) : NaN;
      if (Number.isNaN(t) || t <= Date.parse(nowIso())) throw new PageError(400, 'bad-due', '「' + it.title + '」的新截止要是晚于现在的时间: ' + a.due);
      return { kind, it, due: nowIso(new Date(t)) };
    }
    if (kind === 'note') {
      const it = data.notes.find((x) => x.id === a.id);
      if (!it) throw new PageError(404, 'note-not-found', '这条须知已不在页面上，刷新看看');
      if (typeof a.ack !== 'boolean') throw new PageError(400, 'bad-request', '「' + it.title + '」的 ack 要是 true 或 false');
      return { kind, it, ack: a.ack, note };
    }
    const it = data.decisions.find((x) => x.id === a.id && live(x));
    if (!it) throw new PageError(404, 'decision-not-found', '决定 ' + a.id + ' 已不在页面上（可能已处理），刷新看看');
    const choice = typeof a.choice === 'string' ? a.choice : '';
    if (choice && !(it.opt || []).some((o) => o.label === choice)) throw new PageError(400, 'unknown-option', '「' + it.title + '」没有这个选项: ' + choice);
    if (!choice && !note) throw new PageError(400, 'empty-answer', '「' + it.title + '」没有选项也没有文字');
    // 作用范围：答复带 scope 就用它（页面上勾「以后同类都这样」），否则用所选选项自带的，缺省 once
    const scope = a.scope === undefined ? ((it.opt || []).find((o) => o.label === choice)?.scope ?? 'once') : a.scope;
    if (!SCOPES.includes(scope)) throw new PageError(400, 'bad-request', '「' + it.title + '」的 scope 只能是 ' + SCOPES.join(' | ') + ': ' + scope);
    if (scope === 'once') return { kind, it, choice, note, scope };
    if (!choice) throw new PageError(400, 'needs-choice', '「' + it.title + '」要选一个选项才能定成「' + SCOPE_TEXT[scope] + '」');
    const like = typeof a.like === 'string' && a.like.trim() ? a.like.trim() : it.like;
    if (!like) throw new PageError(400, 'needs-like', '「' + it.title + '」没有「同类」的定义（like），不能定成「' + SCOPE_TEXT[scope] + '」');
    if (like.length > LIKE_MAX) throw new PageError(400, 'bad-request', '「同类」最多 ' + LIKE_MAX + ' 字');
    return { kind, it, choice, note, scope, like };
  });
  // 3390 本机服务：页面写进 btw 之前先确认主 3080 读得了它（旧插件读到顶层 btw 整页报错）；3080 自己就是 api 16，不用查
  if (btwGuard && picks.some((p) => p.kind === 'btw' || p.kind === 'btw-more')) {
    try { await btwGuard(); } catch (e) { throw new PageError(409, 'needs-update', e.message); }
  }
  // 3390 本机服务：页面上还没有待办 / 目标时，「我来做」写进去之前同样先确认主 3080 读得了（api 17）
  if (mineGuard && !hasMine(data) && picks.some((p) => p.kind === 'rec-take' || p.kind === 'todo-add')) {
    try { await mineGuard(); } catch (e) { throw new PageError(409, 'needs-update', e.message); }
  }
  // 不带备注的「已了解」、改截止、顺便问的「了解」、推荐的「我来做」和「我的」页签的操作只写文件
  const told = picks.filter((p) => (p.kind !== 'note' || p.note) && !['due', 'btw-ack', 'rec-take', 'todo-add', 'todo', 'goal'].includes(p.kind));
  let sid;
  if (told.length) {
    if (!data.owner) throw new PageError(400, 'no-target-session', '页面没有记录 owner 会话，请在对话里回复');
    sid = data.owner;
    try { await send(sid, batchMessageFor(data, told), decisionCard(data, told)); }
    catch (e) { throw new PageError(500, 'send-failed', e.message); }
  }
  const { data: after } = mutate(file, (d, now) => {
    for (const p of picks) {
      if (p.kind === 'message') continue;
      if (p.kind === 'rec-take') { recTake(d, now, p.it.id); continue; }
      if (p.kind === 'todo-add') { mineOps['todo add'](d, now, [], [['title', p.title], ['src', '手记']], { today: p.today }); continue; }
      if (p.kind === 'todo') { todoAnswer(d, now, p); continue; }
      if (p.kind === 'goal') { goalAnswer(d, now, p); continue; }
      if (p.kind === 'btw') {
        if (!d.rounds.some((y) => y.id === p.r.id && !isClosed(y))) fail('写回时轮次 ' + p.r.id + ' 已不在或已结束');
        if ((d.btw || []).some((y) => y.id === p.id)) fail('写回时顺便问 id ' + p.id + ' 已被占用');
        (d.btw ||= []).push({ id: p.id, round: p.r.id, src: body.src === 'app' ? 'app' : 'web', q: p.q, asked: now, status: 'open' });
        continue;
      }
      if (p.kind === 'btw-more' || p.kind === 'btw-ack') {
        const x = (d.btw || []).find((y) => y.id === p.id && y.status === 'answered');
        if (!x) fail('写回时顺便问 ' + p.id + ' 已不在或已不是已答');
        if (p.kind === 'btw-ack') x.seen = now;
        // 追问：回到等答；seen 清掉（时间只到秒，留着会盖住同一秒内写回的下一个答案）
        else {
          if (!d.rounds.some((y) => y.id === p.r.id && !isClosed(y))) fail('写回时轮次 ' + p.r.id + ' 已不在或已结束');
          if (x.round !== p.r.id) { if (!x.from) x.from = x.round; x.round = p.r.id; }
          (x.more ||= []).push({ q: p.q, asked: now }); x.status = 'open'; delete x.seen;
        }
        continue;
      }
      if (p.kind === 'round') {
        const x = d.rounds.find((y) => y.id === p.it.id && ROUND_ACTIONS[p.action].from.includes(y.status));
        if (!x) fail('写回时轮次 ' + p.it.id + ' 已不在或状态变了');
        Object.assign(x, { ask: p.action, asked: now, updated: now });
        if (p.note) x.asknote = p.note; else delete x.asknote;
      } else if (p.kind === 'rule') {
        const x = d.decisions.find((y) => y.id === p.it.id && isRule(y));
        if (!x) fail('写回时长期规则 ' + p.it.id + ' 已不在');
        x.revokeAsked = now;
      } else if (p.kind === 'due') {
        const x = d.decisions.find((y) => y.id === p.it.id && y.status === 'open');
        if (!x) fail('写回时决定 ' + p.it.id + ' 已不在待决定里');
        x.due = p.due;
        delete x.overdue;
      } else if (p.kind === 'note') {
        const x = d.notes.find((y) => y.id === p.it.id);
        if (!x) fail('写回时须知 ' + p.it.id + ' 已不在');
        if (p.ack) x.acked = now; else delete x.acked;
      } else {
        const x = d.decisions.find((y) => y.id === p.it.id && live(y));
        if (!x) fail('写回时决定 ' + p.it.id + ' 已不在');
        Object.assign(x, { status: 'sent', choice: p.choice, answered: now, updated: now });
        if (p.note) x.reply = p.note; else delete x.reply;
        if (p.scope !== 'once') Object.assign(x, { scope: p.scope, like: p.like }); else delete x.scope;
        delete x.auto; delete x.autoAt; // 用户自己答了（含推翻超时自动选择）
      }
    }
    return '';
  });
  return { data: after, sid, items: picks.map((p) => (p.kind === 'decision' ? p.it.id : p.kind === 'message' || p.kind === 'todo-add' ? p.kind : p.kind.startsWith('btw') ? p.kind + '/' + p.id : p.kind + '/' + p.it.id)) };
}

const dueText = (d) => d.due.slice(5, 16).replace('T', ' ');
const REMIND_WHY = {
  'no-rec': '没有推荐选项',
  high: '风险高，页面设置高风险超时只提醒（timeoutHigh=remind）',
  stale: '超时超过 24 小时（多半是 3080 停机期间超时），推荐可能已过时，再问一次',
};
/** 超时处理的前置：读页面、确认 timeoutCheck 给的就是这个动作，要有 owner。 */
function dueAction(name, id, action, now) {
  const file = pageFile(name);
  const data = parsePage(fs.readFileSync(file, 'utf8'));
  if (data.version !== 3) throw new PageError(400, 'needs-migrate', '页面「' + data.title + '」是旧版格式，没有超时');
  const c = timeoutCheck(data, now).find((x) => x.id === id);
  if (!c || c.action !== action) throw new PageError(409, 'not-due', '决定 ' + id + (action === 'auto' ? ' 现在不该按推荐自动处理' : ' 现在不用提醒') + '（不是 open、没到截止、已处理或已提醒过，或条件不符）');
  if (!data.owner) throw new PageError(400, 'no-target-session', '页面没有记录 owner 会话，超时没人可告诉');
  return { file, data, d: data.decisions.find((x) => x.id === id), why: c.why, stamp: nowIso(new Date(now)) };
}
async function sendOrFail(send, sid, prompt, card) {
  try { await send(sid, prompt, card); } catch (e) { throw new PageError(500, 'send-failed', e.message); }
}
/**
 * 超时按推荐自动作答（3080 插件的轮询在 timeoutCheck 给 auto 时调用）：先给页面 owner 发消息（首行「…一条决定超时，已按推荐处理」），
 * 发送成功再写 status=sent choice=rec auto=timeout autoAt answered；写回时复核仍是 open 且没有 auto（同一条只处理一次）。
 */
export async function answerTimeout(name, id, send, now = Date.parse(nowIso())) {
  const { file, data, d, stamp } = dueAction(name, id, 'auto', now);
  await sendOrFail(send, data.owner, [
    '对齐页「' + data.title + '」上一条决定超时，已按推荐处理：' + d.title + '（' + d.id + '）',
    '原截止：' + dueText(d),
    '已按推荐「' + d.rec + '」发出（风险 ' + (d.risk || '中') + '）。用户可以在页面上改主意，改选会再发一条消息。',
    '请按推荐落实（需要时转给负责的会话），处理完运行 align decide done ' + data.name + ' ' + d.id,
  ].join('\n'), { page: data.title, decisions: [{ title: d.title, choice: d.rec + '（超时按推荐）', note: '' }] });
  const { data: after } = mutate(file, (pg) => {
    const x = pg.decisions.find((y) => y.id === id && y.status === 'open' && !y.auto);
    if (!x) fail('写回时决定 ' + id + ' 已不是 open（别处已处理），没有写入');
    Object.assign(x, { status: 'sent', choice: x.rec, auto: 'timeout', autoAt: stamp, answered: stamp, updated: stamp });
    delete x.reply;
    return '';
  }, stamp);
  return { data: after, sid: data.owner, item: id };
}
/** 超时但不自动处理（没有推荐 / 高风险 / 超时超过 24 小时）：给页面 owner 发一次提醒，写 overdue（页面据此升级显示，同一条不再提醒）。 */
export async function remindOverdue(name, id, send, now = Date.parse(nowIso())) {
  const { file, data, d, why, stamp } = dueAction(name, id, 'remind', now);
  const cmd = 'align ';
  await sendOrFail(send, data.owner, [
    '对齐页「' + data.title + '」上一条决定已超时，没有自动处理：' + d.title + '（' + d.id + '）',
    '原截止：' + dueText(d),
    '原因：' + REMIND_WHY[why],
    '请提醒用户尽快定（页面上这条已标为超时）。不用再等用户：' + cmd + 'decide done ' + data.name + ' ' + d.id + " 'result=…'；要延期：" + cmd + 'decide set ' + data.name + ' ' + d.id + ' timeout=<从开始等算起的时长>',
  ].join('\n'), { page: data.title, decisions: [{ title: d.title, choice: '已超时，等你定', note: REMIND_WHY[why] }] });
  const { data: after } = mutate(file, (pg) => {
    const x = pg.decisions.find((y) => y.id === id && y.status === 'open' && !y.overdue);
    if (!x) fail('写回时决定 ' + id + ' 已不是 open 或已提醒过，没有写入');
    x.overdue = stamp;
    return '';
  }, stamp);
  return { data: after, sid: data.owner, item: id };
}

/**
 * 项目顺序（api 10）：页面「已完成」栏拖出来的顺序，存成页面的 projOrder（项目 id 数组，未归属是 ''）。
 * 页面各栏和决定列表按它排项目，没列进去的（新项目）排在后面。body = {order: [...]}；空数组 = 删掉 projOrder，恢复默认顺序。
 * 只写这一个字段；返回 {data}。
 */
export function setProjOrder(name, body) {
  const file = pageFile(name);
  const order = body && body.order;
  if (!Array.isArray(order) || order.length > 500 || order.some((p) => typeof p !== 'string')) throw new PageError(400, 'bad-request', 'order 要是项目 id 的数组');
  if (new Set(order).size !== order.length) throw new PageError(400, 'bad-request', 'order 里有重复的项目');
  const data = parsePage(fs.readFileSync(file, 'utf8'));
  if (data.version !== 3) throw new PageError(400, 'needs-migrate', '页面「' + data.title + '」是旧版格式，不能排项目顺序。先运行 align migrate ' + data.name + ' 升级');
  const pids = new Set(data.projects.map((p) => p.id));
  const bad = order.find((p) => p !== '' && !pids.has(p));
  if (bad !== undefined) throw new PageError(400, 'unknown-project', '页面上没有项目 ' + bad);
  const { data: after } = mutate(file, (d) => { if (order.length) d.projOrder = order; else delete d.projOrder; return ''; });
  return { data: after };
}

/**
 * 页面与回复接口的 HTTP 处理（本机 3390 服务和 3080 插件路由共用）。
 * prefix: 路由前缀（3390 为 ''，插件为 '/alignment'）；guard(req) 返回 null 放行，或 { code, message } 拒绝。
 * /health 不过 guard（只回应用名和接口版本，供 align open 探测）。
 * live（api 7，必给）：live(sids) → Promise<{sid: running|idle|unknown}>（3080 插件按 ctx.agents 判断），或 null（3390 本机服务：没有会话状态）。
 *   版本 3 页面的 /data 与回复接口返回的 data 顶层多一个 live（页面上轮次的 sid 去重后逐个查；null 时就是 null，页面据此显示「会话状态未知」）。
 *   live 只在响应里，不写进页面文件（validate 只校验文件里的数据）；版本 2 页面原样。返回缺 sid 或取值不对 → 500，不猜。
 * work（2026-10-24，可选）：work(sids) → Promise<{sid: {subagents, jobs}}>（见 checkWork，3080 插件按 workspace/session-activity 给）。
 *   给了就在 live 旁边加一个顶层 work（只含有东西在跑的会话）；没给（3390 本机服务、旧测试）不加，页面不显示正在执行的子 agent / 后台任务。
 */
export function createHandler({ prefix = '', send, log = () => {}, guard, live, work = null, source = sourceOf, btwGuard = null, mineGuard = null }) {
  if (live !== null && typeof live !== 'function') throw new TypeError('createHandler 要 live：live(sids) → Promise<{sid: ' + LIVE_STATES.join('|') + '}>；没有会话状态的 3390 本机服务显式传 live: null');
  // 版本 3：live（会话实时状态）+ text（服务端拆好的正文，text-split.mjs textOf；只在响应里，不写文件）
  if (work !== null && typeof work !== 'function') throw new TypeError('createHandler 的 work 要么不给，要么是 work(sids) → Promise<{sid: {subagents, jobs}}>');
  const withLive = async (data) => {
    if (data.version !== 3) return data;
    if (live === null) return { ...data, live: null, text: textOf(data) };
    const sids = [...new Set(data.rounds.map((r) => r.sid).filter(Boolean))];
    const [got, busy] = await Promise.all([live(sids), work === null ? null : work(sids)]);
    if (!got || typeof got !== 'object' || Array.isArray(got)) throw new Error('live(sids) 没有返回对象: ' + JSON.stringify(got));
    for (const sid of sids) if (!Object.hasOwn(got, sid) || !LIVE_STATES.includes(got[sid])) throw new Error('live(sids) 对会话 ' + sid + ' 返回 ' + JSON.stringify(got[sid]) + '（只能是 ' + LIVE_STATES.join(' | ') + '）');
    const out = { ...data, live: Object.fromEntries(sids.map((sid) => [sid, got[sid]])), text: textOf(data) };
    if (work !== null) out.work = checkWork(busy, sids);
    return out;
  };
  const reply = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(prefix + '/')) return reply(res, 404, { ok: false, message: '没有这个地址' });
      const sub = url.pathname.slice(prefix.length);
      if (sub === '/health') return reply(res, 200, { ok: true, app: 'alignment-page', api: API_VERSION, pid: process.pid });
      const denied = guard(req);
      if (denied) return reply(res, denied.code, { ok: false, message: denied.message });
      if (sub === '/pages' && req.method === 'GET') return reply(res, 200, { ok: true, pages: listPages() });
      const lib = req.method === 'GET' && sub.match(/^\/lib\/([a-z]+)\.js$/);
      if (lib) {
        const body = vendorFile(lib[1]);
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(body);
      }
      const m = sub.match(/^\/p\/([a-z0-9-]+)(\/data|\/answer|\/order|\/file|\/log|\/image)?\/?$/);
      if (!m) return reply(res, 404, { ok: false, message: '没有这个地址' });
      if (req.method === 'GET' && m[2] === '/file') {
        const ref = url.searchParams.get('path');
        let f;
        if (isMemoImageRef(ref)) { pageFile(m[1]); f = memoImageFile(ref); } else f = attachmentFile(m[1], ref, url.searchParams.get('doc'));
        // sandbox：即使是 SVG 也不在 DSH 的源上跑脚本
        res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" });
        return res.end(f.body);
      }
      if (req.method === 'GET' && !m[2]) return reply(res, 200, fs.readFileSync(pageFile(m[1])), 'text/html; charset=utf-8');
      if (req.method === 'GET' && m[2] === '/data') return reply(res, 200, await withLive(pageData(m[1])));
      if (req.method === 'POST' && m[2] === '/image') {
        // 留言图片（api 14）：请求体是图片原始字节；超过上限也读完再回 413（中途断开浏览器只看到连接失败）
        pageFile(m[1]);
        if (!/^(image\/[a-z0-9.+-]+|application\/octet-stream)\b/i.test(req.headers['content-type'] || '')) return reply(res, 415, { ok: false, code: 'not-image', message: MEMO_NOT_IMAGE });
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size <= MEMO_IMAGE_BYTES) chunks.push(c); }
        if (size > MEMO_IMAGE_BYTES) throw new PageError(413, 'image-too-large', MEMO_TOO_BIG);
        const saved = saveMemoImage(Buffer.concat(chunks));
        log('image ' + m[1] + ' ' + saved.path + ' ' + saved.bytes);
        reply(res, 200, { ok: true, ...saved });
        // 顺带删 30 天前的日期目录：回复之后做，不拖慢上传；出错记 error 日志（图已存好、已回复，不该再报给页面），下次上传再试
        try { for (const d of pruneMemoImages()) log('image prune ' + d); } catch (err) { log('error image prune ' + (err && err.stack || err)); }
        return;
      }
      if (!(req.method === 'POST' && (m[2] === '/answer' || m[2] === '/order' || m[2] === '/log'))) return reply(res, 405, { ok: false, message: '不支持的请求' });
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reply(res, 415, { ok: false, message: '只接受 JSON' });
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 131072) return reply(res, 413, { ok: false, message: '内容太长' }); }
      const body = JSON.parse(raw);
      if (m[2] === '/log') {
        // 使用日志（api 11）：页面攒批 / 关闭前 sendBeacon 发来；只收登记过的页面，字段按 usage.mjs 白名单收
        if (!readRegistry()[m[1]]) throw new PageError(404, 'no-page', '没有登记名为 ' + m[1] + ' 的页面');
        let r;
        try { r = appendUsage(USAGE_DIR, { page: m[1], src: source(req), body }); } catch (e) { if (e instanceof TypeError || e instanceof RangeError) throw new UsageError(e.message); throw e; }
        return reply(res, 200, { ok: true, n: r.n, dropped: r.dropped });
      }
      if (m[2] === '/order') {
        const r = setProjOrder(m[1], body);
        log('order ' + m[1] + ' ' + (r.data.projOrder || []).length);
        return reply(res, 200, { ok: true, data: await withLive(r.data) });
      }
      if (body && Array.isArray(body.answers)) {
        const r = await answerBatch(m[1], body, send, { btwGuard, mineGuard });
        log('answer-batch ' + m[1] + ' ' + r.items.join(',') + ' -> ' + (r.sid || '（只写文件，没发消息）'));
        return reply(res, 200, { ok: true, data: await withLive(r.data) });
      }
      const r = await answerDecision(m[1], body, send);
      log('answer ' + m[1] + ' ' + r.item + ' -> ' + r.sid + ' choice=' + JSON.stringify(r.choice));
      return reply(res, 200, { ok: true, data: await withLive(r.data) });
    } catch (e) {
      log('error ' + (e.stack || e.message));
      const status = e instanceof PageError ? e.status : e instanceof UsageError || e instanceof SyntaxError ? 400 : 500;
      return reply(res, status, { ok: false, ...(e instanceof PageError ? { code: e.code, ...(e.hint ? { hint: e.hint } : {}) } : {}), message: e.message });
    }
  };
}

/** 3390 本机服务：Host 必须是本服务；回复接口另外要求 Origin 是本服务页面（别的网站发不进来）。 */
export function createServer({ port = PORT, send, log = () => {}, btwGuard = null, mineGuard = null } = {}) {
  const origins = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]);
  const guard = (req) => {
    if (!origins.has('http://' + req.headers.host)) return { code: 403, message: 'Host 不对' };
    if (req.method === 'POST' && !origins.has(req.headers.origin)) return { code: 403, message: 'Origin 不对' };
    return null;
  };
  return http.createServer(createHandler({ prefix: '', send, log, guard, live: null, source: () => 'local-3390', btwGuard, mineGuard }));
}

async function health(url, api) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (r.status === 404) return false;
    const j = await r.json();
    if (j.app !== 'alignment-page') fail(url + ' 不是对齐页服务');
    return api === undefined || (typeof j.api === 'number' && j.api >= api);
  } catch (e) { if (e instanceof UsageError) throw e; return false; }
}
const standaloneHealth = () => health('http://127.0.0.1:' + PORT + '/health');
/** 3080 插件路由可用就用它（电脑侧栏、远程入口共用登录鉴权）；否则用 3390 本机服务。
 *  version = 页面数据版本（不给就读登记的页面）；3080 报的 api >= 它才用 3080（重启前的旧代码不报 api 或报 2，版本 3 页面退回 3390）。 */
export async function resolvePageUrl(name, dshUrl, version = pageData(name).version) {
  if (await health(new URL(ROUTE_PREFIX + '/health', dshUrl).href, version)) return { url: dshRouteUrl(dshUrl, name), via: '3080 插件路由' };
  return { url: standaloneUrl(name), via: '3390 本机服务（3080 的 /alignment 路由未就绪）' };
}

export async function ensureServer(dshUrl) {
  if (await standaloneHealth()) return 'running';
  fs.mkdirSync(STORE, { recursive: true });
  // 服务自己逐行追加 server.log（不长期占着文件句柄，自启脚本也能写同一个文件）；崩溃堆栈进 server.err.log
  const errFd = fs.openSync(path.join(STORE, 'server.err.log'), 'a');
  const child = spawn(process.execPath, [SELF, 'serve', '--dsh-url', dshUrl], { detached: true, stdio: ['ignore', 'ignore', errFd], windowsHide: true });
  child.unref();
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 200)); if (await standaloneHealth()) return 'started pid ' + child.pid; }
  fail('本机服务没起来，看 ' + path.join(STORE, 'server.log'));
}

// ---- 使用日志查询 ----------------------------------------------------------------------------
/** align log <页> [--since 1d] [--until …] [--type a,b] [--id …] [--src local|remote|local-3390|app] [--limit 100] [--json]
 *  align usage <页> [--since 7d] [--until …] [--src …] [--json] */
function usageCmd(cmd, name, flags) {
  if (!name || !/^[a-z0-9-]+$/.test(name)) fail('用法: align ' + cmd + ' <登记名> [--since ' + (cmd === 'log' ? '1d' : '7d') + '] …（align ' + cmd + ' --help 看用法）');
  const reg = readRegistry();
  if (!reg[name]) fail('没有登记名为 ' + name + ' 的页面（已登记: ' + (Object.keys(reg).join(', ') || '无') + '）');
  const now = Date.parse(nowIso());
  let since, until;
  try {
    since = parseWhen(flags.since || (cmd === 'log' ? '1d' : '7d'), now);
    until = flags.until === undefined ? now + 1 : parseWhen(flags.until, now);
  } catch (e) { fail(e.message); }
  const bad = [];
  const all = filterEvents(readUsage(USAGE_DIR, { page: name, since, until, bad }), { src: flags.src });
  // 坏行（断电留下的 NUL 等）不中断，在 stderr 报告：去掉 NUL 后读出的照常算，读不出的跳过
  if (bad.length) process.stderr.write(badLinesText(bad) + '\n');
  if (cmd === 'usage') {
    if (flags.type !== undefined || flags.id !== undefined) fail('usage 不收 --type / --id（按类型、条目查原始事件用 align log）');
    const s = summarize(all, { since, until });
    return flags.json ? JSON.stringify(s) : summaryText(s, name);
  }
  const hits = filterEvents(all, { types: flags.type, id: flags.id });
  const limit = flags.limit === undefined ? 100 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 0) fail('--limit 要写非负整数（0 = 全部）');
  const shown = limit ? hits.slice(-limit) : hits;
  if (flags.json) return JSON.stringify(shown);
  if (!hits.length) return '没有符合条件的事件（' + name + '，' + new Date(since).toISOString() + ' 起）';
  const d = pageData(name), names = Object.fromEntries((d.projects || []).map((p) => [p.id, p.title]));
  return (shown.length < hits.length ? '共 ' + hits.length + ' 条，显示最后 ' + shown.length + ' 条（--limit 0 看全部）\n' : '') + shown.map((e) => formatEvent(e, names)).join('\n');
}

// ---- 入口 ---------------------------------------------------------------------------------
const readPage = (file) => parsePage(fs.readFileSync(file, 'utf8'));

/**
 * align [<命令> [<子命令>]] --help | -h，或 align help [<命令> [<子命令>]]：用法取自本文件头注释（唯一来源）。
 * 不带命令打印整段；带命令只打印以 node align.mjs <命令> [<子命令>] 开头的行和它缩进更深的续行，行首的 node align.mjs 换成 align。
 */
export function helpText(cmd, sub) {
  const head = [];
  for (const line of fs.readFileSync(SELF, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.startsWith('//')) break;
    head.push(line.replace(/^\/\/ ?/, '').replace(/^(\s*)node align\.mjs /, '$1align '));
  }
  if (!cmd) return head.join('\n').trim();
  const indent = (s) => s.match(/^\s*/)[0].length;
  // 逐词精确比对命令 / 子命令(不拿参数拼正则:help dispatc. 曾命中 dispatch)
  const start = (line) => { const w = line.trim().split(/\s+/); return w[0] === 'align' && w[1] === cmd && (!sub || w[2] === sub); };
  const out = [];
  for (let i = 0; i < head.length; i++) {
    if (!start(head[i])) continue;
    out.push(head[i]);
    for (let j = i + 1; j < head.length && head[j].trim() && indent(head[j]) > indent(head[i]) && !/^\s*align\s/.test(head[j]); j++) out.push(head[j]);
  }
  if (!out.length) fail('没有 ' + [cmd, sub].filter(Boolean).join(' ') + ' 这条命令；align --help 看全部命令');
  return out.join('\n');
}
const V3_CMDS = ['project', 'round', 'decide', 'note', 'rule', 'rec', 'todo', 'goal'];

/** 这条命令要把轮次改成 paused 时，按 3080 的 api 决定记不记暂缓时刻；不记时返回给用户看的一行说明。 */
async function pauseLogFor(kv) {
  pauseLog = !kv.some(([k, v]) => k === 'status' && v === 'paused') || (await probes.pauseApi());
  return pauseLog ? [] : ['没记暂缓时刻：3080 里的对齐页插件还是旧版（api < ' + PAUSE_API + '），读不了 pauses；3080 重启后跑 node ' + path.join(path.dirname(SELF), 'backfill-pauses.mjs') + ' <页> 从会话日志补上'];
}

export async function main(argv) {
  const { pos, kv, flags } = parseArgs(argv);
  const [cmd, ref, ...rest] = pos;
  // --help 在任何命令上都只打印用法、不做事（2026-10-31:align dispatch --help 曾报「--help 需要一个值」）
  if (cmd === 'help') return helpText(ref, rest[0]);
  if (flags.help) return helpText(cmd, V3_CMDS.includes(cmd) || cmd === 'btw' ? ref : undefined);
  if (cmd === 'init') return init(ref, flags);
  if (cmd === 'serve') {
    const port = Number(flags.port || PORT), dshUrl = flags['dsh-url'] || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
    fs.mkdirSync(STORE, { recursive: true });
    const log = (s) => fs.appendFileSync(path.join(STORE, 'server.log'), nowIso() + ' ' + s + '\n');
    const server = createServer({ port, send: threadsSender(dshUrl), log, btwGuard: () => needBtwApi(dshUrl), mineGuard: () => needMineApi(dshUrl) });
    await new Promise((r, j) => server.once('error', j).listen(port, '127.0.0.1', r));
    log('listening ' + 'http://127.0.0.1:' + port + ' dsh=' + dshUrl);
    return null;
  }
  if (cmd === 'url' || cmd === 'open') {
    const file = resolvePage(ref);
    const { name, title, version } = readPage(file);
    if (readRegistry()[name] !== file) fail('页面没有登记，先用 init 建页');
    const dshUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
    const target = await resolvePageUrl(name, dshUrl, version);
    if (cmd === 'url') return target.url;
    const state = target.url.startsWith(dshUrl.replace(/\/$/, '')) ? '3080 插件路由' : '3390 本机服务 ' + await ensureServer(dshUrl);
    const r = spawnSync(process.execPath, [needCli(sidebarCli(), 'ALIGN_SIDEBAR_CLI', 'align open 在侧栏打开页面'), 'open', target.url, '--title', title], { encoding: 'utf8' });
    if (r.status !== 0) fail('侧栏打开失败: ' + (r.stderr || r.stdout).trim());
    const o = JSON.parse(r.stdout);
    const side = !o.delivered ? '侧栏没有浏览器确认，已排队，用户下次打开这个会话时补投；也可以直接把地址发给用户'
      : o.visible === 0 ? '侧栏已打开，但在后台标签或没人看的屏幕上' : '侧栏已打开';
    return '打开 ' + target.url + '（' + state + '；' + side + '）';
  }
  if (cmd === 'forget') {
    const reg = readRegistry();
    if (!reg[ref]) fail('没有登记名为 ' + ref + ' 的页面');
    const was = reg[ref];
    delete reg[ref];
    writeRegistry(reg);
    return '注销了 ' + ref + '（页面文件留在 ' + was + '）';
  }
  if (cmd === 'refresh') {
    const file = resolvePage(ref);
    mutate(file, () => '', undefined, { touch: false });
    return '按当前模板重新生成 → ' + file;
  }
  if (cmd === 'migrate') return migrate(ref, flags);
  if (cmd === 'log' || cmd === 'usage') return usageCmd(cmd, ref, flags);
  if (cmd === 'link') return link(ref, flags);
  if (cmd === 'dispatch') return dispatch(ref, rest, kv, flags);
  if (cmd === 'btw') {
    const [page, ...args] = rest;
    const sub = ref;
    if (!['add', 'forward', 'answer', 'when', 'end', 'ls'].includes(sub)) fail('用法: btw add | forward | answer | when | end | ls <页> …（align btw --help 看用法）');
    const file = resolvePage(page);
    if (sub === 'ls') { if (args.length) fail('用法: btw ls <页> [--round <轮次>] [--sid <前 8 位>] [--new] [status=…]'); const d = readPage(file); need3(d); return btwListLines(d, pageRef(d, file), kv, flags); }
    if (sub !== 'add' && args.length !== 1) fail('用法: btw ' + sub + ' <页> <id> …');
    if (sub === 'add') await probes.btwApi();
    if (sub === 'forward') {
      if (kv.length) fail('用法: btw forward <页> <id>');
      const d = readPage(file);
      need3(d);
      const b = findBtw(d, args[0]);
      if (b.status !== 'open') fail('btw/' + b.id + ' 不在等答（' + b.status + '），不用转');
      const r = d.rounds.find((x) => x.id === b.round);
      if (!r.sid) fail('轮次 ' + r.id + ' 没登记 sid，不知道转给哪个会话');
      checkSidFormat(r.sid, '轮次 ' + r.id + ' 的 sid');
      await threadsCall('send_message_to_thread', { threadId: r.sid, prompt: btwPromptBlock(d, pageRef(d, file), [b]) }, { caller: true });
      try {
        const { msg } = mutate(file, (x) => { need3(x); const y = findBtw(x, b.id); btwLast(y).fwd = nowIso(); return 'btw/' + y.id + ' 已转给会话 ' + r.sid; });
        return msg + ' → ' + file;
      } catch (e) {
        // 消息已经送到：不要再跑一次 forward（会话会收到两遍）；fwd 没记上只影响「还没转给会话」的提示
        fail('btw/' + b.id + ' 已经发给会话 ' + r.sid + '，但页面没记下「已转」：' + e.message + '\n不要再跑 btw forward（会话会收到两遍）；回合结束通知里它会显示「还没转给会话」，忽略即可');
      }
    }
    const { msg } = mutate(file, (d, now) => { need3(d); return btwOps[sub](d, now, args, kv, flags); });
    return msg + ' → ' + file;
  }
  // 一天的轮次和做完的待办（收工 worklog 的素材）：只读
  if (cmd === 'day') {
    if (!ref || rest.length || kv.length) fail('用法: day <页> [--date YYYY-MM-DD] [--json]');
    const day = flags.date === undefined ? nowIso().slice(0, 10) : String(flags.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z'))) fail('--date 要写 YYYY-MM-DD: ' + day);
    const d0 = readPage(resolvePage(ref));
    need3(d0);
    const rep = dayReport(d0, day);
    return flags.json ? JSON.stringify(rep, null, 2) : dayLines(rep);
  }
  // 你的待办和目标（api 17）：todo / goal 子命令、rec take（推荐「我来做」）、import-po（从 personal-ops 导入，默认预演）
  if (cmd === 'todo' || cmd === 'goal' || (cmd === 'rec' && ref === 'take')) {
    const subs = { todo: ['add', 'set', 'done', 'today', 'ls', 'dispatch'], goal: ['add', 'set', 'done', 'progress', 'kr', 'ls'], rec: ['take'] }[cmd];
    if (!subs.includes(ref)) fail('用法: ' + cmd + ' ' + subs.join(' | ') + ' <页> …（align ' + cmd + ' --help 看用法）');
    const name = cmd + ' ' + ref;
    const [page, ...args] = rest;
    const file = resolvePage(page);
    const d0 = readPage(file);
    need3(d0);
    if (ref === 'ls') {
      if (args.length || kv.length) fail('用法: ' + name + ' <页> [--all]' + (cmd === 'todo' ? ' [--goal <目标 id>]' : '') + ' [--json]');
      if (flags.json) return JSON.stringify((cmd === 'todo' ? d0.todos : d0.goals) || [], null, 2);
      return cmd === 'todo' ? todoLines(d0, flags) : goalLines(d0, flags);
    }
    if (name === 'todo dispatch') {
      const [tid, rid, ...more] = args;
      if (!tid || !rid || more.length) fail('用法: todo dispatch <页> <待办 id> <轮次 id> --prompt-file <文件> --mode new|continue [--prev …] [--proj … | --cwd …] why=… ' + ETA_HINT);
      if (flags.todo !== undefined) fail('todo dispatch 自己带 --todo（就是第一个参数）');
      const t = findTodo(d0, tid);
      return dispatch(page, [rid], kv.some(([k]) => k === 'title') ? kv : [...kv, ['title', t.title]], { ...flags, todo: t.id });
    }
    // 只有能写进第一条的命令要探测（改 / 完成 / 记进度要先有条目，没有就照常报「没有这条」）
    if (!hasMine(d0) && ['todo add', 'goal add', 'rec take'].includes(name)) await probes.mineApi();
    const { msg } = mutate(file, (d, now) => { need3(d); return mineOps[name](d, now, args, kv, flags); });
    return msg + ' → ' + file;
  }
  if (cmd === 'import-po') return importPo(ref, flags);
  if (cmd === 'sids') { const d = readPage(resolvePage(ref)); need3(d); return badSidLines(d); }
  if (cmd === 'stale') {
    const since = parseSinceUser(flags['since-user']);
    const idle = flags.idle === undefined ? null : flags.idle.split(',').map((x) => x.trim()).filter(Boolean);
    if (idle && !idle.length) fail('--idle 要写成 <sid>[,…]');
    const file = resolvePage(ref);
    const d = readPage(file);
    need3(d);
    const page = pageRef(d, file), lines = staleLines(d, page, since);
    if (idle) { const st = idleLines(d, page, idle); lines.push(...(st.length ? st : ['--idle 的会话上没有已停没有下一步的轮次'])); }
    return lines.join('\n');
  }
  if (cmd === 'ls') {
    const d = readPage(resolvePage(ref));
    if (d.version === 3) return list3(d, rest, kv, flags);
    if (['round', 'project'].includes(rest[0])) need3(d);
    return list(d, rest, kv);
  }
  if (V3_CMDS.includes(cmd)) {
    const name = cmd + ' ' + (ref || '');
    const [page, ...args] = rest;
    if (name === 'project ls') { const d = readPage(resolvePage(page)); need3(d); return listProjects(d); }
    if (name === 'rule ls') { const d = readPage(resolvePage(page)); need3(d); return ruleLines(d); }
    if (name === 'rec ls') { const d = readPage(resolvePage(page)); need3(d); return recLines(d); }
    if (name === 'round accept' && (flags.before !== undefined || flags['dry-run'])) {
      // 批量迁移：预演只列、一条都没有就不写（mutate 会改页面 updated）
      if (flags.before === undefined) fail('--dry-run 只用于 round accept <页> --before <ISO>');
      if (args.length) fail(ACCEPT_BEFORE_WITH_ID);
      const file = resolvePage(page);
      const d = readPage(file);
      need3(d);
      const hits = acceptBefore(d, flags.before);
      if (flags['dry-run']) return ['预演（没写入）：ended 早于 ' + flags.before + ' 的 done 轮次 ' + hits.length + ' 条会改为 accepted',
        ...hits.map((r) => 'round/' + r.id + ' ' + r.title + ' · ended ' + (r.ended || (r.updated + '（没有 ended，按 updated）')))].join('\n');
      if (!hits.length) return '0 条 done 改为 accepted（ended 早于 ' + flags.before + '） → ' + file;
    }
    if (name === 'round show') {
      const [id, ...more] = args;
      if (!id || more.length || kv.length) fail('用法: round show <页> <轮次 id> [--no-session]');
      const d = readPage(resolvePage(page));
      need3(d);
      const [, r] = find3(d, id, 'rounds');
      const lines = roundShowLines(d, r);
      if (flags['no-session']) return lines.join('\n');
      if (!r.sid) return [...lines, '会话: 这一轮没登记 sid'].join('\n');
      return [...lines, ...(await sessionNow(r.sid))].join('\n');
    }
    if (!ops3[name]) fail('用法: ' + cmd + ' ' + Object.keys(ops3).filter((k) => k.startsWith(cmd + ' ')).map((k) => k.split(' ')[1]).concat(['project', 'rule', 'rec'].includes(cmd) ? ['ls'] : [], cmd === 'round' ? ['show'] : [], cmd === 'rec' ? ['take'] : []).join(' | ') + ' <页> …（align ' + cmd + ' --help 看用法）');
    if (name === 'round add' || name === 'round set') await checkSidArg(kv, flags);
    if (kv.some(([k, v]) => k === 'visual' && v === 'true')) await needVisualApi();
    const pauseNote = await pauseLogFor(kv);
    const file = resolvePage(page);
    const { msg, data } = mutate(file, (d, now) => { need3(d); return ops3[name](d, now, args, kv, flags); });
    const lines = [msg + ' → ' + file, ...pauseNote];
    if (name === 'round done' || (name === 'round add' && flags.prev !== undefined)) {
      const rid = args[0].split('/').pop(), page = pageRef(data, file);
      lines.push(...pendingLines(data, rid, page), ...btwPendingLines(data, rid, page, { carried: name === 'round add' }));
    }
    if (name === 'decide done') lines.push(...decideDoneHint(data, args[0].split('/').pop(), pageRef(data, file)));
    return lines.join('\n');
  }
  if (!ops[cmd]) fail('用法: init | add | set | done | del | meta | ls | open | url | forget | refresh | serve | migrate | link | stale | log | usage | dispatch | sids | project | round | decide | note | rec | btw | todo | goal | import-po（align <命令> --help 看用法）');
  if (kv.some(([k, v]) => k === 'visual' && v === 'true')) await needVisualApi();
  const pauseNote = await pauseLogFor(kv);
  const file = resolvePage(ref);
  const { msg } = mutate(file, (d, now) => (d.version === 3 ? legacy3 : ops)[cmd](d, now, rest, kv));
  return [msg + ' → ' + file, ...pauseNote].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then((out) => { if (out) console.log(out); }, (e) => {
    console.error('align: ' + (e instanceof UsageError ? e.message : (e.stack || e.message)));
    process.exit(1);
  });
}
