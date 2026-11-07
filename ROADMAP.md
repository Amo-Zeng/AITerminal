# 共建路线图 / Community roadmap

AITerminal 已开放桌面终端、AI 执行链和插件宿主源码。欢迎将真实需求变成小而完整的贡献；以下是协作方向，不是交付日期承诺。提出方案时请给出可重现问题、实现边界和验收方法。

| 方向 / Area | 可以贡献什么 / Opportunities | 验收关注点 / Evidence |
| --- | --- | --- |
| 插件入门 / Plugin onboarding | 英文 API 示例、小型离线插件、错误诊断说明 / English examples, small offline plugins, actionable diagnostics | 从干净目录生成、加载、运行、打包；无 Key 可复现 / Works from a clean checkout |
| 运维工具 / Operations plugins | Kubernetes、日志分析、备份校验、交互式 CLI 助手 / Kubernetes, log analysis, backup verification, CLI helpers | 明确目标与权限；只读优先；写操作审计、取消和清理 / Explicit targets, audited writes, cancellation |
| 模型与 MCP / Models and MCP | 协议适配、MCP OAuth 设计、Schema 兼容性、真实服务样例 / Protocol adapters, OAuth design, schema compatibility | 不向插件暴露宿主 Key；失败诊断、超时与标签隔离 / Credential boundaries, failures and isolation |
| 插件分发 / Distribution | 社区插件索引、来源与兼容性展示、更新体验 / Community catalogs, provenance, compatibility and updates | 内容摘要、可审查源码、更新失败保留旧版 / Integrity and recoverable updates |
| 插件界面 / Plugin UI | 更清晰的任务进度、面板可访问性、配置说明 / Progress, panel accessibility and configuration help | 纯文本/声明式渲染、键盘操作、多标签测试 / Safe rendering, keyboard and tab behavior |
| 终端可靠性 / Terminal reliability | Windows WSL、SSH 重连、tmux、Unicode、resize 与 Codex 交互回归 / WSL, SSH, tmux, Unicode, resize and CLI regressions | 真实 PTY、屏幕或输入证据；关闭标签后清理 / Real PTY evidence and cleanup |
| 发布与架构 / Releases and architecture | 安装体验、签名方案、模块拆分、可复现构建 / Installation, signing, modularity and reproducible builds | 三平台启动门禁、源包一致、可定位的失败 / Three-platform startup and traceability |

适合作为首次贡献：补充一个 SDK 英文示例；为运维闯关增加一题并验证计分；给已有插件完善参数解释；为一个已复现的终端问题补充回归步骤。涉及执行权限、持久化状态、插件市场或新 UI 协议的变更，请先讨论设计。

Good first contributions include an SDK example, a tested Ops Quest puzzle, clearer plugin parameter descriptions, or a reproducible terminal regression. Discuss changes to execution permissions, persistent state, catalogs or UI protocols before implementation.

在 [Discussions](https://github.com/Amo-Zeng/AITerminal/discussions) 交流想法，用 [插件提案](https://github.com/Amo-Zeng/AITerminal/issues/new?template=plugin_proposal.yml) 描述新插件，用 [Issues](https://github.com/Amo-Zeng/AITerminal/issues) 跟踪具体问题。开始代码贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
