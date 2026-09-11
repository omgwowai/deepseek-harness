# 平行实例部署包（8893 形态）

一套与现有实例**完全隔离**的部署：独立源码检出、独立 `DSH_HOME`、独立端口、
独立 pnpm store，容器化运行。用于在不影响在用实例的前提下验证新版本与适配层。

## 内容

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 镜像定义：官方 `node:24-slim` + 运行期依赖 + 源码 + 客户端产物 + 实例配置层 |
| `build-image.sh` | 构建脚本：导出源码树 → 收集构建产物 → 组装上下文 → `docker build` |
| `service-hub/` | 本地服务台 v2（`hub.py` + CLI + 启动脚本），常驻面板与集群任务总览 |
| profile 层 | 见 `../profile/`（`cordis.patch.yml` / `package.json` / `settings.yaml`） |

## 端口约定

| 用途 | 默认 | 说明 |
|---|---|---|
| dsh web | 8893 | `WEB_PORT` 覆盖；镜像内 `--host 127.0.0.1` 回环绑定 |
| 本地服务台 | 6692 | 常驻共享面板；容器内经 `DSH_SERVICE_HUB_URL` 指向 `host.docker.internal:6692` |

**注意**：不要继承调用方环境的 `PORT`。宿主上的 dsh 实例会导出 `PORT=<自己的端口>`，
启动脚本若不显式固定就会串端口（本项目踩过：新实例去绑了在用的 8892）。

## 构建

```bash
# 前置：src 已完成 pnpm install，且跑过 build:lib + build:web
bash build-image.sh
docker build -t dsh-v2-015:latest -f Dockerfile ../build-context
```

两个关键点（都是实测踩出来的）：

1. **必须导出工作树，不能用 `git archive HEAD`**。运行时经 `tsconfig.base.json` 的
   `paths` 直接加载 `packages/*/src`，而 `archive` 只导出已提交内容——未提交的本地补丁
   （`mergeUserMessages`、`DSH_WEB_NO_AUTH`）会被整批丢掉，表现为「补丁写了但完全不生效」。
2. **必须在镜像内编出 `landlock-run`**。`build:native-system` 自带 `--host-addon-only`，
   只编 `flock`；Linux 上缺 `landlock-run` 会导致没有任何沙箱可用，`workspace-write`
   模式下**所有 bash 调用直接失败**。需要装 `musl-tools` 并额外跑一次不带该 flag 的
   `native/system/scripts/build.ts`。

## 运行

```bash
docker run -d --name dsh-v2-015 --restart unless-stopped --network host \
  -e WEB_PORT=8893 -e DSH_INSTANCE_ID=8893-015 -e DSH_INSTANCE_NAME=dsh-v2-015 \
  -e DSH_SERVICE_HUB_URL=http://host.docker.internal:6692 \
  -v "$CRED_DIR":/Users/lbc/Documents/dsh-credentials:ro \
  -v "$HOME/.ssh":/root/.ssh:ro \
  dsh-v2-015:latest
```

需要长期迭代的目录建议挂载（避免每次改配置都重建镜像）：skills、tooling、
以及 `profiles/web/cordis.patch.yml` 单文件。
**不要**整目录挂 `dsh-home/profiles/web/`——宿主那份 `node_modules` 是在 macOS 上装的，
盖进容器会让原生模块（`node-pty`）失效。

会话、账本、日志则相反，应该挂回宿主同名路径，方便查看与让服务台读到：

```bash
  -v "$INSTANCE/dsh-home/sessions":/Users/lbc/Documents/dsh-v2-e2e/instance-015/dsh-home/sessions \
  -v "$INSTANCE/dsh-home/storages":.../storages \
  -v "$INSTANCE/dsh-home/logs":.../logs
```

## 免登录（本机自用）

镜像内的启动器默认 `DSH_WEB_NO_AUTH=1`，直接开 `http://127.0.0.1:8893/` 即可，
不需要启动日志里的 `?token=` 链接。设 `DSH_WEB_NO_AUTH=0` 即恢复认证。

该开关只作用于回环绑定的实例；正式/对外部署请保持默认（关闭）。

## 验证清单

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8893/     # 期望 200（免登录）
docker exec dsh-v2-015 sh -c 'echo SANDBOX-OK'                       # 沙箱可用
docker logs dsh-v2-015 2>&1 | tail -3                                # 启动无报错
```

## 与本适配层相关的已知问题

- `dsh-outline@0.1.6` 在 0.1.5 上崩溃（`snapshot.nodes is not iterable`），大纲功能静默失效。
- `dsh-mem-watch` / `dsh-service-hub` 的控件在 `conversation.composer.dock`（session 作用域），只有会话有内容时才显示；停在欢迎态时不显示，属上游设计。
- `dsh-service-hub` 插件的自动实例上报在 0.1.5 上未触发；配置了 `hubUrl` 且网络可达时
  仍需手动确认面板是否出现本实例。

详见 [`../docs/0.1.5-兼容性报告.md`](../docs/0.1.5-兼容性报告.md)。
