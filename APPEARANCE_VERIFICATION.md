# 1.7.1 外观与光标焦点验证

日期：2026-11-10。目标：将用户提供的 [beauty.html](beauty.html) 应用到真实工作区，更新应用图标；保证只有实际获得键盘焦点的终端显示光标，不破坏分屏隔离、tmux 尺寸和 AI 接管。

## 实现

- `workspace.css` 映射原设计的青紫配色、明暗主题、柔和背景、圆角终端卡片、渐变品牌和 AI 输入区。固定插件面板放到工作区右侧，继续保留原会话、实际数据及启停状态。原有自定义终端主题保留自己的终端背景；xterm 字符仍由自身网格渲染。
- 顶栏、会话导航与分屏控件使用本地 SVG。`build/icon.svg` 是新 `A>` 应用标志的唯一矢量源；`npm run icons:generate` 使用项目现有 Electron 栅格化，输出 1024px PNG、七种尺寸的 Windows ICO、128/256/512/1024px macOS ICNS。无需联网、系统字体或额外图像工具。运行时使用的 SVG/PNG 通过独立文件集加入应用归档，避免被 electron-builder 默认的构建资源排除规则遗漏；原始设计文件不随安装包分发。
- 当前会话目标与键盘焦点分开。光标条件为：原窗格仍存在且可见、是选中会话、窗口处于活动状态、该 xterm textarea 真正获得焦点、没有遮挡输入的弹窗。非聚焦状态使用 xterm 的 `cursorInactiveStyle: none`，不会隐藏光标位置下的正常字符。
- 输入框、设置/插件弹窗、原生窗口失焦及恢复触发焦点同步；后台程序请求开启光标闪烁时仍受焦点约束。用户关闭闪烁后，聚焦窗格显示静态光标。CSS 关闭动画的系统偏好同样保留。
- resize 和 SSH 连接完成回调只适配尺寸，不再延迟聚焦。移动/关闭窗格造成视图重新挂载时，仅恢复原本拥有键盘焦点的可见终端，不从 AI 输入框或弹窗夺取焦点。
- xterm 挂在无内边距的 `.terminal-grid` 中，让 FitAddon 测量真实内容尺寸，装饰边距留在外层。原来直接测量带 padding 容器会把内边距算进列/行预算，并在 tmux/字号变化后暴露一列偏差；真实 tmux 回归保留精确恢复尺寸和字符位置断言。
- 工作区内容宽度不超过 760px 时，AI 结果面板排列在终端下方，避免侧栏将分屏挤成几列。分隔条的鼠标拖动、方向键与无障碍方向信息随布局切换。
- Windows 通过统一的 `lib/nodePty.js` 使用 node-pty 自带的 ConPTY，覆盖可见终端、AI 交互会话与插件 PTY。原系统 ConPTY 在终端启动/输出期间关闭时可阻塞 Electron 主进程；新实现避免该关闭路径。构建在原生模块重编译之后、创建归档之前恢复相邻的运行库；Windows 打包检查要求同时包含 `conpty.dll` 和 `OpenConsole.exe`。

## 验证范围

本机包含 WSL2 Linux x64 及原生 Windows x64；Windows 使用独立源码目录及锁定依赖，不覆盖主目录。所有 Electron 检查使用临时用户目录。模型、SSH 使用本机测试服务，不使用真实模型或主机凭据。原生窗口焦点检查启动两个普通窗口，不使用 Chromium 的 headless 模式，确保检查的是实际的窗口失焦和恢复。

| 检查 | 验收范围 |
| --- | --- |
| `npm test` | 193 项：192 通过、1 项平台跳过；原有隔离、接管、插件、文件、通知与发布回归 |
| `npm run smoke:appearance` | 三个真实 xterm 的渲染光标互斥；两个原生窗口的失焦/恢复；AI 输入框、设置与插件弹窗；待处理 resize 不抢焦点；后台光标请求；闪烁偏好；移动、放大、关闭；暗色/浅色/Nord；开启 AI 面板后在 800/1100/1600px 宽度下保留可读字符网格；上下排列时键盘与鼠标调整面板高度 |
| `npm run smoke:tmux` | 真实双 pane tmux、Unicode、字号/尺寸切换、AI 侧栏开关前后精确恢复、右键、滚轮与字符位置 |
| `smoke:workspace`、`smoke:terminal-agent` | 本地与两路 SSH 分屏、DPI、拖动与会话归属；真实嵌套 SSH 和交互界面接管、手动暂停及断线撤销 |
| `smoke:clipboard`、`smoke:config-modal`、`smoke:plugins` | 复制粘贴、回车复制、配置/Webhook 可编辑、插件安装启用与归属 |
| `doctor`、`security:scan`、`git diff --check` | 运行资源、语法、凭据及补丁检查 |
| Linux 本地打包与启动 | 在独立目录构建真实应用；`verify:package-source` 验证 60 个运行文件及元数据/依赖，`smoke:package-startup` 验证渲染器、本地 PTY 与插件宿主成功启动 |
| 原生 Windows 验证 | 光标检查连续三轮通过；工作区/SSH 焦点与 AI 屏幕接管通过；真实 Windows → WSL Ubuntu 验证目录、AI 执行、插件读写、Unicode、交互输入和 resize；原生 PTY 输出与退出通过 |
| 构建钩子回归 | 用临时目录模拟重编译清理后的目录，验证匹配架构的 ConPTY 运行文件补齐、原生模块保持原样、缺失或错误架构被拒绝；正式 Windows 构建仍执行原生模块重编译 |
| 截图 | [深色](assets/workspace-dark.png)、[浅色](assets/workspace-light.png)、[插件中心](assets/plugin-center.png)，均由实际应用生成 |

没有用原型中的假终端内容替代后端；没有把原型中三个同时闪烁的 CSS 光标带入产品。新外观不代表内存或持续高吞吐已经完成优化，性能验证限制仍见 [工作区记录](WORKSPACE_VERIFICATION.md)。

## 发布

版本为 1.7.1，三平台工作流增加 `smoke:appearance`，打包源码验证包含 SVG/PNG 标志。最终构建与匿名下载核验结果将在发布完成后补录。
