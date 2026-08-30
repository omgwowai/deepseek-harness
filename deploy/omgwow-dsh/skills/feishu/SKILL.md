---
name: feishu
description: 飞书集成：lark-cli 本地操作（知识库 wiki/docs、鉴权 device-flow）、群机器人消息推送（feishu-notify，webhook 需使用者先行在飞书群注册自定义机器人获取；测试环境使用过的 webhook 上线前必须替换）、以及流程化的飞书通告创建。Use for 知识库文档操作、粘贴飞书文档、创建飞书公告/通知、推送同步结果与大文件清单到飞书。
---

# 飞书（Feishu）Skill

本 Skill 统一管理本机飞书能力：lark-cli 操作、群消息推送、通告创建流程。

## 工具位置

- lark-cli：`$HOME/Documents/harness-rc8/tooling/lark-cli/node_modules/.bin/lark-cli`（本地安装，@larksuite/cli 1.0.88）
- 群消息推送：`/Users/lbc/Documents/dsh-v2/dsh-home/skills/feishu/scripts/feishu-notify.py`（群机器人 webhook 由使用者自行注册，配置在 `/Users/lbc/Documents/dsh-credentials/feishu-webhook.conf`）

```bash
LARK=$HOME/Documents/harness-rc8/tooling/lark-cli/node_modules/.bin/lark-cli
NOTIFY="/usr/bin/python3 /Users/lbc/Documents/dsh-v2/dsh-home/skills/feishu/scripts/feishu-notify.py"
```

## 鉴权（周期性需要，按此流程处理）

1. 先检查：`$LARK auth status`。输出含 `"user"` 身份且无 "needs refresh" 提示则可用。
2. 需要登录/刷新时，**必须明确把授权链接发给用户**让其完成，不要静默失败：

   ```bash
   $LARK auth login --no-wait --json   # 输出 verification URL（device flow）
   ```

   把 URL 发给用户并说明"请在浏览器完成授权"；用户确认后运行：

   ```bash
   $LARK auth login --device-code <code>
   ```

3. 需要二维码时：`$LARK auth qrcode`。

## 知识库 / 文档操作（用户粘贴知识库文档或要求基于飞书内容操作时）

默认走 lark-cli（`--as user`）。常用模式（参考现有日报归档脚本）：

```bash
# 浏览命令与参数
$LARK wiki --help
$LARK docs --help
$LARK schema wiki.v2.space_node.list    # 查具体 API 的参数

# 找/建知识库节点（space-id 由使用者指定，即目标知识库）
$LARK wiki +node-list --as user --space-id 7624384248404773820 --parent-node-token <token>
$LARK wiki +node-create --as user --space-id 7624384248404773820 --parent-node-token <token> --title "节点名" --obj-type docx

# 写入文档内容（markdown）
cat content.md | $LARK docs +update --as user --doc <obj_token> --command append --doc-format markdown --content -

# 任意 OpenAPI 端点兜底
$LARK api GET /open-apis/wiki/v2/spaces --params '{"page_size":20}'
```

- 高风险写操作（--help 标注 high-risk-write）必须先经用户确认再加 `--yes`。
- 用户粘贴的飞书文档内容：若用户给了 URL/链接，用 `api GET` 对应 wiki/docs 端点读取后处理；纯文本直接按要求处理。
- 不要输出 app_secret、token 等凭据。

## 注册群机器人（webhook）

使用群消息推送前，使用者需先在自己目标飞书群里注册自定义机器人（每个群一次）：

1. 打开飞书目标群 → 右上角「设置」→「群机器人」→「添加机器人」→「自定义机器人」。
2. 给机器人命名（如「DSH 日报助手」），创建后在页面上**复制 Webhook 地址**
   （`https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，token 即凭证）。
3. 安全设置按需选择（关键词过滤建议填 `日报`；IP 白名单可选）。创建时未填关键词，
   后续发消息内容必须含某个已配置关键词，否则推送被拒。
4. 把 Webhook 地址写入本地 `/Users/lbc/Documents/dsh-credentials/feishu-webhook.conf`（权限 600，不入库）。
5. 首次接入/测试时可用一条含关键词的消息验证；**测试环境用过的 webhook 上线前必须
   替换为各环境自己的机器人**，避免把测试群消息发到正式群或反之。
6. 机器人只会把消息发到它被创建的那个群，不能跨群。

> 本 skill 的 feishu-notify 脚本只读取 webhook.conf 发送，不做任何云端调用；
> 换机器人 = 替换 webhook.conf 内容即可。

## 群消息推送
（同步结果 / 大文件清单 / 通知）

```bash
$NOTIFY "DSH 日报｜<标题>｜<内容摘要>"
```

- **必须包含关键词"日报"**：该群机器人开启了关键词校验，不含"日报"的消息会被飞书拒绝（code 19024）。所有推送都以 `DSH 日报｜` 开头。

- 文本上限约 20K 字符（自动截断）。
- 用途：每日 12:30 会话同步结果；每个对话结尾的"重资产清单"（>10 个同类文件或 >10MB 单文件或 clone/权重下载）推送，让飞书里形成持久的数据清理清单。

## 通告创建流程（流程化 Skill 动作）

用户要求"创建飞书通告/公告/通知"时，按固定流程执行：

1. **确认内容与渠道**：问清通告标题、正文要点、发送渠道（日报群 webhook / 知识库文档 / 其它群）。
2. **群渠道**：直接 `feishu-notify.py` 发送（可加 `【通告】` 前缀与日期）。
3. **知识库渠道**：按上文知识库流程在使用者指定的知识库（space-id 或名称）下按月建 `YYYY-MM` 节点、按日建 `YYYY-MM-DD` docx，把通告内容以 markdown 追加进去。
4. **发送后**：向用户汇报发送结果（webhook 返回 JSON 的 code/msg 或 lark-cli 输出的节点 token）。
5. **失败处理**：鉴权过期走鉴权流程；webhook 失败原样报告，不要重试超过 2 次。

## 现有机器人说明

- 日报机器人：sg-compute（oracle-sg-bastion01）cron 08:30 运行 `~/dsh-daily-report/run-daily.sh`，生成 DeepSeek Harness 仓库日报并推送到同一日报群（本 Skill 的 webhook 即该群），随后用远端 lark-cli 归档知识库。
- 本 Skill 的推送与日报走同一群，方便统一浏览；如需独立会话/群，告知后另配 webhook。
