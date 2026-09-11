# 平行实例镜像：deepseek-harness dsh-v0.1.5-rc.2 + omgwow 插件/skills 适配层
#
# 与 8892 实例镜像（dsh-v2:latest，基于 0.1.2-alpha.5）并存，互不影响。
# 镜像内沿用与宿主一致的绝对路径，便于与宿主实例对照排障：
#   /Users/lbc/Documents/dsh-v2-e2e/instance-015/src        源码检出 + node_modules（Linux 内重装）
#   /Users/lbc/Documents/dsh-v2-e2e/instance-015/dsh-home   DSH_HOME（profile web + 16 skills + settings）
#   /Users/lbc/Documents/dsh-v2-e2e/instance-015/plugins    自研插件源码（profile 以 file: 引用）
#   /Users/lbc/Documents/dsh-v2-e2e/instance-015/service-hub 本地服务台 v2
# 凭证目录 /Users/lbc/Documents/dsh-credentials 运行时只读挂载，不烘焙进镜像。
FROM node:24-slim

ENV DEBIAN_FRONTEND=noninteractive

# 运行期依赖（与 8892 镜像保持一致）：python3（服务台/技能脚本）、zstandard（读会话日志）、
# git（github: 依赖）、curl、rsync/openssh-client（session-cloud-sync）、ffmpeg（record-browser-gif）、
# kubectl（集群类 skill）、build-essential（编译 native addon）、
# musl-tools（landlock-run 是静态 musl 二进制，缺它 Linux 上没有沙箱 → 所有 bash 调用直接失败）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip git curl rsync openssh-client ffmpeg ca-certificates procps build-essential musl-tools \
    && pip3 install --break-system-packages zstandard \
    && rm -rf /var/lib/apt/lists/* \
    && KARCH="amd64"; case "$(uname -m)" in aarch64|arm64) KARCH="arm64";; esac \
    && (curl --retry 5 --retry-delay 3 --retry-all-errors -fsSL "https://dl.k8s.io/release/v1.30.3/bin/linux/${KARCH}/kubectl" -o /usr/local/bin/kubectl \
        && chmod +x /usr/local/bin/kubectl \
        || echo "WARN: kubectl 下载失败（网络），集群类 skill 在容器内不可用") \
    && mkdir -p /Users/lbc/Documents/dsh-v2-e2e/instance-015

WORKDIR /Users/lbc/Documents/dsh-v2-e2e/instance-015/src

# 1) 源码检出（tag dsh-v0.1.5-rc.2 的干净源码树，不含 node_modules）
COPY build-src/ /Users/lbc/Documents/dsh-v2-e2e/instance-015/src/
# 2) 依赖安装（pnpm 11.7，与仓库 packageManager 一致）
RUN npm install -g pnpm@11.7.0 \
    && pnpm install --frozen-lockfile --fetch-retries 5
# 3) v0.1.5 新增的 native 组件：会话租约 flock（Node-API）+ 沙箱 landlock-run（静态 musl）。
#    8892 镜像里没有这一步——0.1.2-alpha.5 没有 native/ 子系统。
#    注意 build:native-system 带 --host-addon-only，只编 flock；不带上它才会编 landlock，
#    缺 landlock 时容器内没有任何沙箱可用，workspace-write 模式下**所有 bash 调用都会失败**。
RUN pnpm run build:native-system \
    && npx tsx native/system/scripts/build.ts \
    && ls -la native/system/packages/*/bin/
# 4) 客户端产物：宿主已跑过 build:lib / build:web（lib/ 与 dist/ 被 gitignore，不进 archive）
COPY client-lib/ /Users/lbc/Documents/dsh-v2-e2e/instance-015/src/
# 5) 实例配置层：插件源码 / DSH_HOME / 服务台 / 工具
COPY plugins/ /Users/lbc/Documents/dsh-v2-e2e/instance-015/plugins/
COPY dsh-home/ /Users/lbc/Documents/dsh-v2-e2e/instance-015/dsh-home/
COPY service-hub/ /Users/lbc/Documents/dsh-v2-e2e/instance-015/service-hub/
COPY tooling/ /Users/lbc/Documents/dsh-v2-e2e/instance-015/tooling/
RUN cd /Users/lbc/Documents/dsh-v2-e2e/instance-015/dsh-home/profiles/web \
    && pnpm install --fetch-retries 5

ENV DSH_HOME=/Users/lbc/Documents/dsh-v2-e2e/instance-015/dsh-home \
    DSH_SKILLS_DIR=/Users/lbc/Documents/dsh-v2-e2e/instance-015/dsh-home/skills \
    DSH_INSTANCE_ID=8893-015 \
    DSH_INSTANCE_NAME=dsh-v2-015 \
    PORT=8893 \
    PATH="/Users/lbc/Documents/dsh-v2-e2e/instance-015/src/node_modules/.bin:/usr/local/bin:$PATH"
EXPOSE 8893

CMD ["bash", "/Users/lbc/Documents/dsh-v2-e2e/instance-015/tooling/docker-entry.sh"]
