# dsh-v2 (基于 8890 实例的全新实例) 镜像
# 构建：cd /Users/lbc/Documents/dsh-v2 && docker build -t dsh-v2:latest .
# 布局说明：镜像内沿用与宿主机一致的绝对路径
#   /Users/lbc/Documents/dsh-v2/deepseek-harness   （源码检出 + node_modules，Linux 重装）
#   /Users/lbc/Documents/dsh-v2/dsh-home           （DSH_HOME：profile web + skills + settings）
#   /Users/lbc/Documents/dsh-v2/tooling            （自研插件 + 启动脚本）
#   /Users/lbc/Documents/dsh-v2/service-hub        （本地服务台 v2）
#   /Users/lbc/Documents/dsh-credentials           （运行时只读挂载，不烘焙进镜像）
FROM node:24-slim

ENV DEBIAN_FRONTEND=noninteractive

# 运行期依赖：python3（服务台/技能脚本）、zstandard（读 dsh 会话日志）、
# git（github: 依赖与 gh 技能）、curl、rsync/openssh-client（session-cloud-sync）、
# ffmpeg（record-browser-gif 技能，可选但默认装上）、kubectl（集群监控轮询）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip git curl rsync openssh-client ffmpeg ca-certificates procps build-essential \
    && pip3 install --break-system-packages zstandard \
    && rm -rf /var/lib/apt/lists/* \
    && KARCH="amd64"; case "$(uname -m)" in aarch64|arm64) KARCH="arm64";; esac \
    && (curl --retry 5 --retry-delay 3 --retry-all-errors -fsSL "https://dl.k8s.io/release/v1.30.3/bin/linux/${KARCH}/kubectl" -o /usr/local/bin/kubectl \
        && chmod +x /usr/local/bin/kubectl \
        || echo "WARN: kubectl 下载失败（网络），集群类 skill 在容器内不可用") \
    && mkdir -p /Users/lbc/Documents/dsh-v2 /Users/lbc/Documents/dsh-credentials

WORKDIR /Users/lbc/Documents/dsh-v2/deepseek-harness

# 1) 源码检出：构建期由构建机提供（docker build 前先 git worktree/clone 到 build-src）
COPY build-src/ /Users/lbc/Documents/dsh-v2/deepseek-harness/
# 2) 依赖安装（pnpm 11.7，经镜像自带 npm 从 npm registry 安装，避免 GitHub release 资产下载不稳）
RUN npm install -g pnpm@11.7.0 \
    && pnpm install --frozen-lockfile --fetch-retries 5

# 3) 工具与配置层
COPY dsh-home/ /Users/lbc/Documents/dsh-v2/dsh-home/
COPY tooling/ /Users/lbc/Documents/dsh-v2/tooling/
COPY service-hub/ /Users/lbc/Documents/dsh-v2/service-hub/
COPY profiles.web.package.json /Users/lbc/Documents/dsh-v2/dsh-home/profiles/web/package.json
RUN cd /Users/lbc/Documents/dsh-v2/dsh-home/profiles/web && pnpm install --fetch-retries 5

# 4) 客户端产物：构建期在宿主上先跑过 bundle（lib/ 被 gitignore），构建脚本负责拷贝
#    （client-lib/ 内保留 packages/... 相对路径，直接落在检出根上）
COPY client-lib/ /Users/lbc/Documents/dsh-v2/deepseek-harness/

# 5) 入口
ENV DSH_HOME=/Users/lbc/Documents/dsh-v2/dsh-home \
    DSH_INSTANCE_ID=8892 \
    DSH_INSTANCE_NAME=dsh-v2 \
    DSH_SERVICE_HUB_PORT=6692 \
    PATH="/Users/lbc/Documents/dsh-v2/deepseek-harness/node_modules/.bin:/usr/local/bin:$PATH"
EXPOSE 8892 6692
CMD ["bash", "/Users/lbc/Documents/dsh-v2/tooling/docker-entry.sh"]
