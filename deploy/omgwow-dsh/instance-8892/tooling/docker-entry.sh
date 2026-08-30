#!/bin/bash
# 容器入口：读取挂载的固定凭证目录 → 拉起本地服务台 → 启动 dsh web。
set -euo pipefail

CRED_DIR="/Users/lbc/Documents/dsh-credentials"
export OWTR_DSH_KEY="$(tr -d '[:space:]' < "$CRED_DIR/tokenrouter.key")"
export TOKENROUTER_API_KEY="$OWTR_DSH_KEY"
if [ -r "$CRED_DIR/deepseek.key" ]; then
  export DEEPSEEK_API_KEY="$(tr -d '[:space:]' < "$CRED_DIR/deepseek.key")"
fi

export DSH_HOME="${DSH_HOME:-/Users/lbc/Documents/dsh-v2/dsh-home}"
export DSH_SERVICE_HUB_PORT="${DSH_SERVICE_HUB_PORT:-6692}"
export PORT="${PORT:-8892}"
export DSH_INSTANCE_ID="${DSH_INSTANCE_ID:-8892}"
export DSH_INSTANCE_NAME="${DSH_INSTANCE_NAME:-dsh-v2}"
export DSH_BASE_URL="${DSH_BASE_URL:-http://127.0.0.1:$PORT}"

mkdir -p /Users/lbc/Documents/dsh-v2/service-hub/state
# 服务台（幂等：健康检查通过则不重复拉起）
if ! curl -sf -m 2 "http://127.0.0.1:$DSH_SERVICE_HUB_PORT/api/health" >/dev/null 2>&1; then
  nohup /usr/bin/python3 /Users/lbc/Documents/dsh-v2/service-hub/hub.py \
    --host 127.0.0.1 --port "$DSH_SERVICE_HUB_PORT" \
    >> /Users/lbc/Documents/dsh-v2/service-hub/state/hub.log 2>&1 &
fi

export PATH="/Users/lbc/Documents/dsh-v2/deepseek-harness/node_modules/.bin:/usr/local/bin:$PATH"
cd /Users/lbc/Documents/dsh-v2/deepseek-harness
# 新版上游只允许回环绑定（--host 0.0.0.0 被拒绝），容器请用 --network host 运行：
#   docker run -d --name dsh-v2 --network host \
#     -e PORT=8892 -e DSH_SERVICE_HUB_PORT=6692 \
#     -v /Users/lbc/Documents/dsh-credentials:/Users/lbc/Documents/dsh-credentials:ro dsh-v2:latest
exec node --max-old-space-size="${DSH_MAX_OLD_SPACE:-6144}" \
  --import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port "$PORT" --no-open
