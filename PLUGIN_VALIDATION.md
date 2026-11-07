# 插件框架实施与验证

版本：1.5.0，2026-11-07。实施目标与验收标准见 [架构方案](PLUGIN_ARCHITECTURE.md)。

## 趣味插件增量（未发布）

目标：内置可直接试玩的终端宠物、运维闯关和 Git 时光机，保持标签隔离，离线玩法无需模型，Git 只读且故事请求不具备工具执行能力。验收还包括插件宿主回收后进度保留、重复计分防护、真实 Git 与真实 Electron 界面。

实现：内置目录由 7 个增至 10 个；API 1.1 新增 32 KiB 会话状态、revision 并发校验、版本与实例归属检查，以及 `models.request({allowTools:false})`。宠物与闯关不声明终端、模型或文件权限；Git 参数经宿主转义与审计，模型输入只含有界的提交 ID/日期/标题。Windows PowerShell 执行服务显式使用 UTF-8，匹配宿主输出解码。

已完成验证：

- `npm test` **133 项通过，0 失败**。新覆盖真实 Cordis 中的宠物事件去重、8 题计分/提示/徽章、同名标签隔离、宿主重启、状态大小与并发冲突、旧版本迟到写入拒绝，以及主进程在接管模式下禁用纯文本请求工具。
- 本地真实 Git 仓库：空仓库、游离 HEAD、已跟踪变更、中文提交、引号/空格/命令替换样式路径、失败诊断、模型失败后清除旧故事、读取前后工作区一致性均通过。模拟 SSH 通道执行真实 shell/Git，验证远端路径与目标绑定；未连接用户真实远程服务器。
- `npm run smoke:plugin-runtime` 通过真实 Electron utilityProcess、插件安装/启用、宠物状态及纯文本渲染、鼠标点击闯关表单、双标签进度隔离，以及 Linux 上的真实 Git + 本机模拟模型服务。没有使用用户 key 或请求付费模型。
- `npm run smoke:plugins` 通过既有 v1 插件中心/UI/IPC 回归；凭据扫描通过。最后 SDK 模板与执行服务的 10 项相关回归通过，语法检查通过。
- 界面截图已检查：`release/bundled-plugins-verification/{terminal-pet,ops-quest,git-time-machine}.png`。结果面板按清单顺序显示在工具表单上方。
- 本地 Linux 产物 `release/bundled-plugins-verified/linux-unpacked/aiterminal` 构建成功，48 个运行文件与源码逐字节一致；实际 ASAR 中 renderer、PTY、Cordis 插件宿主启动与退出通过，闯关完成后重启插件进程仍保留 10 分。日志副本位于 `release/bundled-plugins-verification/`。

当前验证环境是 WSL/Linux，Windows/macOS 未针对这次增量重新运行 CI；Windows 的真实 PowerShell Git 回归已纳入现有 `npm test`，不将本地 Linux 结果声称为 Windows 实测。原三平台安装包仍是下文记录的历史构建，**不包含这次新插件**。宠物与闯关进度仅在应用会话内保留，停用/更新/关闭标签或退出应用会清空。

## 已实施

- Cordis 4.0.0-rc.12 + Plugin API 1.0.0 + 按标签隔离的 Electron utilityProcess；工具、事件、模型和任务资源均有生命周期。
- v2 自包含 JSON 文件集，平台/API/依赖校验，摘要锁定快照、初始化后切换、历史版本恢复；兼容 v1 声明式插件。
- 用户/连接/标签配置、声明式表单和面板、任务进度与取消、插件源、开发目录导入。
- 原生模型工具调用与文本兼容路由、动态指引、模型策略、标准 MCP 工具及资源、Webhook 和依赖服务。
- Docker 工作台、任务通知/记录、模型策略三个代码示例；开发脚手架、包生成器和 SDK 类型。

## 验证进度

