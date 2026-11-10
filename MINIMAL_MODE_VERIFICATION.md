# 1.7.2 极简模式与普通 ls 文件链接

## 目标与验收标准

取消 `myls`，保留普通 `ls` 文件下载能力。极简模式仅保留终端和底部 AI 输入区，实际增加终端可用面积；切换不重建 PTY，不丢失输入或连接，不改变任务所属标签。只有真正获得键盘焦点的终端显示光标。

## 实现

- Ctrl/Cmd+Shift+M 和顶部按钮切换极简模式，底部退出按钮恢复完整布局。偏好保存在本机；分屏布局保持，底部会话选择器同时切换 AI 目标。
- AI 回复以按需展开的浮层呈现，不占终端网格宽度。输入、发送、接管、停止等任务控制仍可用；文件面板和会话搜索会恢复完整模式。
- 删除 `myls` 的主进程分派、渲染、缓存和旧链接提供器。普通文件链接独立读取直连 SSH 当前目录的 SFTP 元数据，按 xterm 单元格映射范围，避免中文和 emoji 错位。
- 链接绑定标签对象、SSH 连接、目录及有限有效期，保存对话框弹出后仍使用原连接。下载不自动打开文件，也不往终端注入提示。
- 修复根目录被误判为未知目录、延迟初始目录查询覆盖提示符目录的问题；双宽字符在行尾留出的填充单元格不视为文件名中的空格。
- 链接仅适用于直连 SSH 的跟踪目录，不推断嵌套 SSH/tmux 的文件系统；备用屏幕和鼠标捕获模式不提供此类链接。其他目录先 `cd` 再 `ls`，特殊换行文件名使用 `rfe`。

## 验证进展

验证使用真实 Electron/xterm、环回 SSH/SFTP 和临时下载目录。保存对话框由测试入口提供隔离的临时路径，生产下载 IPC、连接检查和文件传输均保留。测试不会连接用户的服务器或改写用户配置。

| 检查 | 结果与范围 |
| --- | --- |
| `npm test` | 本机 WSL Linux：196 项，195 通过、1 项平台不适用跳过、0 失败 |
| `smoke:appearance` | 真实原生窗口与 xterm；极简模式增加终端面积，隐藏工具栏与面板；800/1400/1600px 宽度下输入区保持紧凑且不横向溢出；保留输入焦点/草稿、原 PTY、分屏和会话目标；AI 回复浮层不挤压网格；恢复完整布局和重启记忆 |
| `smoke:terminal-files` | 两路真实环回 SSH/SFTP；普通 ls 鼠标点击下载字节正确；保存对话框期间切换标签不串服；中文、emoji、软换行及双宽行尾填充；目录变化/重连拒绝旧链接；不注入终端输出；根目录与初始化目录竞争 |
| `smoke:workspace`、`smoke:tmux`、`smoke:terminal-agent` | 本地与独立 SSH 分屏、窗口调整、真实 tmux 字符和鼠标交互、原终端/嵌套 SSH AI 接管通过 |
| `smoke:clipboard`、`smoke:documented-flows` | 复制/粘贴/回车复制、文件面板与命令交互通过 |
| 原生 Windows x64 | 独立源码目录与原生 Electron：appearance、terminal-files、workspace、clipboard 通过；不覆盖工作目录源码 |
| `doctor`、`security:scan`、`git diff --check` | 通过 |

[极简模式真实截图](assets/workspace-minimal.png) 来自本地终端中的测试与插件校验，不使用模拟终端内容。

截图窗口为 1400×900，终端工作区实测 1400×848，底部输入区占 52px；分屏边界和终端自身滚动条仍保留。

## 发布

版本 [v1.7.2](https://github.com/Amo-Zeng/AITerminal/releases/tag/v1.7.2) 已于 2026-11-10 发布。源码提交为 [`1de40c522fdde1512d1834279668a4695c1fc4b9`](https://github.com/Amo-Zeng/AITerminal/commit/1de40c522fdde1512d1834279668a4695c1fc4b9)，[三平台构建及发布任务](https://github.com/Amo-Zeng/AITerminal/actions/runs/42796040777) 全部成功，包含新增文件链接和极简模式检查，以及归档源码一致性和安装目录实际启动检查。

匿名验证确认 `/releases/latest` 已指向 v1.7.2，Windows x64 EXE、Linux x64 AppImage、macOS arm64 DMG 均返回 HTTP 200 的实际附件下载。共 8 个附件：三个安装包、三个 SBOM、`SHA256SUMS.txt` 和 `release-provenance.json`；校验值、发布标签和来源提交一致，发布说明保留 macOS 隔离属性处理命令。后续提交仅补充本文验证结果，不改变已发布运行代码。
