# 开源发布检查 / Open-source publication checks

日期：2026-11-07。发布源码：AITerminal 1.5.1 / Plugin API 1.1。本文记录当前检查范围；历史版本的数字与私有构建结果不能代替本次验证。

## 目标与发布边界

- 以维护中的当前源码为准，将完整桌面程序、插件宿主、10 个内置插件、SDK、测试与构建脚本发布到 `Amo-Zeng/AITerminal`。
- 采用 Apache-2.0，保留原 Logo、第三方许可和原有公开提交/Release。公开 `main` 原基线为 `d586885dc0a4c94cc4d5543da8052aaea4209949`；新源码作为后续快照提交，不重写旧历史。
- 在独立 Git 目录组装经审核的源码，不将私有构建仓库的历史、凭据、开发机配置或安装产物加入公开源码。
- 新增中英文首页、贡献指南、英文插件入门、路线图、问题/插件提案表单和 PR 模板，使贡献者可在公开 Fork 中开发和运行三平台 CI。

## 源码与凭据检查

源文件使用 Git 跟踪文件和未忽略的新文件组成清单，排除 `.git`、`node_modules`、`release`、缓存、本地草稿和用户配置。对待发布文件运行凭据特征扫描，并检查当前会话凭据没有出现在文件内容中；只记录命中的文件和类型，不输出秘密。正则扫描存在覆盖边界，不能证明任意自定义格式的秘密都可被识别。

LICENSE 为 Apache-2.0，项目元数据与中英文文档保持一致；运行依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。安装包以当前 `main.js` 为入口，未使用旧字节码，原图标继续用于三平台。

## 验证记录

| 检查 | 证据与范围 |
| --- | --- |
| 源码回归 | `npm test`：143 通过、0 失败；语法、标签/任务归属、SSH、PTY、凭据、执行审计、插件生命周期与通知 |
| 凭据与仓库卫生 | `npm run security:scan`、140 个待发布文件的当前凭据匹配检查、`git diff --check` 均通过 |
| 开发者入口 | 108 个文档相对链接和 5 个 YAML 文件检查通过；插件模板实际生成/验证/打包由回归测试覆盖 |
| 真实运行 | [插件验证](PLUGIN_VALIDATION.md)、[通知验证](WEBHOOK_VALIDATION.md) 记录了本地 Electron、HTTPS、PTY、tmux 与 Linux 包启动结果 |
| 公开三平台构建 | [Actions](https://github.com/Amo-Zeng/AITerminal/actions/workflows/windows-build.yml)；以对应提交的实际结果为准，包含打包源码一致性与实际启动门禁 |
| 依赖审计 | `npm audit --audit-level=high` 通过；当前仍有 1 low（KaTeX）和 6 moderate（构建依赖链），没有将其描述为零漏洞 |

公开发布的提交、三平台运行与产物信息以 [Release](https://github.com/Amo-Zeng/AITerminal/releases) 及其链接的 Actions 记录为准。安装包只有在对应平台全部门禁通过并核对摘要后才进入 Release。

## 已实现的边界

- renderer 启用隔离和 sandbox；脚本来自本地锁定依赖；AI Markdown 经 DOMPurify 消毒，声明式插件面板按纯文本渲染。
- 主进程管理标签、任务与连接身份，在异步授权后重验所有权；关闭标签或替换连接不会将迟到操作重定向至其他标签。
- SSH 验证主机指纹；首次信任与变更确认明确展示；服务器信任只对应已核验的当前远程身份。
- 凭据保存在系统安全存储，拒绝明文 fallback；AI API 要求 HTTPS（仅 loopback 允许 HTTP），Webhook 只支持 HTTPS。
- 程序停止与输出匹配通知有实例归属、去重和容量限制；输出/命令原文默认不发送。
- 插件宿主使用独立进程和生命周期回收；SDK 校验声明能力、输入 Schema 与任务目标。任意 Node.js 插件仍具有宿主用户权限，独立进程不等于系统沙箱。

## 仍需明确的限制

当前目录是初始工作目录，不是权限沙箱；命令审计无法证明任意 Shell 代码安全。被强杀的应用/系统或断网情况下不能保证 Webhook 投递；远端无退出状态时报告未知。手动程序需从“运行并通知”启动才能精确追踪退出。

Windows CI 没有用户的 WSL Ubuntu，默认参数检查与原生应用启动不能代替安装后的 WSL 实测；macOS 当前为未签名、未公证的 arm64 包。公开 CI 的成功不等于已在用户电脑完成 UAC 安装或全部外部服务器验收。

后续共建方向见 [ROADMAP.md](ROADMAP.md)，发布流程见 [RELEASING.md](RELEASING.md)，漏洞报告见 [SECURITY.md](SECURITY.md)。
