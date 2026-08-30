#!/usr/bin/env bash
# dsh 会话记录云端同步（8877 实例）
# 目标：oracle-sg-bastion01:/ch/home/bochao_li/deepseek-harness-session-record
# 用法：
#   session-record-sync.sh ensure <session-work-dir-name>   新会话开始时建远端同名目录
#   session-record-sync.sh sync                              全量 rsync（本地保留不删）
#   session-record-sync.sh status                            查看远端目录结构
set -uo pipefail

SSH_HOST="oracle-sg-bastion01"
REMOTE_ROOT="/ch/home/bochao_li/deepseek-harness-session-record/harness-rc8"
DSH_HOME_LOCAL="/Users/lbc/Documents/dsh-v2/dsh-home"
WORK_ROOT="/Users/lbc/Documents/dsh-v2"
PY="/usr/bin/python3"
NOTIFY="/Users/lbc/Documents/dsh-v2/dsh-home/skills/feishu/scripts/feishu-notify.py"
STATE_DIR="/Users/lbc/Documents/dsh-v2/dsh-home/skills/session-cloud-sync/state"
LOG="$STATE_DIR/sync.log"
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="$TMPDIR/session-sync"; mkdir -p "$STATE_DIR" 2>/dev/null || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

notify() { "$PY" "$NOTIFY" "$1" >> "$LOG" 2>&1 || true; }

die() { log "ERROR: $*"; echo "ERROR: $*" >&2; exit 1; }

ssh_remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" "$@" 2>&1; }

ensure_remote() {
  local name="$1"
  [ -n "$name" ] || die "ensure 需要一个会话目录名"
  ssh_remote "mkdir -p '$REMOTE_ROOT/session-work/$name' && echo created '$REMOTE_ROOT/session-work/$name'" || die "远端建目录失败"
  log "ensure: $name"
  echo "远端目录已就绪: $REMOTE_ROOT/session-work/$name"
}

do_sync() {
  local rc=0
  # 1) 会话记录（zstd 日志等）
  if ! rsync -az --no-perms --no-owner --no-group -e "ssh -o BatchMode=yes -o ConnectTimeout=15" \
      "$DSH_HOME_LOCAL/sessions/" "$SSH_HOST:$REMOTE_ROOT/sessions/" >> "$LOG" 2>&1; then
    rc=1
  fi
  # 2) 各会话的工作产物目录（session-work）
  if [ -d "$WORK_ROOT/session-work" ]; then
    if rsync -az --no-perms --no-owner --no-group -e "ssh -o BatchMode=yes -o ConnectTimeout=15" \
        "$WORK_ROOT/session-work/" "$SSH_HOST:$REMOTE_ROOT/session-work/" >> "$LOG" 2>&1; then
      :
    else
      # launchd 上下文无 ~/Documents 读取权限（TCC）时降级：只同步 sessions，报告部分成功
      log "WARN: session-work 同步被拒（TCC），仅同步了 sessions"
      notify "DSH 日报｜⚠️ 12:30 同步部分完成：session-work 因 macOS 权限未同步（sessions 已同步）。修复：系统设置→隐私与安全性→完全磁盘访问，勾选 /usr/bin/rsync 与 /bin/bash。"
      rc=2
    fi
  fi
  return $rc
}

remote_status() {
  ssh_remote "ls -la '$REMOTE_ROOT' 2>/dev/null; echo '---'; du -sh '$REMOTE_ROOT' 2>/dev/null"
}

case "${1:-}" in
  ensure)
    ensure_remote "${2:-}"
    ;;
  sync)
    if do_sync; then
      total=$(du -sh "$DSH_HOME_LOCAL/sessions" 2>/dev/null | cut -f1)
      log "sync OK"
      notify "DSH 日报｜✅ 会话同步成功（12:30）｜本地会话已增量复制到 oracle-sg-bastion01:deepseek-harness-session-record（本地保留，会话数据 ${total}）"
      echo "sync OK"
    else
      log "sync FAILED"
      notify "DSH 日报｜⚠️ 会话同步失败｜请检查 $(hostname) 上的 com.dsh.session-record-sync 日志：$LOG"
      echo "sync FAILED" >&2
      exit 1
    fi
    ;;
  status)
    remote_status
    ;;
  *)
    echo "usage: $0 ensure <name> | sync | status" >&2
    exit 2
    ;;
esac
