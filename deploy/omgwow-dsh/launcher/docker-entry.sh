#!/bin/bash
# 容器入口：注入挂载的凭证 → 启动 dsh web (8893)。
# 不启动服务台：dsh-service-hub 插件固定对接常驻面板（宿主 127.0.0.1:6692），
# 容器用 --network host 时可直接复用，无需在容器内再起一份。
set -euo pipefail

CRED_DIR="/Users/lbc/Documents/dsh-credentials"
export OWTR_DSH_KEY="$(tr -d '[:space:]' < "$CRED_DIR/tokenrouter.key")"
export TOKENROUTER_API_KEY="$OWTR_DSH_KEY"
if [ -r "$CRED_DIR/deepseek.key" ]; then
  export DEEPSEEK_API_KEY="$(tr -d '[:space:]' < "$CRED_DIR/deepseek.key")"
fi

export DSH_HOME="${DSH_HOME:-/Users/lbc/Documents/dsh-v2-e2e/instance-015/dsh-home}"
export DSH_SKILLS_DIR="${DSH_SKILLS_DIR:-$DSH_HOME/skills}"
# 自研 skills 走这两个变量定位工具，别再依赖某个实例的绝对路径
export DSH_SERVICE_HUB_DIR="${DSH_SERVICE_HUB_DIR:-/Users/lbc/Documents/dsh-v2-e2e/instance-015/service-hub}"
export DSH_SERVICE_HUB_CLI="${DSH_SERVICE_HUB_CLI:-$DSH_SERVICE_HUB_DIR/scripts/service_hub.py}"
# colima 的 --network host 不共享宿主回环：容器里 127.0.0.1:6692 打不到宿主服务台，
# 必须走 host.docker.internal，否则 skill 登记的服务只会落进容器内的孤立 hub。
export DSH_SERVICE_HUB_URL="${DSH_SERVICE_HUB_URL:-http://host.docker.internal:6692}"
# 端口不继承调用方环境：显式固定，避免串到宿主 8892
export PORT="${WEB_PORT:-8893}"
# 本机自用：跳过浏览器 token 认证，直接开 http://127.0.0.1:8893 就能用。
# 仅对回环绑定的实例如此；设 0 即恢复「启动日志里的 ?token= 链接」那套认证。
export DSH_WEB_NO_AUTH="${DSH_WEB_NO_AUTH:-1}"
export DSH_INSTANCE_ID="${DSH_INSTANCE_ID:-8893-015}"
export DSH_INSTANCE_NAME="${DSH_INSTANCE_NAME:-dsh-v2-015}"
export DSH_BASE_URL="${DSH_BASE_URL:-http://127.0.0.1:$PORT}"
export PATH="/Users/lbc/Documents/dsh-v2-e2e/instance-015/src/node_modules/.bin:/usr/local/bin:$PATH"

cd /Users/lbc/Documents/dsh-v2-e2e/instance-015/src
exec node --max-old-space-size="${DSH_MAX_OLD_SPACE:-6144}" \
  --import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port "$PORT" --no-open
