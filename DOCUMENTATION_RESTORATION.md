# 文档恢复与 PR #9 审查

日期：2026-11-09。目标是恢复旧 README 的有效安装经验、联系方式、功能说明和社区归属，并让文档中的操作能够在当前版本使用。验收包括中英文入口对应、历史演示可访问、文档链接有效，以及相关功能和 PR 的实际执行验证。

## 历史内容对照

对照公开历史提交 `d586885dc0a4c94cc4d5543da8052aaea4209949` 的中英文 README，按当前实现核实：

| 历史内容 | 恢复位置与处理 |
| --- | --- |
| macOS `sudo xattr -r -d com.apple.quarantine /Applications/AITerminal.app` | 两份 README 直接保留命令，[安装指南](INSTALLATION.md) 补校验、路径和排障步骤；不把所有“已损坏”提示都视为正常 |
| lorsque / Jasonvip 的安装反馈、linux.do | 中英文 README 致谢；保留 Sentinel 的社区经验并说明尚未复核具体工具版本 |
| 邮箱 `1019191262@qq.com`、QQ群 `1053768305` | 中英文 README、安装指南和使用手册均可找到 |
| AI 问答、`fix`、`analyze`、`cmd`、`send`、`/` | README 入口表与中英文使用手册，明确终端区域与底部 AI 输入框的区别 |
| SSH 密码/私钥、拖拽上传、`rfe`、`myls` | 手册给出操作位置、目标、路径和行为；原 README 引用的 `rfe.gif`、`myls.gif` 在公开历史中没有对应文件，改用可直接操作的示例 |
| 模型配置、自定义回答要求、流式分屏、公式、主题字体和光标 | 入口摘要、手册和模型协议文档互链；恢复 SSH 与 AI 流式演示 |
| 自动登录、登录后命令、配置方案、会话保存/加载 | 手册区分配置文件与运行状态，并明确导出不含凭据 |
| v1.0–1.2 的发布历史 | 迁入 CHANGELOG 的历史条目；不恢复已过时的 MIT 许可、未开源计划或“模型持续学习”等无实现支持的承诺 |

[文档索引](DOCUMENTATION.md) 按安装、使用、模型、接管、通知、插件开发、贡献和发布组织入口；贡献指南增加文档迁移时保留关键内容与归属的约定。

## 与文档一起发现的回归

- `send` 被普通对话的提前返回分支截走，常用命令也因此失效。改为在聊天分流之前进入已有命令审计 IPC，保留原始 Shell 引号、空格和管道；结果绑定原标签。
- Electron 已移除 `File.path`，旧拖拽代码取得空路径。改用 preload 暴露的 `webUtils.getPathForFile`，真实文件才生成上传路径，合成 File 给出提示。
- 版本更新为 1.6.1，以便安装包用户获得上述修复。

## PR #9

社区贡献 [Log Inspector](https://github.com/Amo-Zeng/AITerminal/pull/9) 保留在 `examples/log-inspector`，不加入内置目录。保留贡献者提交历史，合入当前 main 并修复：

- Windows 路径示例改为与可见终端一致的 WSL Ubuntu；按实际 Shell 验证绝对路径。
- `ctx.files.read` 实际先读取整个小文件，宿主输出上限 1 MiB；如实记录这一边界，不宣称已实现大文件 tail。
- 面板上限包含标题与说明，同时控制序列化字节；关键词统计只针对实际显示内容，标注截断和可能不完整的首行。
- 历史摘要限制条数和字节；只在 revision 改变时重试，取消与其他写入错误不吞掉。
- 用真实宿主服务和插件子进程验证文件读取、失败诊断、输出上限、只读行为与双标签隔离；补取消和状态冲突回归。
- Windows CI 揭示 PowerShell 文件服务按 ANSI 解码并额外输出换行，导致日志统计偏差和中文乱码。改为明确 UTF-8 读取并通过 `Console.Write` 保持原始换行，增加真实原生 Shell 回归。

## 验证记录

- `node --test test/logInspector.test.js`：4 项通过；插件开发命令校验和打包通过；TypeScript 5.9 严格 `checkJs` 通过。
- `node --test test/rendererCommands.test.js`：3 项通过。
- `npm run smoke:documented-flows`：在 WSL Linux 的真实 Electron 中通过，验证真实 File 的 preload 桥接，以及常用命令 → `send` → 命令审计 → PTY 的引号、管道和带空格路径。
- 新 Electron 检查纳入三平台 CI；Windows runner 不含已初始化的 Ubuntu，仅执行文件桥接检查，Shell 发送由 Linux/macOS CI 验证。
- 原版可用的 7 组演示链接均返回 HTTP 200；中英文 README 各保留原有 5 组，SSH 连接和 AI 流式演示放入使用手册。
- 主工作区 `npm test`：174 项，173 通过、1 项按平台跳过、0 失败；日志巡检与文件服务新增测试另行验证，最终三平台检查覆盖合并后的完整集合。

完整测试、链接检查、PR 合并和正式发布结果在完成后补记于此。
