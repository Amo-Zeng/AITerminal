# 1.7.0 工作区与界面验证

日期：2026-11-09。目标：实现可实际使用的本地/SSH 原生分屏，把焦点、布局和会话生命周期分开；更新桌面界面，同时保留终端交互、插件、通知及历史文档。设计来源见 [HexHub 评估](HEXHUB_ASSESSMENT.md)，操作见 [中文手册](USER_GUIDE.md#多会话工作区)和[英文手册](USER_GUIDE_en.md#multi-session-workspaces)。

本记录对应 1.7.0。用户随后要求采用 `beauty.html` 并更换图标，当前外观与光标焦点说明见 [1.7.1 验证](APPEARANCE_VERIFICATION.md)；README 中截图随当前版本更新，1.7.0 的历史截图可在该版本标签中查看。

## 实现范围

- `lib/workspaceLayout.js` 管理递归布局及导入校验；`workspaceRenderer.js` 管理可见窗格、分隔线、搜索、拖动、放大、布局保存/恢复、文件面板和固定插件面板。原 `renderer.js` 与主进程继续拥有会话和 IPC。
- 每个终端会话只有一个 xterm 视图。移动视图不重建 PTY/SSH；所有可见窗格按自身容器 fit，隐藏窗格保留上次有效尺寸。延迟 fit 只能聚焦仍为活动目标的会话。
- 并发新建标签捕获各自编号；AI 配置与底部输入草稿保留到会话，不因切换焦点被全局默认覆盖。
- 布局恢复追加新会话，不恢复原进程、目录或任务，不重放旧命令。SSH 等待手动连接，断线后不降级为本地 Shell。固定插件引用随会话映射，不携带内容、任务或安装/启用授权。
- SFTP 目录读取保留空格、Unicode、换行文件名；列表、上传和下载绑定发起时的连接，异步等待后重新核验归属。目录请求有超时和结果条数检查；条数检查发生在 `readdir` 完成后，尚非流式内存限制。
- 新界面包含会话侧栏、紧凑工具栏、明暗配色、目标标记、可调 AI 侧栏与状态栏。原 Logo、历史 GIF、macOS 隔离命令、Email/QQ群和致谢全部保留。
- 当前终端 AI 接管捕获原 `windowId + tabId + backend`，通过请求 ID 验证屏幕回复，用该 PTY/SSH 通道直接输入；禁止回退至 SSH exec、宿主进程或插件工具。任务提交后不跟随焦点移动，手动输入自动暂停且保持终端焦点，断线/重连使延迟模型结果及待确认操作失效。
- 当前终端任务日志在 AI 侧栏，屏幕含实时网格、滚动视口、光标及 alternate-buffer 标记。初始任务与最新补充保持可见，历史最多 80 条/192,000 字符，请求最近历史最多 16 条/64,000 字符；单份活动屏幕与历史视口各限 24,000 字符，每轮最多 40 步后暂停。这些是内容边界，不是 RSS/吞吐承诺。
- 普通问答、`fix`、`analyze`、`cmd` 使用所属窗格的当前文本屏幕；`analyze` 不再自动在第一层主机采集指标。高级主机/插件模式保留原接口，界面和文档明确 SFTP/插件服务不跟随嵌套 SSH。

## 社区反馈与调整

读取 [linux.do 反馈](https://linux.do/t/topic/3144041/48)及同一主题中的建议：#35 希望看到插件中心和实际用途；#44 希望统一背景、圆角、边框和控件大小；#46/#48 提到已有终端用户需要明确的使用理由；#36 关心 Electron 开销。

本轮统一设置窗口与插件中心的控件样式，修正浅色插件表单对比度，加入真实插件中心截图；双语 README 先给出嵌套 SSH 接管、CLI 退出通知、远程图片打开和团队插件流程。内存方面限制新接管历史与侧栏日志大小，保留实际会话规模验证的限制说明，没有宣称 Electron 已达到轻量原生终端的占用，也没有把长期性能问题标成已完成。

## 本机证据

开发环境：WSL2 Linux x64，Electron 42.11.18。Electron 检查使用独立临时用户目录；SSH、模型与 Webhook 使用本机测试服务，不读取真实账号配置。

| 检查 | 结果与范围 |
| --- | --- |
| `npm test` | 193 项：192 通过、1 项按平台跳过、0 失败；含布局/凭据过滤、SFTP 生命周期、屏幕请求跨窗口/窗格校验、模型/审计迟到结果撤销、分段输入审计、长任务目标与补充要求保留 |
| `npm run smoke:workspace` | 真实本地 PTY + 两个独立 SSH/SFTP 服务；快捷键分屏、鼠标选择目标/输入、分隔线拖动、拖放路由、移动保留实例、放大/分离、AI 配置/回复/草稿隔离、固定面板归属与恢复、SSH 断开/重连、关闭后的输入拒绝、并发创建 |
| `npm run smoke:terminal-agent` | 真实本地 PTY；SSH → Bash → OpenSSH → 第二层 SSH/Bash，验证模型输入得到 `SCOPE=INNER`；alternate-screen 程序实际接收单键；任务后切换焦点仍操作原目标；无第一层 exec/终端日志污染；手动打断不抢焦点、迟到输入丢弃、断线不可续用。模型为确定性本机服务，不代表真实模型对任意 Codex 版本都判断正确 |
| DPI 100% / 125% / 150% / 200% | Chromium 模拟 deviceScaleFactor，核对各窗格有效尺寸及 SSH 服务端收到的 rows/cols；不等于四台实体显示器验收 |
| `npm run smoke:tmux` | 真实 tmux 两窗格、Unicode、字号/resize、AI 侧栏开关、右键、SGR/二进制鼠标、滚轮、标签隔离 |
| `npm run smoke:clipboard` | Ctrl+Shift+C/V、选中回车复制并清除选择、原会话归属 |
| `smoke:config-modal` / `smoke:plugins` / `smoke:plugin-runtime` | 配置与 Webhook 可编辑；插件中心、真实 Cordis 宿主、配置/模型/面板隔离及内置插件 |
| `smoke:documented-flows` / `smoke:notifications` | File 路径桥接、常用命令→send→真实 PTY；HTTPS 通知、程序退出/输出匹配及隔离 |
| Windows → WSL Ubuntu | 使用 Windows Node 22.16.0 运行 `scripts/localEnvironmentSmoke.js`，真实 ConPTY → `wsl.exe -d Ubuntu`；本地终端/AI 执行/插件文件/交互式输入与 resize 均通过 |
| 外观 | 实际截图检查深浅工作区、设置窗口、固定插件及 AI 侧栏；[深色](assets/workspace-dark.png)、[浅色](assets/workspace-light.png)、[插件中心](assets/plugin-center.png) |
| `security:scan`、`doctor`、`git diff --check` | 凭据扫描、语法/运行资源及补丁检查 |

## 多会话功能规模

运行 `node scripts/sessionBaseline.js --splits`：依次创建 1/8/16/32 个真实本地 PTY，分别发送独立标记并核对归属；随后保留 32 个 PTY，在 1920×1080 视口同时显示 8 个窗格（本次每个 98 列、10 行）。每个会话以约 100 ms 间隔输出 100 行，合计 3,200 行，全部完成且未串内容；最后关闭额外会话，恢复一个仍活动的本地终端。

这是约十秒输出窗口的功能检查，没有测量 RSS、CPU、队列上界或输入回显 p95，不代表 30 分钟持续高吞吐、32 路 SSH 或跨平台性能承诺。项目没有商业会话数量配额；导入文件的 512 会话/32 层/1 MiB 校验限额是独立约束。

## 发布验收

公开三平台工作流已增加 `smoke:workspace` 和 `smoke:terminal-agent`。每个平台仍需完成原有依赖/安全/插件/通知检查、打包源码一致性和打包后启动；全部成功后自动同步 Releases。Windows hosted runner 没有初始化 Ubuntu 时跳过这两个脚本中的本地 PTY/Bash 嵌套链断言，真实 SSH 分屏与接管检查仍执行；本机 Windows → WSL 的证据单独列在上表。

### 当前发布状态

**1.7.0 已发布**：[下载页](https://github.com/Amo-Zeng/AITerminal/releases/tag/v1.7.0)，[三平台构建与自动发布](https://github.com/Amo-Zeng/AITerminal/actions/runs/42627831229)全部成功。安装包源码为 [`9bb5a9215640a0a402618271e3e7028ffdbf5cdc`](https://github.com/Amo-Zeng/AITerminal/commit/9bb5a9215640a0a402618271e3e7028ffdbf5cdc)；Windows、Linux、macOS 均通过打包源码一致性及打包后启动检查。

本机 Git HTTPS 连接超时后，通过 GitHub Git 数据接口上传相同对象并非强制快进 `main`；逐一核对 blob、tree 和 commit 哈希，保留全部三个本地提交，没有拉取旧源码覆盖或改写历史。凭据仅从环境读取，不进入源码、文档或命令参数。

2026-11-09 匿名发布核验通过：`releases/latest` 实际重定向至 `v1.7.0`；8 个附件全部上传完成；下载 `SHA256SUMS.txt` 与 `release-provenance.json` 核对摘要、标签、源码及工作流来源；三份安装包经公开资产端点跳转至 `release-assets.githubusercontent.com`，HEAD 均返回 HTTP 200，长度与发布元数据一致。此处不把 HEAD 检查当作完整下载安装测试；完整文件摘要由构建/发布流程及 GitHub 附件摘要交叉核对。发布说明保留 macOS `xattr` 命令与安装指南。

| 平台 | 公开安装包 | 大小（字节） |
| --- | --- | --- |
| Windows x64 | `AITerminal-1.7.0-x64-Setup.exe` | 122,511,632 |
| Linux x64 | `AITerminal-1.7.0.AppImage` | 136,044,573 |
| macOS arm64 | `AITerminal-1.7.0-arm64.dmg` | 129,984,430 |

发布后的本文补录属于文档更新，不重打包已经验证的同一份源码。

长时间输出背压、主机分组、批量执行、跨会话 AI 编排和对外 MCP 服务端仍列入 [路线图](ROADMAP.md)。
