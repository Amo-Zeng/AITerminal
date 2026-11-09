# 1.7.0 工作区与界面验证

日期：2026-11-09。目标：实现可实际使用的本地/SSH 原生分屏，把焦点、布局和会话生命周期分开；更新桌面界面，同时保留终端交互、插件、通知及历史文档。设计来源见 [HexHub 评估](HEXHUB_ASSESSMENT.md)，操作见 [中文手册](USER_GUIDE.md#多会话工作区)和[英文手册](USER_GUIDE_en.md#multi-session-workspaces)。

## 实现范围

- `lib/workspaceLayout.js` 管理递归布局及导入校验；`workspaceRenderer.js` 管理可见窗格、分隔线、搜索、拖动、放大、布局保存/恢复、文件面板和固定插件面板。原 `renderer.js` 与主进程继续拥有会话和 IPC。
- 每个终端会话只有一个 xterm 视图。移动视图不重建 PTY/SSH；所有可见窗格按自身容器 fit，隐藏窗格保留上次有效尺寸。延迟 fit 只能聚焦仍为活动目标的会话。
- 并发新建标签捕获各自编号；AI 配置与底部输入草稿保留到会话，不因切换焦点被全局默认覆盖。
- 布局恢复追加新会话，不恢复原进程、目录或任务，不重放旧命令。SSH 等待手动连接，断线后不降级为本地 Shell。固定插件引用随会话映射，不携带内容、任务或安装/启用授权。
- SFTP 目录读取保留空格、Unicode、换行文件名；列表、上传和下载绑定发起时的连接，异步等待后重新核验归属。目录请求有超时和结果条数检查；条数检查发生在 `readdir` 完成后，尚非流式内存限制。
- 新界面包含会话侧栏、紧凑工具栏、明暗配色、目标标记、可调 AI 侧栏与状态栏。原 Logo、历史 GIF、macOS 隔离命令、Email/QQ群和致谢全部保留。

## 本机证据

开发环境：WSL2 Linux x64，Electron 42.11.18。Electron 检查使用独立临时用户目录；SSH、模型与 Webhook 使用本机测试服务，不读取真实账号配置。

| 检查 | 结果与范围 |
| --- | --- |
| `npm test` | 187 项：186 通过、1 项按平台跳过、0 失败；包含布局/凭据过滤、配置导入归属、SFTP 断线/过期回调/错误/超时等回归 |
| `npm run smoke:workspace` | 真实本地 PTY + 两个独立 SSH/SFTP 服务；快捷键分屏、鼠标选择目标/输入、分隔线拖动、拖放路由、移动保留实例、放大/分离、AI 配置/回复/草稿隔离、固定面板归属与恢复、SSH 断开/重连、关闭后的输入拒绝、并发创建 |
| DPI 100% / 125% / 150% / 200% | Chromium 模拟 deviceScaleFactor，核对各窗格有效尺寸及 SSH 服务端收到的 rows/cols；不等于四台实体显示器验收 |
| `npm run smoke:tmux` | 真实 tmux 两窗格、Unicode、字号/resize、AI 侧栏开关、右键、SGR/二进制鼠标、滚轮、标签隔离 |
| `npm run smoke:clipboard` | Ctrl+Shift+C/V、选中回车复制并清除选择、原会话归属 |
| `smoke:config-modal` / `smoke:plugins` / `smoke:plugin-runtime` | 配置与 Webhook 可编辑；插件中心、真实 Cordis 宿主、配置/模型/面板隔离及内置插件 |
| `smoke:documented-flows` / `smoke:notifications` | File 路径桥接、常用命令→send→真实 PTY；HTTPS 通知、程序退出/输出匹配及隔离 |
| Windows → WSL Ubuntu | 使用 Windows Node 22.16.0 运行 `scripts/localEnvironmentSmoke.js`，真实 ConPTY → `wsl.exe -d Ubuntu`；本地终端/AI 执行/插件文件/交互式输入与 resize 均通过 |
| 外观 | 实际截图检查深浅工作区、设置窗口、固定插件及 AI 侧栏；[深色](assets/workspace-dark.png)、[浅色](assets/workspace-light.png) |
| `security:scan`、`doctor`、`git diff --check` | 凭据扫描、语法/运行资源及补丁检查 |

## 多会话功能规模

运行 `node scripts/sessionBaseline.js --splits`：依次创建 1/8/16/32 个真实本地 PTY，分别发送独立标记并核对归属；随后保留 32 个 PTY，在 1920×1080 视口同时显示 8 个窗格（本次每个 98 列、10 行）。每个会话以约 100 ms 间隔输出 100 行，合计 3,200 行，全部完成且未串内容；最后关闭额外会话，恢复一个仍活动的本地终端。

这是约十秒输出窗口的功能检查，没有测量 RSS、CPU、队列上界或输入回显 p95，不代表 30 分钟持续高吞吐、32 路 SSH 或跨平台性能承诺。项目没有商业会话数量配额；导入文件的 512 会话/32 层/1 MiB 校验限额是独立约束。

## 发布验收

公开三平台工作流已增加 `smoke:workspace`。每个平台仍需完成原有依赖/安全/插件/通知检查、打包源码一致性和打包后启动；全部成功后自动同步 Releases。Windows hosted runner 没有初始化 Ubuntu 时仅跳过新工作区脚本中的本地 PTY 断言，真实 SSH 分屏检查仍执行；本机 Windows → WSL 的证据单独列在上表。

三平台构建与公开下载核验结果在发布完成后追加。长时间输出背压、主机分组、批量执行、跨会话 AI 编排和对外 MCP 服务端仍列入 [路线图](ROADMAP.md)。
