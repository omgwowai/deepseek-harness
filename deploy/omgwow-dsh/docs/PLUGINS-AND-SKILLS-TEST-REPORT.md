# 插件与 Skills 测试报告（最终结论版）

适用范围：**omgwow × DeepSeek Harness 适配层**（基于 deepseek-harness v0.1.1-rc.1）。
本报告只列结论：装了哪些插件、每个插件按什么规格测试、最终结果。不含过程信息。

## 一、插件清单与测试结论

### 自研插件

| 插件 | 作用 | 规格测试项 | 结果 |
|---|---|---|---|
| dsh-tokenrouter-cost | 按 Token Router 价格（Input/Cached/CachedWrite/Output 四档，CNY/1M）计费；账本落盘；界面展示今日费用与用量（余额暂不展示） | 计费数学（逐次调用复算分毫不差）；今日/用量 dock 与侧边栏渲染；Typert RPC 全链路；invariant 伴生（账本一致性自检 0 违规） | ✅ 全部通过 |

### 社区插件（已启用）

| 插件 | 规格测试项 | 结果 |
|---|---|---|
| dshmarket | 设置区入口；目录渲染（77 页）；搜索过滤（真实键盘输入）；版本/升级/已安装/备份与恢复页 | ✅ |
| dsh-better-sidebar | 五标签点开/关闭循环×3；文件树逐级展开与滚动；多类型文件预览（md/json/csv/png/源码）；编辑器多标签；终端命令行执行（pwd/echo/ls/python/for 循环）；SCM（非 git 目录正确提示；git 状态绑定工作区根）；浏览器标签（外网页面加载成功；回环地址拦截为安全设计）；+ 菜单新建终端；设置页 | ✅ |
| dsh-outline | 30 轮多轮对话后大纲树收录全部标题节点（185 节点）；搜索过滤；收藏/折叠/复制控件 | ✅ |
| dsh-genui | 40 种组件逐一单发测试：布局 7 种、展示 18 种（含四色 badge/callout）、图表 5 种（bars/line/donut/多序列/plot 滑块）、交互 11 种（quiz 判题/交卷判分/tabs/accordion/button action 回环）、mermaid、scene3d（WebGL） | ✅ 40/40 |
| dsh-visualize | 工具调用；交互卡片渲染 | ✅ |
| dsh-ui-hub | 管家面板（开关/定位/避让/排布/恢复默认）；插件控件枚举；实际开关切换与恢复 | ✅ |
| dsh-agent-teams | /agent-teams 命令入口；三人团队 + 3 依赖任务全流程；活动面板任务状态与依赖关系显示；成员子代理可续接 | ✅ |

## 二、模型能力测试结论

Token Router 7 模型 + DeepSeek 官方 3 模型。

| 模型 | 文字（短指令回复） | 读图（含复杂图） | 计费 |
|---|---|---|---|
| claude-fable-5 | ✅ | ✅（含基准图/架构图/流程图/逻辑图/照片/图表/表格 7 场景） | ✅ |
| claude-opus-5 | ✅ | ✅（同上 7 场景） | ✅ |
| gpt-5.6-sol | ✅ | ✅（mergeUserMessages 修复后） | ✅ |
| kimi-k3 | ✅ | ✅（mergeUserMessages 修复后） | ✅ |
| deepseek-v4-flash | ✅ | 声明仅 text，附件正确拒绝 | ✅ |
| deepseek-v4-pro | ✅ | 声明仅 text，附件正确拒绝 | ✅ |
| glm-5.3 | ✅ | 声明仅 text，附件正确拒绝 | ✅ |
| DeepSeek-V4-Flash-Vision-Exp（官方） | ✅ | ✅（7 场景全过，首 token 0.7s） | 不计费（未入价格表） |
| DeepSeek-V4-Flash（官方） | ✅ | — | ✅ |
| DeepSeek-V4-Pro（官方） | ✅ | — | ✅ |

复杂读图 7 场景（地面真值经 macOS Vision OCR / 已知生成内容校验）：
基准图表数值（53.4/60.6）、架构映射图组件识别、五阶段流程图、哲学逻辑图规则名、
真实照片场景描述、销售柱状图数值（160/120）、库存表数值（45/常州）——
4 个视觉模型 × 7 场景 = 28/28 通过。

## 三、Skills 测试结论（15/15 触发成功）

| Skill | 归属 | 触发测试 | 结果 |
|---|---|---|---|
| dsh-code-review | deepseek 自带 | 实际审查 llm-pi-ai/context.ts | ✅ |
| dsh-doc-standards | deepseek 自带 | 评估测试报告文档规范 | ✅ |
| dsh-doc-site-sync | deepseek 自带 | 文档站同步检查（只读） | ✅ |
| dsh-find-simplifications | deepseek 自带 | 扫描 llm-pi-ai 简化候选 | ✅ |
| dsh-merging-stacked-prs | deepseek 自带 | PR 栈检查（空栈结论） | ✅ |
| dsh-pre-push-checks | deepseek 自带 | 最小检查集选择 | ✅ |
| dsh-prose-standard | deepseek 自带 | README 文风评审 | ✅ |
| dsh-trim-cot-leakage | deepseek 自带 | 注释思维链泄漏检查 | ✅ |
| dsh-archive-agent-notes | deepseek 自带 | Agent Notes 归档审查 | ✅ |
| feishu | 自研 | 飞书消息实际发送 | ✅ |
| github-cluster-access | 自研 | kubectl 只读列集群 | ✅ |
| local-service-hub | 自研 | 服务登记→移除零残留 | ✅ |
| session-cloud-sync | 自研 | 同步状态查询 | ✅ |
| record-browser-gif | 自研 | 触发正常（录制需会话沙箱高权限，Chromium 缓存目录） | ✅ |
| visualize | 插件自带 | 工具调用 + 图表渲染 | ✅ |

每个 skill 均核验了会话日志中的真实 `skill` 工具调用记录（非仅看回复）。

## 四、本地代码修改（相对 v0.1.1-rc.1）

| 修改 | 内容 |
|---|---|
| 计费价格数据 | 当前为**暂时方案**：全量模型价格以 JSON 快照（prices.json）注入，未来切换为价格 API 自动获取（见 README） |
| packages/llm/llm-pi-ai（4 文件） | 新增 provider 级 `mergeUserMessages` 配置：修复 Token Router 腾讯链路在连续 user 消息合并时丢弃图片导致的 gpt-5.6-sol / kimi-k3 读图失败；附单元测试 |
| deploy/omgwow-dsh/plugins/dsh-tokenrouter-cost | 自研计费插件，含 `./invariant` 伴生（官方 invariants 服务存在时注册；内置账本一致性自检兜底） |

## 五、已知限制（设计行为）

- record-browser-gif：录制需要会话沙箱可写 Chromium 缓存目录（更高权限模式）
- dsh-genui audio/video：需要同源可访问的媒体源 URL，缺失时显示「无法播放」错误态（属预期）
- dsh-better-sidebar SCM：git 状态绑定工作区根目录；浏览器标签按设计拦截回环地址
- 官方 DeepSeek 模型依赖 DEEPSEEK_API_KEY（见 CREDENTIALS.md）
