# 文档索引 / Documentation

从 [README](README.md) / [English README](README_en.md) 了解项目和演示，再按使用场景阅读。安装排障、联系方式和已有功能说明属于持续维护内容；调整 README 时应保留可发现的入口。

| 你想做什么 / Goal | 文档 / Guide |
| --- | --- |
| 下载、首次运行、macOS“已损坏”、WSL、Linux FUSE / Install and troubleshoot | [安装指南 / Installation](INSTALLATION.md) |
| AI 问答、命令、文件传输、快捷键、外观、多会话工作区 / Everyday use | [使用手册](USER_GUIDE.md) · [English user guide](USER_GUIDE_en.md) |
| 配置 Chat Completions、Responses、Messages / Configure a model API | [模型 API / AI providers](AI_PROVIDERS.md) |
| AI 管理本地与远程、交互式 CLI、目标环境 / AI takeover and interactive CLI | [AI 接管](AI_TAKEOVER_MODE_README.md) |
| 配置任务完成、程序停止、输出匹配通知 / Task and terminal notifications | [Webhook](WEBHOOKS.md) |
| 安装、配置、启停和分发插件 / Use plugins and catalogs | [插件使用](PLUGINS.md) |
| 写插件、接入 MCP、适配 DSH/Cordis / Develop plugins and integrations | [SDK](PLUGIN_SDK.md) · [English quickstart](PLUGIN_QUICKSTART.md) · [架构 / Architecture](PLUGIN_ARCHITECTURE.md) |
| 找一个可运行的代码示例 / Runnable examples | [Tab Notes](examples/tab-notes/) · [Log Inspector](examples/log-inspector/) · [内置示例 / Bundled plugins](plugins/) |
| 参与贡献、选择共建方向 / Contribute | [贡献指南 / Contributing](CONTRIBUTING.md) · [路线图 / Roadmap](ROADMAP.md) |
| 使用原生分屏、保存布局和固定插件面板 / Sessions, splits and workspaces | [中文操作](USER_GUIDE.md#多会话工作区) · [English](USER_GUIDE_en.md#multi-session-workspaces) · [最初评估 / Assessment](HEXHUB_ASSESSMENT.md) |
| 构建、自动发布与版本变化 / Build and release | [发布指南 / Releasing](RELEASING.md) · [变更日志 / Changelog](CHANGELOG.md) |
| 联系作者、反馈问题 / Contact and support | [中文](README.md#联系与反馈) · [English](README_en.md#contact-and-support) |
| 漏洞、许可证与社区规范 / Security, licensing and conduct | [安全政策](SECURITY.md) · [Apache-2.0](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md) · [行为准则](CODE_OF_CONDUCT.md) |

## 验证记录 / Verification records

这些文件记录特定版本的验证范围，不代替当前使用指南。

- [1.7.0 多会话工作区与界面](WORKSPACE_VERIFICATION.md)
- [文档恢复与 PR #9 审查](DOCUMENTATION_RESTORATION.md)
- [API 与终端环境](API_ENVIRONMENT_VERIFICATION.md)
- [插件系统](PLUGIN_VALIDATION.md) · [通知系统](WEBHOOK_VALIDATION.md)
- [自动发布](RELEASE_AUTOMATION_VERIFICATION.md) · [开源检查](OPEN_SOURCE_AUDIT.md)

## 维护约定 / Maintenance

新增或修改功能时，同步入口说明、详细步骤、适用平台及验证范围。中文和英文 README 中的安装命令、联系方式、演示与功能入口应保持对应；历史 GIF 使用固定提交地址。已失效的行为要明确更正，不能用删去说明代替修复或标注限制。

Keep both READMEs aligned on installation, contacts, demos and feature entry points. Update the relevant guide when behavior changes. Preserve useful historical instructions and attribution, while correcting obsolete platform assumptions and unsupported claims.
