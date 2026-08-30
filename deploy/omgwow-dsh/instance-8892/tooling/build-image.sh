#!/bin/bash
# 构建 dsh-v2 Docker 镜像。
# 前置：deepseek-harness worktree（omgwowh-my-dsh-v2 分支）已完成 pnpm install 且
#       所有 client 包已跑过 bundle（lib/ 产物就位，见 docs 的构建清单）。
# 用法：bash /Users/lbc/Documents/dsh-v2/build-image.sh
set -euo pipefail
cd /Users/lbc/Documents/dsh-v2

rm -rf build-context && mkdir -p build-context/build-src build-context/client-lib

echo "== 1/4 导出干净源码树（不含 node_modules）"
git -C deepseek-harness archive HEAD | tar -x -C build-context/build-src

echo "== 2/4 收集 client 包与 vendor 构建产物（lib/，gitignore 不在 archive 里）"
(cd deepseek-harness && find packages apps/web vendor -type d \( -name lib -o -name dist \) -print) > /tmp/v2-lib-dirs.txt
if [ -s /tmp/v2-lib-dirs.txt ]; then
  tar -C deepseek-harness -cf - $(cat /tmp/v2-lib-dirs.txt) | tar -C build-context/client-lib -xf -
fi

echo "== 3/4 复制 profile / tooling / service-hub / 启动脚本"
cp dsh-home/profiles/web/package.json build-context/profiles.web.package.json
cp -R dsh-home build-context/dsh-home
rm -rf build-context/dsh-home/profiles/node_modules build-context/dsh-home/profiles/web/node_modules
cp -R tooling build-context/tooling
rm -rf build-context/tooling/mem-monitor/reports
cp -R service-hub build-context/service-hub
rm -rf build-context/service-hub/state

echo "== 4/4 docker build"
docker build -t dsh-v2:latest -f Dockerfile build-context
echo "镜像构建完成：dsh-v2:latest"
