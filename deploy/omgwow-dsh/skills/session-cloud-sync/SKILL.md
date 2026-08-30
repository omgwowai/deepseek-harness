---
name: session-cloud-sync
description: 会话记录云端同步：新会话开始时在远端备份主机（SSH 别名与目录由使用者配置）下建立同名目录；每天 12:30 launchd 自动把本地 .dsh-v2/sessions 与 session-work 增量同步到远端（本地保留），结果推送到飞书日报群。Use for 会话云端备份、同步状态查询、远端目录确认。
---

# 会话记录云端同步（<跳板机别名>）

把本机 DeepSeek Harness 的会话数据同步到远端备份主机，形成云端留存。

```text
远端根目录:  <SSH别名>:<远端用户目录>/deepseek-harness-session-record/<项目名>/（按实际配置）
  sessions/         ← 本地 $DSH_HOME/sessions/ 的镜像（rsync 增量复制，本地保留）
  session-work/     ← 本地 session-work/ 的镜像
```

## 脚本

```bash
S=/Users/lbc/Documents/dsh-v2/dsh-home/skills/session-cloud-sync/scripts/session-record-sync.sh

bash $S ensure <session-work目录名>   # 新会话开始时建远端同名目录
bash $S sync                          # 立即全量同步（= 12:30 定时执行的内容）
bash $S status                        # 查看远端目录结构
```

## 工作流

1. **新对话开始**（AGENTS.md 规则第 3 条）：创建本地 `session-work/<日期>-<HHMM>-<主题>/` 后，立即执行 `ensure <该目录名>`，让远端先有本对话的同名目录。
2. **每日 12:30**：launchd（`com.dsh.session-record-sync`）自动执行 `sync`：
   - rsync `-az` 增量复制本地 sessions 与 session-work 到远端；**本地文件保留不删**；
   - 成功/失败都会通过 `feishu-notify` 推送到飞书日报群（见 feishu skill）。
3. **用户要求立即同步**：执行 `sync`。
4. 同步失败时：读 `/Users/lbc/Documents/dsh-v2/dsh-home/skills/session-cloud-sync/state/sync.log` 判断原因（SSH 不可达 / 磁盘 / 权限），修复后重跑 `sync`；不要改动远端既有数据。

## 边界

- 只同步会话数据（sessions + session-work），不同步 checkout、skills、tooling 等框架目录。
- 远端目录由同步脚本自动创建；不要手动在远端建无关目录。
- 同步是单向的（本地 → 云端），绝不要用 `--delete` 或从远端往回覆盖本地。
