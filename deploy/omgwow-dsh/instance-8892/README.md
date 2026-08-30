# 8892 实例（dsh-v2）部署包

> 📖 凭证配置（哪些凭证让哪些 skills 生效）：见 [../docs/CREDENTIALS-INDEX.md](../docs/CREDENTIALS-INDEX.md)。

基于 omgwowh-my-dsh 适配层的完整实例配置：profile web（Token Router 7 模型 + host 层
16+1 skills + 侧栏不自动弹出）、4 个自研插件（rollout-transparent / tokenrouter-cost /
mem-watch / service-hub）、本地服务台 v2（含集群总览）、启动器与 Docker 打包脚本。

## 目录

- `profile/` — dsh profile（bundles 见 package.json；cordis.patch.yml 含 Token Router
  provider 与 host skill-filesystem 行；settings.yaml 含默认模型与侧栏偏好）
- `service-hub-v2/` — 本地服务台 v2（hub.py + CLI + 启动脚本，端口 6692）
- `tooling/` — start-dsh-v2.sh 启动器、Dockerfile、build-image.sh、docker-entry.sh
- 插件源码：`../plugins/`；skills：`../skills/`（安装到 `$DSH_HOME/skills` 或由
  `DSH_SKILLS_DIR` 指向）

## 启动

```bash
# 1. profile 依赖（在仓库检出内）
cd <checkout>/deploy/omgwow-dsh/instance-8892/profile && pnpm install

# 2. 凭证注入（固定目录，不入库）
export OWTR_DSH_KEY=$(cat <凭证目录>/tokenrouter.key)
export DEEPSEEK_API_KEY=$(cat <凭证目录>/deepseek.key)
export DSH_HOME=<你的 dsh-home>
export DSH_SKILLS_DIR=$DSH_HOME/skills   # 已含 16+1 skills

# 3. 启动
bash ../tooling/start-dsh-v2.sh   # 或按 tooling/ 里的 Docker 流程
```

## 已知约定

- 凭证统一放固定目录（skills 内已参数化），任何 key 不得入库。
- 服务台端口 6692，dsh web 端口 8892（`PORT` 可覆盖）。
- 插件改动后需重跑 profile 的 `pnpm install` 让 file: 副本刷新。
