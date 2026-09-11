#!/bin/bash
# 平行实例启动器（instance-015 = deepseek-harness dsh-v0.1.5-rc.2 隔离实例）
#
# 与 8892 实例（0.1.2-alpha.5 + omgwow 适配层）完全隔离：
#   源码  $BASE/src          独立检出 @ tag dsh-v0.1.5-rc.2
#   配置区 $BASE/dsh-home     独立 DSH_HOME（profile web + 16 skills + settings）
#   端口  8893 (web) / 6693 (service hub)
# 凭证仍从固定目录只读注入，不入库、不落盘。
set -euo pipefail

BASE="${INSTANCE_DIR:-/Users/lbc/Documents/dsh-v2-e2e/instance-015}"  # 按实际部署目录覆盖
CRED="/Users/lbc/Documents/dsh-credentials"
# 不继承宿主环境的 PORT（宿主 dsh 导出 PORT=8892，会串端口）
WEB_PORT="${WEB_PORT:-8893}"  # 显式固定，避免继承宿主 dsh 导出的 PORT
export PORT="$WEB_PORT"
HUB_PORT="${HUB_PORT_OVERRIDE:-6693}"

[ -r "$CRED/tokenrouter.key" ] || { echo "ERROR: 缺少 $CRED/tokenrouter.key" >&2; exit 1; }
export OWTR_DSH_KEY="$(tr -d '[:space:]' < "$CRED/tokenrouter.key")"
export TOKENROUTER_API_KEY="$OWTR_DSH_KEY"
if [ -r "$CRED/deepseek.key" ]; then
  export DEEPSEEK_API_KEY="$(tr -d '[:space:]' < "$CRED/deepseek.key")"
fi

export DSH_HOME="$BASE/dsh-home"
export DSH_SKILLS_DIR="$DSH_HOME/skills"
export DSH_INSTANCE_ID="8893"
export DSH_INSTANCE_NAME="dsh-v2-015"
export DSH_BASE_URL="http://127.0.0.1:$WEB_PORT"
export DSH_SERVICE_HUB_PORT="$HUB_PORT"
export PATH="$BASE/rt/bin:$BASE/src/node_modules/.bin:/Users/lbc/Documents/dsh-v2/tools:/opt/homebrew/bin:$PATH"

# 服务台 v2（隔离端口 6693，幂等）
if ! curl -sf -m 2 "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1; then
  mkdir -p "$BASE/service-hub/state"
  nohup /usr/bin/python3 "$BASE/service-hub/hub.py" --host 127.0.0.1 --port "$HUB_PORT" \
    >> "$BASE/service-hub/state/hub.log" 2>&1 &
  disown 2>/dev/null || true
fi

cd "$BASE/src"
mkdir -p "$DSH_HOME/logs"
exec "$BASE/rt/bin/node" --max-old-space-size=6144 --import tsx/esm \
  apps/cli/src/bin.ts web --host 127.0.0.1 --port "$WEB_PORT" --no-open
