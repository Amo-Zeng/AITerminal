# 安装与排障 / Installation and troubleshooting

[返回 README](README.md) · [English](#english) · [文档索引](DOCUMENTATION.md)

## 下载与校验

从 [Releases 最新版本](https://github.com/Amo-Zeng/AITerminal/releases/latest) 下载安装包和同一版本的 `SHA256SUMS.txt`。Windows 使用 x64 `.exe`，Linux 使用 x64 `.AppImage`，macOS 当前使用 Apple Silicon / arm64 `.dmg`；没有 Intel Mac 专用包或 iOS `.ipa`。桌面安装包自带运行环境，不需要另装 Node.js。

在下载目录中计算对应文件的 SHA-256，与 `SHA256SUMS.txt` 中同名文件的一行比较：

```powershell
# Windows PowerShell
Get-FileHash .\AITerminal-*-Setup.exe -Algorithm SHA256
```

```bash
# macOS
shasum -a 256 ./AITerminal-*.dmg
# Linux
sha256sum ./AITerminal-*.AppImage
```

保留原文件名；通配符可能列出多个版本，逐个匹配。摘要不一致时重新下载，不要用解除隔离来处理实际损坏的文件。

## Windows：安装与 WSL Ubuntu

1. 运行 `.exe` 安装器，选择安装位置，安装完成后从开始菜单启动。
2. 本地终端需要 WSL Ubuntu。在管理员 PowerShell 执行：

   ```powershell
   wsl --install -d Ubuntu
   ```

3. 按系统提示重启并首次打开 Ubuntu，完成 Linux 用户名和密码初始化。
4. 使用 `wsl -l -v` 核对发行版名称，再运行 `wsl.exe -d Ubuntu --cd ~`，确认能进入 Shell。
5. 重新启动 AITerminal。本地终端、AI 和插件都在该 Ubuntu 环境中运行；Windows 的 `C:\Users\...` 在这里是 `/mnt/c/Users/...`。

若安装了其他名称的发行版，可在启动应用前设置 `AIT_TERMINAL_WSL_DISTRO`，值须与 `wsl -l -v` 一致。没有 WSL 时本地终端无法启动，仍可配置 SSH 连接远程服务器；不会自动改用宿主 PowerShell。

## macOS：安装与“已损坏”提示

1. 下载并校验 `.dmg`，双击挂载，将 **AITerminal.app 拖到 Applications（应用程序）**。
2. 弹出磁盘映像，从“应用程序”打开 AITerminal。当前版本未签名、未公证，系统可能提示无法验证开发者或“已损坏”。
3. 来源和校验和确认无误后，在 macOS 自带“终端”执行：

   ```bash
   sudo xattr -r -d com.apple.quarantine /Applications/AITerminal.app
   ```

4. 输入 macOS 管理员密码（终端不会显示输入字符），再打开应用。安装在其他目录时，用实际 `.app` 路径替换；路径有空格时使用引号。

此命令只递归移除该应用的 `com.apple.quarantine` 属性，不关闭全局 Gatekeeper。`No such file` 表示路径不对或应用还未复制到 Applications；没有该属性时继续重复此命令没有意义。若校验无误且解除隔离后仍闪退，请提供 macOS 版本、芯片类型、安装包文件名和系统崩溃报告的脱敏内容。

旧 README 中的 macOS 处理经验及提供者已保留在 [致谢](README.md#致谢)：lorsque 提供 `xattr` 方法，Jasonvip 分享 Sentinel 的处理经验；未复核的第三方工具不作为必装依赖。

## Linux：AppImage 与 FUSE

在下载目录运行（有多个版本时改用需要启动的具体文件名）：

```bash
chmod +x ./AITerminal-*.AppImage
./AITerminal-*.AppImage
```

若提示缺少 FUSE，可安装发行版对应的 FUSE 兼容组件，或使用 AppImage 自带的提取运行方式：

```bash
./AITerminal-*.AppImage --appimage-extract-and-run
```

如果系统仍不支持该方式，可先运行 `./AITerminal-*.AppImage --appimage-extract`，再执行 `./squashfs-root/AppRun`。Linux/WSL 的图形程序需要桌面、Wayland/X11 或 WSLg；纯 SSH 文本环境无法直接显示桌面窗口。请以普通桌面用户运行。

## 第一次使用与常见问题

| 现象 | 检查方法 |
| --- | --- |
| 本地终端打不开 | Windows 先直接测试 `wsl.exe -d Ubuntu --cd ~`；其他系统核对 Shell 与安装包架构。源码运行时执行 `npm run doctor` |
| SSH 连不上 | 在配置中核对主机、端口、用户名、密码/私钥和口令；首次连接核对主机指纹 |
| AI 不能回复 | 终端本身不需要 Key；AI 需要对应服务的地址、模型名、Key 和 API 格式，在 AI 配置中测试连接，详见 [模型 API](AI_PROVIDERS.md) |
| `rfe` 无结果 / `ls` 文件名无法点击 | 本标签须直连 SSH；`rfe` 在底部命令框输入。普通文件名链接匹配应用跟踪的 SSH 当前目录，全屏程序和鼠标跟踪模式不启用；其他目录或特殊文件名使用明确路径的 `rfe` |
| Webhook 不通知 | 在 Webhook 配置中填写 HTTPS URL、启用事件并测试；程序停止通知的手动命令使用“🔔 运行并通知”，详见 [通知文档](WEBHOOKS.md) |
| tmux 滚轮行为不符预期 | 在 tmux 配置中启用 `set -g mouse on`；鼠标事件交给 tmux 时，`Shift+右键` 仍使用本地剪贴板 |
| 配置导出后没有 Key | 导出不包含密码、私钥口令、模型 Key 或 Webhook URL；在新环境中重新配置凭据 |

更多入口见 [使用手册](USER_GUIDE.md)。仍有问题可通过 [GitHub Issues](https://github.com/Amo-Zeng/AITerminal/issues)、[1019191262@qq.com](mailto:1019191262@qq.com) 或 QQ 群 **1053768305** 联系；不要公开凭据或敏感日志。

## English

Download the matching installer and `SHA256SUMS.txt` from the [latest Release](https://github.com/Amo-Zeng/AITerminal/releases/latest). Current packages are Windows x64, Linux x64 and macOS Apple Silicon/arm64. There is no Intel Mac-specific or iOS package. Installed applications do not need Node.js.

Compare the downloaded file's SHA-256 with the same filename in `SHA256SUMS.txt`. Use `Get-FileHash` on Windows, `shasum -a 256` on macOS or `sha256sum` on Linux, as shown above. Re-download mismatched files.

**Windows:** run the `.exe` installer. In administrator PowerShell, run `wsl --install -d Ubuntu`, reboot if requested and finish Ubuntu's first-run user setup. Check `wsl -l -v` and try `wsl.exe -d Ubuntu --cd ~` before reopening AITerminal. The local terminal, AI and plugins share WSL Ubuntu and Linux paths (`/mnt/c/...` for Windows files). Set `AIT_TERMINAL_WSL_DISTRO` before launching to use another installed distribution. SSH connections remain available without WSL, but the local terminal does not fall back to host PowerShell.

**macOS:** verify the `.dmg`, mount it and drag AITerminal.app into Applications. Eject the disk image and open the installed app. The current build is unsigned and not notarized. If a verified copy is blocked with “damaged” or an unverified-developer message, open macOS Terminal and run:

```bash
sudo xattr -r -d com.apple.quarantine /Applications/AITerminal.app
```

Enter your macOS administrator password (input is invisible) and reopen the app. Adjust/quote the path if installed elsewhere. This removes the quarantine attribute for this app only; it neither disables Gatekeeper globally nor repairs corrupt files. “No such file” means the path is wrong or the app was not copied into Applications. If the app still crashes, report the OS version, chip, installer filename and a redacted crash report. Attribution for the original workaround and the community's Sentinel report is preserved in [Acknowledgments](README_en.md#acknowledgments).

**Linux:** make the downloaded AppImage executable with `chmod +x`, then run it. If FUSE is unavailable, try `--appimage-extract-and-run`, or `--appimage-extract` followed by `./squashfs-root/AppRun`. Use the specific downloaded filename when several versions are present. A desktop session, X11/Wayland or WSLg is required; run as a normal desktop user.

**First use:** local terminals and SSH do not require a model key. Configure your endpoint, model, key and API format for AI features; see [AI providers](AI_PROVIDERS.md). The [English user guide](USER_GUIDE_en.md) covers commands, file transfer, settings and shortcuts. Enable notification events and test your Webhook before using it. Saved session files intentionally omit credentials.

**Support:** [Issues](https://github.com/Amo-Zeng/AITerminal/issues), [1019191262@qq.com](mailto:1019191262@qq.com), QQ group **1053768305**. Include app/OS versions, architecture, local/WSL/SSH environment and reproduction steps; redact secrets and sensitive logs.
