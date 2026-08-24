# headless-agent

[English](README.md) | 中文

本目录负责 headless coding agent（智能体）的回放和真实模型测试组装：DeepSeek V4 + 本地 bash 与文件系统工具 + subagent 委托 + 工作流与全新 agent Ralph 迭代 + `todo_write` + JSONL 持久化。本目录显式挂载共享 agent 主干、一个根 agent、持久化和检查点策略；它不是第二个产品入口。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm dsh --profile headless "fix the failing test in this workspace"
```

产品命令是 [`dsh --profile headless`](../../apps/cli/README.zh.md)：它接受一项非空任务，创建并持久化新会话，打印最终 assistant 文本，然后退出。

快照套件通过 [`tests/fixtures/headless-driver.ts`](tests/fixtures/headless-driver.ts) 运行本目录的配置。这个未导出且仅供测试使用的进程会在结果记录之前，以 JSONL 发出规范会话事件。该事件流属于测试基础设施，不是受支持的 CLI（命令行界面）输出格式。子会话只通过父会话的工具事件和结果对外显示。

## E2B POC overlay

[`e2b.cordis.yml`](e2b.cordis.yml) 使用一个共享 E2B 沙箱替换本地文件系统与子进程提供方，同时保留 `dsh-bash-local` 和相同的面向模型工具。请在 git 忽略的根目录 `.env` 中，将 `E2B_API_KEY` 与 `DEEPSEEK_API_KEY` 放在一起，然后运行凭据门控的实机组合测试；它在同一个沙箱中驱动 FS、Bash、PTY 和 LSP，并证明沙箱最终被删除：

```sh
pnpm exec vitest run --config vitest.e2e.config.ts packages/e2b/e2b/tests/composition.e2e.ts
```

该 overlay 会在沙箱中创建相同的绝对 cwd，但不会上传或挂载宿主工作区。文件与 Bash 变更只存在于 E2B；Cordis、模型调用、agent／会话状态、会话日志、skill（技能）和 SDK 缓冲仍在宿主上。该组合会在超时和资源释放时终止其沙箱。它是提供方组合 POC，而不是完整 harness 迁移或工作区同步功能。

## 面向聚合网关的多模态

[`tokenrouter-vision.cordis.yml`](tokenrouter-vision.cordis.yml) 让 agent 经 pi-ai 接入一个用单个 OpenAI 兼容端点复用多家供应方的网关，从而让图像抵达识图模型，而不是走直连 DeepSeek 适配器：

```sh
DSH_TOKENROUTER_API_KEY=… node --import tsx/esm tests/fixtures/headless-driver.ts \
  tokenrouter-vision.cordis.yml "read_image ./shot.png and describe it"
```

由于网关把供应方藏在 URL 之后，pi-ai 本会推断的每一项线缆事实都改为显式声明，每个模型也各自声明其 `input` 模态。这些列表记录的是实测行为：有若干路由会接受图像部分、返回 HTTP 200，并仅凭文本作答。`deepseek-v3.2` 正因如此被声明为 `[text]`，这会让 `read_image` 提前拒绝，而不是让模型去描述它从未收到的图像。理由由该 [Agent Note](../../.agents/notes/implemented/feature/2026-08-20-tokenrouter-declared-modality.zh.md) 记录。

## 高级配置

[`advanced.cordis.yml`](advanced.cordis.yml) 在测试组装中添加 Code Mode 和 Cordis 工具。
