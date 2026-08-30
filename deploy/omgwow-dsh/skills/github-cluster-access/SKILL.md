---
name: github-cluster-access
description: GitHub 仓库默认走已注册 SSH key；Kubernetes 集群操作使用固定 kubeconfig（/Users/lbc/Documents/dsh-credentials/kubeconfig.yaml，四个逻辑集群 chengdu/weihai/liaoning/jiaqi-b300）；用户说"登录某集群/机器"时扫描 ~/.ssh/config 的 Host 并用别名连接。Use for GitHub clone/fetch/pull/push、kubectl、集群登录与 SSH 机器访问。
---

# GitHub 与集群访问（dsh 版）

本 Skill 处理三类访问：GitHub SSH、固定 kubeconfig 的 Kubernetes 集群、`~/.ssh/config` 的 SSH 机器。

## 不变量

- GitHub 仓库传输默认走 SSH。假定公钥已注册到 GitHub；不要先问 token，也不要主动执行 `gh auth login`。
- 集群操作固定使用 `/Users/lbc/Documents/dsh-credentials/kubeconfig.yaml`（2026-08-21 从 Downloads 一次性搬移，不再扫描 Downloads）。
- 四个逻辑集群映射：`chengdu`→`chengdu-h100`、`weihai`→`weihai-h100`、`liaoning`→`liaoning-h100`、`jiaqi-b300`→`jq-b300`（别名 `jiaqi`、`jq-b300` 均指 jiaqi-b300）。
- 始终给 `kubectl` 显式传入 kubeconfig 和 context；不要复制或合并到 `~/.kube/config`，不要改 `current-context`。
- 用户说"登录某集群/机器"时：先运行 `ssh-hosts` 扫描 `~/.ssh/config`，用匹配的 Host 别名做 `ssh-check <host>` 后连接；不要凭猜写 IP。
- 不要输出 kubeconfig 原文、token、client key、certificate data、SSH 私钥。
- 认证失败立即停止并报告非敏感摘要，让用户处理；不要自动生成 SSH key、不要关 host-key 校验、不要回退 HTTPS/PAT。

## 辅助脚本

```text
/Users/lbc/Documents/dsh-v2/dsh-home/skills/github-cluster-access/scripts/access.py
```

常用命令：

```bash
A=/Users/lbc/Documents/dsh-v2/dsh-home/skills/github-cluster-access/scripts/access.py

python3 $A github-check                 # 验证 GitHub SSH（成功文本含 successfully authenticated，退出码 1 不代表失败）
python3 $A contexts --json              # 显示固定 kubeconfig 与四个逻辑集群映射
python3 $A cluster-check all            # 对四个集群执行只读连通性检查
python3 $A kubectl chengdu -- get nodes # 通过固定 kubeconfig + 显式 context 执行 kubectl
python3 $A ssh-hosts                    # 扫描 ~/.ssh/config 的全部 Host 别名
python3 $A ssh-check <跳板机别名>  # 测试某 Host 的 BatchMode SSH 可达性
```

## GitHub 工作流

1. 新 clone 使用 `git@github.com:OWNER/REPO.git`。
2. 已有仓库若 remote 是 HTTPS 且指向 github.com，首次网络操作前改成等价 SSH URL。
3. 遇到认证问题时先 `github-check`；`ssh -T git@github.com` 通常返回状态 1 但文本含 `successfully authenticated`，不要单独判失败。
4. SSH 只负责 Git transport；issue/PR/API 操作用已认证的 `gh`，若 `gh` 无凭据则停止让用户登录。

## 集群工作流

1. 用户用简称时经 `context`/脚本映射到真实 context（`jiaqi-b300` ↔ `jq-b300`）。
2. 普通操作一律 `access.py kubectl <cluster> -- ...`。
3. 首次访问先做只读检查（`cluster-check <cluster>` 或 `all`）。
4. 登录只是前置条件，不代表可以执行破坏性操作；只做用户要求的操作。

## SSH 机器工作流（新增）

1. 用户说"登录某个集群 / 连一下某台机器 / SSH 到 xxx"：先 `ssh-hosts` 列出别名，把用户口中的名字与 Host 别名对齐（支持模糊匹配，列出候选让用户确认歧义）。
2. 连接前可先 `ssh-check <host>` 验证可达；然后 `ssh <host>` 执行用户要求的工作。
3. 找不到匹配别名时，向用户报告现有 Host 列表，不要自行编辑 ~/.ssh/config。

以下情况立即停止并报告非敏感错误摘要：找不到 kubeconfig、缺少四个预期集群之一、证书/凭据过期、Unauthorized/Forbidden、TLS/host 错误、网络超时、SSH 认证失败。