- 真实 Node 子进程：Cordis 启停、同名标签隔离、取消、异常恢复已通过。
- 真实 Electron：utilityProcess 启动、配置/面板归属、模型策略与温度零值、停用隔离已通过。
- 标准 MCP stdio：协议初始化、工具参数验证、工具执行、资源列表与读取已通过。
- 执行服务：真实本地输出、Unicode/参数转义、取消进程、迟到 SSH 通道关闭、高危参数审计已通过。
- 更新/依赖/配置、开发脚手架、历史配置恢复及安装包源码校验已通过。最终发布预检 `npm test` 为 **125 项通过、0 失败**，包含 Windows 配置指引与模型请求期间目标/启用代次变化回归。
- 源码 `89dc71a` 的 Linux 本地产物已验证 42 个运行时文件与源码逐字节一致，并通过 renderer、PTY、ASAR 中 Cordis/utilityProcess 启动及退出检查。
- 首轮三平台 CI：[42281009230](https://github.com/Amo-Zeng/AITerminal-build/actions/runs/42281009230)，macOS/Linux 成功；Windows 的配置指引回归发现 WSL 退出错误地使不访问终端的指引失效。
- 修复：任务保留原始目标快照，只有读取终端上下文或操作终端/文件后才依赖连接存活；标签与插件实例归属始终校验。原生模型工具同时绑定发出模型请求时的连接与插件启用代次，防止等待回复期间换连接/更新插件后执行过时调用。
- 最终源码：`2548ad270d4e68232b4f2174fb3f767ccf1f6393`。三平台 CI：[42283095613](https://github.com/Amo-Zeng/AITerminal-build/actions/runs/42283095613)，Windows x64、Linux x64、macOS **全部成功**，每个平台均包含真实插件运行时、源码一致性与打包后启动门禁。
- 本地最终产物：`release/plugin-runtime-1.5-verified/linux-unpacked/aiterminal`。`verifyPackageSource.js` 验证 42 个运行文件及元数据/依赖一致，`packageStartupSmoke.js` 验证 renderer、PTY、实际 ASAR 中插件宿主的启动与退出。CI 步骤状态保存在 `release/plugin-runtime-1.5-verified/ci-verification.json`。
- UI/终端回归：v1 插件中心、v2 代码宿主与模型配置隔离、配置窗口、渲染隔离、复制粘贴，以及真实 tmux 双窗格、Unicode、resize、鼠标、滚轮、标签隔离均通过。界面截图为 `release/plugin-runtime-final/plugin-center.png`。
- 凭据扫描通过；依赖审计无 high/critical，仍有原有的 KaTeX 低危与构建依赖中危共 7 项。本次新增直接依赖未新增生产 high/critical 项；未用强制降级构建器的方式掩盖现有审计项。

## 三平台安装包

GitHub Actions 产物均来自上面的同一源码提交，私有仓库访问需要登录：

| 平台 | 产物入口 | 内容 |
| --- | --- | --- |
| Windows x64 | [构建产物](https://github.com/Amo-Zeng/AITerminal-build/actions/runs/42283095613/artifacts/13536552062) | NSIS `.exe`，默认可见终端 WSL Ubuntu |
| Linux x64 | [构建产物](https://github.com/Amo-Zeng/AITerminal-build/actions/runs/42283095613/artifacts/13535249825) | `.AppImage` |
| macOS | [构建产物](https://github.com/Amo-Zeng/AITerminal-build/actions/runs/42283095613/artifacts/13536611218) | `.dmg` |

每组产物附带 SHA256SUMS 和 CycloneDX SBOM。GitHub 保留期为 14 天；当前属于私有构建产物，尚未发布公开 Release。Windows CI 验证了应用和插件宿主启动；CI 中未安装用户的 WSL Ubuntu 发行版，其默认选择由包门禁检查，实际 WSL 交互还需要目标电脑具备该发行版。

三平台产物已下载到 `release/github-actions/2548ad270d4e-42283095613/`，分别位于 `windows-x64/`、`linux-x64/` 和 `macos/`。已核对 GitHub 提供的 ZIP 摘要及各安装包的 SHA256SUMS，结果记录在该目录的 `verification.json`；macOS 产物为 Apple Silicon arm64。

## 实现边界

独立进程用于故障与模块状态隔离，代码插件仍具有宿主用户权限。MCP HTTP 当前支持无 OAuth 配置的 Streamable HTTP，工具 Schema 采用受支持子集。模型宿主代理复用已有 OpenAI-compatible 连接；任意网页 UI、原生依赖包及强权限沙箱未纳入本次运行模式。
