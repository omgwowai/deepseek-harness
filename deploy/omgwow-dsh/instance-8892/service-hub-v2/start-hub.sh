#!/bin/bash
# 启动 dsh 本地服务台 v2（http://127.0.0.1:6692）。
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/python3 "$DIR/hub.py" --host 127.0.0.1 --port "${DSH_SERVICE_HUB_PORT:-6692}"
