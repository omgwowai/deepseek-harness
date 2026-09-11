# omgwow × DeepSeek Harness 适配层（0.1.5）

基于上游 tag **`dsh-v0.1.5-rc.2`**（`fb2c4b9e6`）的适配层：自研插件、自研 skills、
profile 补丁、启动器与实例部署包。核心 harness 本体保持上游原样，只带两处刻意的最小修改。

> 📖 凭证配置见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)；
> 每个凭证让哪些 skills 生效见 [docs/CREDENTIALS-INDEX.md](docs/CREDENTIALS-INDEX.md)。
>
> 本仓库不含任何密钥、token、webhook 或 kubeconfig 内容；凭证全部由使用者在
> 本地固定目录自备，经环境变量注入。

## 目录结构

```
deploy/omgwow-dsh/
├── plugins/                     4 个自研插件（预构建 JS，profile 以 file: 引用）
│   ├── dsh-tokenrouter-cost/    Token Router 计价与账本
│   ├── dsh-rollout-transparent/ 无感 Best-of-N rollout 与统计
│   ├── dsh-mem-watch/           进程内存采样与泄漏观察
│   └── dsh-service-hub/         本地服务台登记与一键打开
├── skills/                      5 个自研 skills（官方 skills 不在此目录，见下）
│   ├── feishu/                  飞书知识库与群机器人推送
│   ├── github-cluster-access/   GitHub SSH + Kubernetes + SSH 主机
│   ├── local-service-hub/       本地服务登记约定
│   ├── session-cloud-sync/      会话记录云端增量同步
│   └── cluster-task-monitor/    集群任务登记与进度节奏
├── profile/                     profile 层：模型路由、插件挂载、skills 目录
│   ├── cordis.patch.yml
│   ├── package.json
│   └── settings.yaml
├── launcher/                    启动器
│   ├── start.sh                 本地进程形态
│   └── docker-entry.sh          容器入口
├── instance-8893/               平行实例部署包
│   ├── Dockerfile
│   ├── build-image.sh
│   └── service-hub/             本地服务台 v2（Python 单文件）
└── docs/
    ├── CREDENTIALS.md
    ├── CREDENTIALS-INDEX.md
    ├── 0.1.5-兼容性报告.md       迁移到 0.1.5 的逐项实测结论
    └── 服务台-v3-会话格式分析.md  会话格式 v3 导致服务台失效的定位与修复
```

## 相对上游的本地代码修改（只有两处）

| 位置 | 改动 | 为什么 |
|---|---|---|
| `packages/llm/llm-pi-ai` | provider 级 `mergeUserMessages`（默认 false） | 某些网关（共享路由背后的区域链路）会在上游重新合并连续 user 消息并丢掉 image 分片。开启后在发往 wire 前把连续 user 消息折叠成一条，网关没有可再拆分的边界。纯文本请求不受影响。 |
| `packages/client/connection` | `DSH_WEB_NO_AUTH=1` 时跳过浏览器会话认证（默认关闭） | 回环绑定的单机实例由使用者自己掌控，每天带 `?token=` 链接登录是纯负担。默认关闭，正式部署仍保持 cookie 校验。 |

其余全部为新增文件（`deploy/` 目录），不动上游代码。

## 与 0.1.2-alpha.5 适配层的差异（迁移要点）

| 项 | 0.1.2-alpha.5 | 0.1.5-rc.2 |
|---|---|---|
| 会话落盘 | `session.jsonl.zstd` | **`session.v3.jsonl.zstd`**（格式 v3，版本号进文件名）→ 按固定文件名扫描的工具必须同步放宽 |
| native 组件 | 无 `native/` 子系统 | 新增 `native/system`：会话租约 `flock` + 沙箱 **`landlock-run`**。`build:native-system` 自带 `--host-addon-only`，**只编 flock**；Linux 上不额外编 `landlock-run` 会导致容器内没有任何沙箱，`workspace-exec` 下**所有 bash 调用直接失败** |
| Agent Teams | 需自行 vendor 官方包 | 官方已发布 `@deepseek-ai/dsh-experimental-agent-team-profile` 与 `-web-profile`，直接作为 profile bundle 引用即可，并带来浏览器端团队面板 |
| `record-browser-gif` | — | 是**官方 skills**（非自研），本轮改用官方新版（Playwright 录屏 + `gh --attach`） |
| `dsh-doc-standards` / `dsh-doc-site-sync` | 曾存在 | 上游已并入单个 `dsh-doc`，旧名应删除 |

## 运行

```bash
# 1) 依赖（在检出根目录）
pnpm install --frozen-lockfile

# 2) profile 依赖（plugins 以 file: 引用本仓库 deploy 目录）
cd deploy/omgwow-dsh/instance-8893/profile 2>/dev/null || cd deploy/omgwow-dsh/profile
pnpm install

# 3) 凭证注入（固定目录，只读）
export OWTR_DSH_KEY=$(cat <凭证目录>/tokenrouter.key)
export DEEPSEEK_API_KEY=$(cat <凭证目录>/deepseek.key)

# 4) 启动（回环绑定）
DSH_HOME=<你的 dsh-home> bash deploy/omgwow-dsh/launcher/start.sh
```

容器形态见 [`instance-8893/README.md`](instance-8893/README.md)。

## 已知问题（0.1.5 实测）

- **`dsh-outline@0.1.6`（该插件最新版）在 0.1.5 上会崩**：`TypeError: snapshot.nodes is not iterable`
  at `buildOutlineItems` —— 新版本会话快照不再提供 `nodes`。失败被 slot 边界兜住，
  应用照常可用，但大纲功能静默失效。
- `dsh-mem-watch` / `dsh-service-hub` 的控件注册在 `conversation.composer.dock`，该插槽是 **session 作用域**：
  会话有内容时正常显示，停在欢迎态（无会话）时不显示。属上游设计，非缺陷。
- 细节与证据见 [docs/0.1.5-兼容性报告.md](docs/0.1.5-兼容性报告.md)。

## 约定

- 凭证统一放固定目录（skills 内已参数化），任何 key 不得入库。
- 自研 skills 通过 `DSH_SKILLS_DIR`、`DSH_SERVICE_HUB_CLI`、`DSH_SERVICE_HUB_DIR`
  等环境变量定位工具，不要写死某台机器的绝对路径。
- 改了 `packages/*/src`（含未提交补丁）后**必须重建部署产物**：运行时经
  `tsconfig.base.json` 的 paths 直接加载 `packages/*/src`，只更新 `lib/` 或只跑
  `git archive` 导出的树都会导致实际运行的仍是旧代码。
