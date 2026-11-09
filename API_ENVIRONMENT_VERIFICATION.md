# API 与终端环境升级验证

日期：2026-11-07。目标：保留 Chat Completions，并完整支持 Responses、Messages；AI 命令、交互程序和插件跟随所属标签的终端系统，修复 Windows WSL / PowerShell 分裂。验收包括协议往返、工具关联、取消、终端身份、工作目录与真实 PTY 行为。

## 实现与边界

- `lib/aiProtocol.js` 统一 URL、认证对应的载荷和响应转换；新协议流必须完整结束才能执行工具，先验证所有工具参数再执行。
- `lib/localEnvironment.js` 记录可见终端的系统、Shell、WSL 发行版及进程；AI/插件复用此描述，不按 Electron 的宿主平台猜测执行环境。目录查询不向可见终端输入命令。
- 本地接管读取当前终端目录；接管后独立维护 AI 的 cwd。终端重启、关闭或切换后，原绑定失效；异步确认之后重新核验身份。独立进程不共享临时变量或 tmux pane 状态。
- Windows 的 MCP stdio 服务器仍按明确配置在宿主启动，与终端执行服务分开。

## 已执行

| 检查 | 结果 |
| --- | --- |
| `npm test` | 163 项：162 通过、1 项按平台跳过、0 失败；随后新增的凭据隔离用例与接管用例共 5 项通过 |
| `npm run smoke:ai-protocols` | 真实 Electron 渲染器 → IPC → 本机 HTTP 服务，三种格式均返回解析后的文本 |
| `npm run smoke:config-modal` | 格式选择、保存、恢复、连接测试传参，以及原 Webhook 控件通过 |
| `npm run smoke:plugin-runtime` | 真实 Electron/Cordis：标签隔离、模型插件、宠物事件、闯关 UI、Git 时间线与清理通过 |
| `npm run smoke:local-environment` | Linux Electron：可见终端 cd、AI 命令、插件文件读写、交互输入/resize 通过 |
| Windows Node 执行 `scripts/localEnvironmentSmoke.js` | 实际启动 WSL Ubuntu，确认系统为 Linux、Shell 为 `/bin/bash`，上述目录/执行/交互检查通过 |
| Windows Node 定向测试 | 协议、环境和接管/插件路由 25 项：22 通过、3 项 Unix 专属检查跳过 |
| `npm run doctor`、`npm run security:scan`、`git diff --check` | 通过 |

协议测试使用真实本机 HTTP 服务和固定 fixture，不使用真实模型 Key，也不产生 API 费用。官方文档站点当时返回 403/无内容页面，因此请求和事件字段对照官方 SDK 的 Responses、Messages 与 MessageStream 类型/实现核验，链接见 [API 配置](AI_PROVIDERS.md)。未声称对所有服务商进行在线付费模型验证。

Windows 本机验证使用 Windows Node/ConPTY 启动真实 WSL；Linux 验证使用 Electron。macOS 的 `/private/tmp` 路径别名已纳入 smoke 判定；macOS 与完整安装包验证由三平台 GitHub Actions 执行，不能用 Linux 结果代替。

首轮三平台 CI 的 Linux/macOS 构建通过；Windows 插件 smoke 暴露旧测试错误地假定没有活动 WSL 后端也能读取终端上下文。本地以立即退出的 Shell 复现后，测试改为显式验证后端关闭时拒绝读取/执行，而配置、模型插件和离线宠物/闯关继续工作；没有放宽产品的目标绑定检查。可用 `npm run smoke:plugin-runtime -- --without-terminal` 单独复现无后端检查。

最终源码 `23c65b86f5f180f62bbbefe9d6bb1e85e826f095` 的 [三平台构建 #42358378738](https://github.com/Amo-Zeng/AITerminal/actions/runs/42358378738) 已全部成功：Windows x64、Linux x64、macOS arm64。包含测试、API IPC、插件/通知检查、打包源码一致性和安装包启动校验。安装包从该 Actions 运行的 Artifacts 下载；此更新尚未替换已有 `v1.5.1` Release 的正式下载附件。

## 社区 PR

[PR #8](https://github.com/Amo-Zeng/AITerminal/pull/8) 已审查并合并为 `e555d0d`，保留贡献者提交。合并前修复离线示例依赖活动终端、未确认清空导致面板丢内容、状态容量上界与无差别重试，并增加真实插件进程测试。PR 独立验证为 146 项测试（145 通过、1 跳过），TypeScript 严格检查、开发目录验证、打包及密钥扫描通过。

PR 只完成了 [#6](https://github.com/Amo-Zeng/AITerminal/issues/6) 的状态示例，关联任务继续开放；README 中英文版加入 [linux.do](https://linux.do/) 社区链接并保留原有演示图。
