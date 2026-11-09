# 参与 AITerminal / Contributing

欢迎一起建设 AI 运维终端与插件生态。中文和英文的 Issue、讨论及 PR 都欢迎；不要求拥有付费模型、私有构建库或真实生产服务器。

## 从哪里开始

- **插件**：开发一个实用工具、趣味面板、任务通知、模型适配器或 MCP 集成。先读 [插件使用](PLUGINS.md)、[SDK](PLUGIN_SDK.md) 与 [英文入门](PLUGIN_QUICKSTART.md)。
- **终端与可靠性**：帮助复现 Windows WSL、SSH、多标签、交互式 CLI、tmux 与 resize 问题。
- **文档与示例**：补充小型可运行插件、英文 API 示例、清晰的故障排查说明。

文档入口见 [文档索引](DOCUMENTATION.md)。调整首页时保留安装排障命令、联系方式、功能入口、原演示与贡献者致谢；较长说明可移动到使用手册并留下明确链接。行为或平台发生变化时同步中英文说明，不删除仍适用的操作步骤。
- **测试与发布**：改进可复现的回归测试、三平台验证及安装包可追溯性。

查看 [路线图](ROADMAP.md) 和 [help wanted](https://github.com/Amo-Zeng/AITerminal/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22)。新插件可提交 [插件提案](https://github.com/Amo-Zeng/AITerminal/issues/new?template=plugin_proposal.yml)；较大的 API 或架构变更请先在 Issue / [Discussions](https://github.com/Amo-Zeng/AITerminal/discussions) 描述问题、方案与验收条件，避免重复工作。

## 开发流程

1. Fork 公开仓库，在自己的功能分支开发。使用 Node.js 22+，在目标平台执行 `npm ci`。
2. `npm start` 启动应用。原生模块不可用时先运行 `npm run doctor`；不同平台不共用 `node_modules`。
3. 保持改动聚焦，修复行为问题时增加能复现根因的回归测试；文档、SDK、变更日志同步更新。
4. 执行下列适用检查，然后向 `Amo-Zeng/AITerminal:main` 提交 PR，说明问题、结果、验证及限制。

```bash
npm test
npm run security:scan
git diff --check
```

测试中的模型和 Webhook 使用本机测试服务，不需要真实 Key。不要提交用户凭据、终端敏感内容、`.env`、`node_modules`、打包产物或本地会话配置。普通配置与插件清单也不能存放秘密。

## 开发第一个插件

在项目根目录执行：

```bash
npm run plugin:dev -- new ../hello-aiterminal example.hello
npm run plugin:dev -- validate ../hello-aiterminal
npm run plugin:dev -- pack ../hello-aiterminal ../example.hello.aitplugin.json
```

打开“🧩 插件 → 加载开发目录”，选择目录，预览安装并在当前标签启用，运行问候工具。修改源码后重新导入；宿主执行的是经预览的不可变快照。在第二个标签验证状态与面板不串内容，再检查停用、取消和关闭标签后的清理。

插件约定：

- 清单声明工具输入 Schema、面板、能力、API 版本与依赖；只申请所需权限。优先通过宿主 SDK 操作终端、文件、模型与通知。
- 优先传递 `argv`，明确本地/SSH 目标与工作目录，不拼接未经校验的 Shell 参数。危险操作接受宿主审计，不能自行批准。
- 任务遵守 `ctx.signal`，用 `onDispose` / `effect` 清理资源。状态使用本标签 `ctx.state` 并处理 revision 冲突，不放在共享全局变量中。
- 凭据由宿主持有；需要模型只返回文本时使用 `allowTools: false`。离线例子应可在没有模型和服务器的情况下试玩。
- 插件代码有宿主用户权限，独立进程不等于系统沙箱。不要承诺清单权限能阻断任意 Node.js 代码。
- 第三方插件可维护在自己的仓库，通过 HTTPS 包/索引分发。提案或 PR 不代表自动进入内置目录；内置插件需要小体积、可维护源码、清晰许可与验证说明。

参考 [终端宠物](plugins/terminal-pet/)、[运维闯关](plugins/ops-quest/)、[Docker 工作台](plugins/docker-tools/) 和 [Git 时光机](plugins/git-time-machine/)。不访问终端的插件可以从终端宠物或闯关开始。

## 选择验证范围

| 改动 | 推荐检查 |
| --- | --- |
| 清单、包、插件 SDK / 生命周期 | `npm test`、`npm run smoke:plugins`、`npm run smoke:plugin-runtime` |
| 模型 API 协议、格式与工具调用 | `npm test`、`npm run smoke:ai-protocols`、`npm run smoke:config-modal` |
| 本地 AI / 插件执行环境和目录 | `npm run smoke:local-environment`；Windows 需已初始化的 WSL Ubuntu |
| Webhook、退出与输出匹配 | `npm run smoke:notifications`、`npm run smoke:config-modal` |
| 终端、剪贴板、尺寸和鼠标 | `npm run smoke:clipboard`、`npm run smoke:terminal`；Unix 安装 tmux 后运行 `npm run smoke:tmux` |
| `send`、常用命令、拖拽文件路径 | `npm test`、`npm run smoke:documented-flows`；Windows CI 验证真实 File 桥接，Shell 发送需 WSL |
| Markdown、IPC、凭据与配置 | 相关单测、`npm run smoke:renderer-security`、`npm run smoke:config-modal` |
| 原生依赖和打包 | 对应平台构建、`npm run verify:package-source`、`npm run smoke:package-startup`；Windows 加 `npm run verify:win-package` |

Renderer 测试需要 Chrome/Chromium，可设置 `CHROME_PATH`。无图形界面的 Linux 可使用 `xvfb-run -a npm run smoke:plugin-runtime` 等；通知集成测试需要 OpenSSL。WSL 功能需在装有 Ubuntu 的 Windows 上验证，Linux 测试不能代替这项验收。三平台 CI 运行完整门禁；PR 不会获得仓库秘密。

## 提交与评审

PR 应包含具体触发方式与改后行为、测试命令和结果、界面变化截图（先脱敏），并标明未经验证的平台或外部服务。新增插件请说明许可、权限、数据发送范围、取消/隔离行为与演示步骤。不要混入无关大规模格式化或生成物。

提交你有权贡献的内容。贡献默认按本仓库的 [Apache-2.0](LICENSE) 许可提供；第三方素材须注明来源与许可。参与者遵守 [行为准则](CODE_OF_CONDUCT.md)，漏洞按 [安全政策](SECURITY.md) 私下报告。

## For English-speaking contributors

Issues, discussions and pull requests in English are welcome. Fork this public repository, use Node.js 22+, run `npm ci`, develop on a focused branch and open a PR against `main`. No private repository access or real model credentials are needed.

Start with the [plugin quickstart](PLUGIN_QUICKSTART.md) and [roadmap](ROADMAP.md). Run `npm test`, `npm run security:scan` and the relevant smoke tests above. Explain the original problem, resulting behavior, test evidence and untested platforms. Plugin proposals should cover capabilities, data flow, licensing, cancellation and per-tab isolation. Contributions are provided under Apache-2.0; report vulnerabilities [privately](SECURITY.md).
