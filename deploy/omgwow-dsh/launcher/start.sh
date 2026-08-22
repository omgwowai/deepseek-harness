#!/bin/bash
# DeepSeek Harness 适配层启动器（omgwow）：
# 从密钥文件注入 Token Router 与 DeepSeek 官方 API Key 后启动 dsh web。
# 密钥文件由使用者在本地自备（绝不入库）：
#   $KEY_DIR/tokenrouter.key    Token Router API Key（来源：Token Router 仪表盘）
#   $KEY_DIR/deepseek.key       DeepSeek 官方 API Key（来源：platform.deepseek.com）
# 可选：PORT 指定监听端口（缺省 8080）
# 使用：KEY_DIR=<你的密钥目录> CHECKOUT=<harness 检出目录> bash start.sh
set -euo pipefail

KEY_DIR="${KEY_DIR:-$HOME/tokenrouter-access}"
DEEPSEEK_KEY_FILE="${DEEPSEEK_KEY_FILE:-$KEY_DIR/deepseek.key}"
TOKENROUTER_KEY_FILE="${TOKENROUTER_KEY_FILE:-$KEY_DIR/tokenrouter.key}"

if [ -r "$TOKENROUTER_KEY_FILE" ]; then
  export TOKENROUTER_API_KEY="$(tr -d '[:space:]' < "$TOKENROUTER_KEY_FILE")"
else
  echo "WARN: Token Router key file not readable: $TOKENROUTER_KEY_FILE" >&2
fi
if [ -r "$DEEPSEEK_KEY_FILE" ]; then
  export DEEPSEEK_API_KEY="$(tr -d '[:space:]' < "$DEEPSEEK_KEY_FILE")"
else
  echo "WARN: DeepSeek key file not readable: $DEEPSEEK_KEY_FILE" >&2
fi

# DSH_HOME 与 checkout 路径：使用者按本地实际路径修改
DSH_HOME="${DSH_HOME:-$HOME/.dsh-v2}"
export DSH_HOME
CHECKOUT="${CHECKOUT:-$HOME/deepseek-harness-011rc1}"
cd "$CHECKOUT"
export PATH="$PWD/node_modules/.bin:$PATH"
PORT="${PORT:-8080}"
exec pnpm dsh web --host 127.0.0.1 --port "$PORT" --no-open
