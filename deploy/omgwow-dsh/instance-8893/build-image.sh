#!/bin/bash
# 构建平行实例镜像 dsh-v2-015:latest（deepseek-harness dsh-v0.1.5-rc.2 + 适配层）。
#
# 前置：src/ 已完成 pnpm install 且跑过 build:lib / build:web（lib/ 与 dist/ 被 gitignore，
#       不进 git archive，必须单独收集）。
# 用法：bash /Users/lbc/Documents/dsh-v2-e2e/instance-015/build-image.sh
set -euo pipefail

BASE="/Users/lbc/Documents/dsh-v2-e2e/instance-015"
cd "$BASE"

rm -rf build-context
mkdir -p build-context/build-src build-context/client-lib

echo "== 1/5 导出源码树（工作树，含未提交的本地补丁；不含 node_modules/.git）"
# 必须导出工作树而不是 `git archive HEAD`：运行时经 tsconfig.base.json 的 paths
# 直接加载 packages/*/src，所以镜像里的 src 必须与宿主测试过的树一致。用 archive
# 会把未提交的本地补丁（llm-pi-ai mergeUserMessages、DSH_WEB_NO_AUTH 等）整批丢掉。
tar -C src --exclude=node_modules --exclude=.git -cf - . | tar -x -C build-context/build-src
echo "   源码文件数：$(find build-context/build-src -type f | wc -l | tr -d ' ')"

echo "== 2/5 收集客户端构建产物（lib/ 与 dist/）"
(cd src && find packages apps/web vendor -type d \( -name lib -o -name dist \) -print) > /tmp/015-lib-dirs.txt
echo "   产物目录数：$(wc -l < /tmp/015-lib-dirs.txt | tr -d ' ')"
tar -C src -cf - $(cat /tmp/015-lib-dirs.txt) | tar -C build-context/client-lib -xf -

echo "== 3/5 收集实例配置层（plugins / dsh-home / service-hub / tooling）"
cp -R plugins build-context/plugins
cp -R dsh-home build-context/dsh-home
rm -rf build-context/dsh-home/profiles/node_modules build-context/dsh-home/profiles/web/node_modules
rm -rf build-context/dsh-home/logs build-context/dsh-home/sessions build-context/dsh-home/storages
cp -R service-hub build-context/service-hub
rm -rf build-context/service-hub/state
cp -R tooling build-context/tooling

echo "== 4/5 构建上下文大小"
du -sh build-context

echo "== 5/5 docker build"
docker build -t dsh-v2-015:latest -f Dockerfile build-context
echo "镜像构建完成：dsh-v2-015:latest"
