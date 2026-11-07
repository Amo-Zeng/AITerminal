# 程序与输出通知验证

日期：2026-11-07；版本 1.5.1。使用说明见 [WEBHOOKS.md](WEBHOOKS.md)。源码已公开，Windows x64、Linux x64、macOS arm64 的 [公开 CI](https://github.com/Amo-Zeng/AITerminal/actions/runs/42339871327) 全部成功；安装包入口见 [v1.5.1](https://github.com/Amo-Zeng/AITerminal/releases/tag/v1.5.1)。

## 目标与实现

为程序正常/异常停止提供基于退出事件的通知，为终端输出提供关键词通知；同时保持标签、主机与程序实例归属，保留原命令审计和 Webhook 凭据保护。

退出通知覆盖 AI 本地子进程/PTY、SSH 交互启动与 exec、插件执行服务、可见终端 Shell，以及手动“运行并通知”的前台命令。手动监控使用随机实例标识及终端控制消息确认开始/退出，不依据“输出暂时停止”猜测结束。输出匹配使用有界增量解析，独立处理 UTF-8、颜色、控制消息、跨块关键词和冷却计时。程序会话结束后取消监听，退出事件只结算一次。

## 验证证据

- `npm test`：**143 项通过、0 失败**，含新增程序/输出通知和原插件、标签、安全审计回归。最后的超长命令拒绝校验另跑调度回归，避免将截断后的命令送入终端。

- 真实 shell 子进程：退出 0、显式退出 7、命令不存在 127、SIGKILL 137；程序终止与重复 close 去重。
- 真实插件命令服务：输出命中、非零退出、取消；模拟 SSH 通道覆盖正常退出、SIGTERM、无退出码断线及交互会话清理。
- 主进程调度回归：监控前审计原命令、拒绝重复启动、拒绝高危授权失败、确认后后端变化拒绝执行；本地与远程通知归属正确。
- `npm run smoke:notifications`：真实 Electron + 临时本机 HTTPS 服务，配置保存/恢复、URL 不回显、空规则拒绝、正常/非零退出/Ctrl+C、ANSI 分块输出、双标签和按钮操作通过。测试使用临时证书并只在测试子进程信任该证书，没有关闭生产 TLS 校验，没有访问用户 Webhook。
- `npm run smoke:config-modal`、`smoke:clipboard`、`smoke:plugin-runtime`、`smoke:tmux` 通过；其中 tmux 验证双窗格、Unicode、右键/滚轮、resize 与标签隔离。凭据扫描通过。
- 最终界面检查修正了深色主题下复选框文字对比度；最终调度与输出解析分别 8 项回归通过，额外确认超长命令拒绝执行、制表符分列不会拼成虚假关键词。截图已重新检查。
- 最终 Linux 产物构建完成：49 个运行文件及元数据/依赖与当前源码一致，打包后 renderer、xterm/PTY 和实际 ASAR 中的 Cordis 插件宿主启动与退出验证通过。

截图和最终日志存放于 `release/notifications-verification/`；本地 Linux 打包检查使用 `release/notifications-final-verified/`。

## 边界

上述本地验证环境为 WSL/Linux；随后公开 CI 已在 Windows/macOS/Linux 运行相应测试并全部通过。Windows CI 不自带用户的 Ubuntu 发行版，其真实 Webhook 冒烟验证配置/HTTPS，交互监控需在装有 Ubuntu 的目标 Windows 上运行。远端退出测试使用可控 SSH 通道，未操作用户实际服务器。

手动监控需要从“运行并通知”启动；已经运行的任意程序、守护进程化或 tmux 内部作业不自动追踪。输出规则为字面文本，控制序列重绘时保守地隔断片段，不是完整屏幕模拟器。网络中断以及 AITerminal/操作系统被强制终止不能保证投递；远端断线明确报告状态未知。通用脱敏不等价于识别所有业务秘密，输出原文默认关闭。
