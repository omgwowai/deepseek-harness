#!/bin/bash
# dsh-v2 实例启动器（基于 8890 的 rollout-select 配置 + 全部新功能）。
# 凭证从固定目录 /Users/lbc/Documents/dsh-credentials/ 读取（只读，0400）。
# 用法：PORT=8892 bash /Users/lbc/Documents/dsh-v2/tooling/start-dsh-v2.sh
set -euo pipefail

CRED_DIR="/Users/lbc/Documents/dsh-credentials"
KEY_FILE="$CRED_DIR/tokenrouter.key"
[ -r "$KEY_FILE" ] || { echo "ERROR: tokenrouter key not readable: $KEY_FILE" >&2; exit 1; }
export TOKENROUTER_API_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
export OWTR_DSH_KEY="$TOKENROUTER_API_KEY"

DEEPSEEK_KEY_FILE="$CRED_DIR/deepseek.key"
if [ -r "$DEEPSEEK_KEY_FILE" ]; then
  export DEEPSEEK_API_KEY="$(tr -d '[:space:]' < "$DEEPSEEK_KEY_FILE")"
fi

cd /Users/lbc/Documents/dsh-v2/deepseek-harness
export DSH_HOME=/Users/lbc/Documents/dsh-v2/dsh-home
export PATH="$PWD/node_modules/.bin:/Users/lbc/Desktop/work/deepseek-harness-runtime/node_modules/node/bin:$HOME/bin:/opt/homebrew/bin:$PATH"

# 服务台（local-service-hub v2）：如未运行则拉起
if ! curl -sf -m 2 http://127.0.0.1:${DSH_SERVICE_HUB_PORT:-6692}/api/health >/dev/null 2>&1; then
  mkdir -p /Users/lbc/Documents/dsh-v2/service-hub/state
  nohup /usr/bin/python3 /Users/lbc/Documents/dsh-v2/service-hub/hub.py \
    --host 127.0.0.1 --port ${DSH_SERVICE_HUB_PORT:-6692} \
    >> /Users/lbc/Documents/dsh-v2/service-hub/state/hub.log 2>&1 &
  disown 2>/dev/null || true
fi

PORT="${PORT:-8892}"
export DSH_INSTANCE_ID="${DSH_INSTANCE_ID:-8892}"
export DSH_INSTANCE_NAME="${DSH_INSTANCE_NAME:-dsh-v2}"
export DSH_BASE_URL="${DSH_BASE_URL:-http://127.0.0.1:$PORT}"

# 5s 级内存监控由 dsh-mem-watch 插件在进程内完成；此处保留进程级兜底日志。
exec /Users/lbc/Desktop/work/deepseek-harness-runtime/node_modules/node/bin/node \
  --max-old-space-size=6144 \
  --report-on-fatalerror \
  --report-directory=/Users/lbc/Documents/dsh-v2/tooling/mem-monitor/reports \
  --import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port "$PORT" --no-open
