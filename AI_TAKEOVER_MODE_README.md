# AI 接管模式

AI 接管模式允许模型根据用户任务规划并执行本地或远程命令。它适用于运维、诊断、开发和交互式 CLI 操作，但不会降低命令本身所需的权限。

## 执行目标

- `remote:` / `远程:`：只操作当前标签的 SSH 会话。
- `local:` / `本地:`：操作当前标签的本地终端环境。Windows 默认使用 WSL Ubuntu，与可见终端使用相同的发行版和 Shell；需要操作 Windows 文件时使用 `/mnt/c/...` 等 Ubuntu 路径。
- `hybrid:` / `混合:`：同时允许本地和当前标签的 SSH 会话，默认优先远程，模型需明确指定本地动作。

没有前缀时，已连接 SSH 的标签默认使用远程目标，否则使用本地目标。启动本地接管时读取可见终端进程的当前目录并显示目标环境确认；不会弹出 Windows 目录选择器去选择 Linux 目录。混合模式的本地侧使用该标签连接 SSH 前的本地环境；该环境必须已成功启动，目录采用最后跟踪的路径。

初始工作目录不是沙箱。AI 以终端用户的完整权限运行，能够访问该用户有权访问的其他路径和系统资源。

## 本地终端

每个标签都有独立的 xterm.js 和后端 PTY。Windows 的默认环境相当于：

```text
wsl.exe -d Ubuntu --cd ~
```

可通过 `AIT_TERMINAL_WSL_DISTRO` 指定其他 WSL 发行版，`AIT_TERMINAL_SHELL` 在 Windows 上指定 `wsl.exe` 的位置。应用通过启动标记记录 WSL Shell 和进程，在 Linux/WSL 中读取 `/proc/<pid>/cwd`，macOS 使用 `lsof` 查询目录；不会把查询命令输入正在运行的 Codex、tmux 等程序。无法确认目标时停止，不回退宿主 PowerShell。

AI 普通命令与插件使用独立进程，交互程序使用独立 PTY；它们共享终端的系统、发行版、用户和 Shell 配置，不共享可见 Shell 的临时变量、别名或正在运行的 tmux pane。接管启动后，AI 自己的 `cd` 更新接管目录。若在 tmux 内需要指定另一目录，请提供该目录的绝对路径。标签终端被关闭、重启或切换后，旧请求与执行目标失效。

模型配置支持 Chat Completions、Responses、Messages 三种 API；认证、流式输出和工具结果回传说明见 [AI_PROVIDERS.md](AI_PROVIDERS.md)。

`node-pty` 是核心运行依赖。若目标平台的原生模块没有正确安装或打包，本地终端和本地交互会话会直接拒绝启动，不会退化成不可靠的非 TTY 管道。

## 交互式命令

接管模式可以启动和控制 Codex、Python、Node.js、MySQL 等交互式程序。模型可使用：

- `interactive_start("command")`
- `interactive_send("text")` / `interactive_line("line")`
- `interactive_key("UP|DOWN|LEFT|RIGHT|ENTER|TAB|ESC", count)`
- `interactive_ctrl("C")`
- `interactive_wait(ms)` / `interactive_wait_for("text", timeout)`
- `interactive_exit()` / `interactive_stop()`

交互输入、输出、等待状态和 PTY 生命周期都绑定到发起接管的标签，后台标签的输出不会写入当前活动标签。

## 安全审计

所有 AI 提议的普通命令、直接发送、交互式启动和 REPL 载荷都会在执行前进入统一审计。识别出的高风险操作会暂停并要求用户明确确认，包括：

- 删除或覆盖文件、权限和所有者修改
- 提权、关机、重启、服务和防火墙修改
- 磁盘、分区和系统配置修改
- Git 强制操作、数据库破坏、包卸载和终止进程
- 下载后直接执行、编码 PowerShell 和编排资源删除
- 模型主动标记为需要确认的动作

命令审计是纵深防御，不是任意 shell 代码的安全证明。用户仍需核对命令、目标环境和影响范围。

## 多标签隔离

- SSH、本地 PTY、AI 配置和历史、接管状态、流式响应、当前目录和 resize 均按 `windowId + tabId` 路由。
- 每个标签可建立自己的 SSH 会话；关闭一个标签只清理该标签的连接和进程。
- 隐藏标签不执行 xterm `fit()`；切回标签后再适配并将尺寸同步给对应 PTY/SSH shell。
- 菜单中的断开、清屏和清除 AI 历史只作用于当前标签。

## 凭据与主机身份

- SSH 密码、私钥口令和 AI API key 使用 Electron `safeStorage`；配置方案和会话导出不含秘密。
- 平台没有真实加密后端时，秘密只保留在本次运行的主进程内存中。
- SSH 首次连接显示 SHA-256 主机指纹；已信任主机的密钥变化默认阻断并要求显式更新。
- AI API 只允许 HTTPS；HTTP 仅允许 loopback 地址。

## 开发验证

```bash
npm ci
npm test
npm run doctor
npm run smoke:local-environment
```

Windows 安装包必须在干净的 Windows runner 构建，并执行 `npm run verify:win-package`。该检查会验证 `main.js`、Apache-2.0 元数据、WSL Ubuntu 默认参数和 Windows x64 `node-pty` 原生文件。
