# AITerminal Plugin API 1.1.0

AITerminal 提供自己的插件宿主。代码插件导出 `activate(ctx, config)`；宿主注入 SDK。内部使用锁定的 Cordis 4.0.0-rc.12，第三方插件以本文及 [SDK 类型](plugins/sdk/index.d.ts) 为稳定接口。API 1.1 随 AITerminal 1.5.1 提供，向后兼容 1.0，新增会话状态与纯文本模型请求；使用这些新能力时声明 `engines.pluginApi: "^1.1.0"`。此前的 1.5.0 安装包使用 API 1.0。English: [Plugin quickstart](PLUGIN_QUICKSTART.md)。欢迎通过 [贡献指南](CONTRIBUTING.md) 和 [插件提案](https://github.com/Amo-Zeng/AITerminal/issues/new?template=plugin_proposal.yml) 参与共建。

## 从模板到安装

在项目根目录执行：

```sh
npm run plugin:dev -- new ./my-plugin example.hello
npm run plugin:dev -- validate ./my-plugin
npm run plugin:dev -- pack ./my-plugin ./example.hello.aitplugin.json
```

`new` 不覆盖已有目录，`pack` 不覆盖已有文件。开发目录包含 `plugin.json`、`index.js` 和类型提示文件。可直接在插件中心“加载开发目录”，或导入生成的 JSON 包；二者都先预览、再保存不可变快照。修改开发文件后重新导入才生效。

开发清单可用 `sourceFiles` 指定要打包的相对路径数组，默认为入口文件。仅收录列出的 JS/CJS/JSON/TXT 文件，拒绝符号链接和路径越界；总包不超过 2 MiB、最多 64 个文件。依赖请在开发阶段打入 JS bundle，运行端不执行 npm 安装脚本。当前不支持原生扩展包。

一个插件实现示例：

```js
exports.activate = ctx => {
    ctx.tools.register('hello', async ({ name = '朋友' }) => {
        const context = await ctx.context.read();
        const text = `你好，${name}。当前标签：${context.tabId}`;
        await ctx.ui.publish('greeting', { type: 'text', text });
        return { text };
    });
};
```

工具 `hello`、面板 `greeting` 及 `context.read` 权限必须在清单中声明；模板已经提供完整声明。每个工具都声明输入 Schema，宿主在调用实现前校验。Schema 支持基本类型、对象属性、数组、必填、枚举、默认值及长度/数值范围；不支持外部引用、正则或任意 Schema 代码。

## 注册和调用

| API | 用法 |
| --- | --- |
| `ctx.tools.register(id, handler)` | 注册清单声明的工具。处理函数接收已验证的参数，返回 JSON 可序列化结果 |
| `ctx.prompts.register(id, provider)` | 为所属标签提供动态指引。提供者有 5 秒时限，可读取上下文、访问会话状态、发布面板或通知 |
| `ctx.models.register(id, handler)` | 注册清单声明的模型适配器，处理 `messages/maxTokens/streaming` 并返回文本 |
| `ctx.models.request(request)` | 通过当前标签配置的模型服务发起请求，可覆盖模型名称、温度和 token 数；`allowTools: false` 禁用接管模式中的嵌套工具调用，适用于总结或故事；凭据由宿主持有 |
| `ctx.services.register(id, handler)` | 注册清单声明的服务 |
| `ctx.services.call(pluginId, id, params)` | 调用显式声明的依赖插件服务，继承原任务执行目标与取消信号 |
| `ctx.events.on(event, handler)` | 订阅本标签的 `task.started/completed/error/cancelled` 等事件，每事件注册一个处理器 |
| `ctx.context.read()` | 读取当前任务绑定的标签、目标、Shell、工作目录、最近输出及 AI 任务描述 |
| `ctx.ui.publish(id, panel)` | 发布清单声明的 `text/log/table` 面板，由宿主以纯文本渲染 |
| `ctx.state.read()` | 读取本插件、本标签的会话状态，返回 `{ revision, value }`，初始为 `{ revision: 0, value: null }` |
| `ctx.state.write(value, revision)` | 写入最多 32 KiB 的 JSON，携带读取时的 revision；冲突拒绝覆盖，返回新 revision/value |
| `ctx.progress(value)` | 发布有界任务进度/日志 |
| `ctx.notifications.send({event, message})` | 使用现有 Webhook 配置发送通知；返回投递结果，最多尝试三次 |
| `ctx.onDispose(fn)` / `ctx.effect(fn)` | 注册回收动作。在工具处理器内注册的资源随任务结束回收，在 activate 内注册的资源随插件停用回收 |
| `ctx.setInterval(fn, ms)` | 创建跟随当前作用域回收的定时器；后台回调仍需合法任务上下文才能调用执行服务 |

`ctx.signal` 在工具、模型、事件和指引回调中提供取消信号。返回一个清理函数也可作为 activate 的卸载处理。`activate` 应只注册能力；没有任务身份时无法通过 SDK 执行终端或网络服务。

配置按插件默认值、用户配置、连接配置、标签配置合并；每个运行实例持有不可变快照。连接配置绑定已验证 SSH 身份及主机指纹，本地环境使用独立配置项。当前标签的覆盖只存于会话内；用户/连接配置持久化。

工具本身可以顺序组合多次服务调用形成工作流。参考 [Docker 巡检实现](plugins/docker-tools/index.js) 的 `inspect`。跨插件服务需要清单 `dependencies` 中的版本约束，循环依赖、循环调用和不兼容替换会被拒绝。

会话状态由主进程保留，不需要额外能力声明，不访问文件系统。空闲或资源回收导致宿主重启、配置变化时保留；停用、卸载、更新代码、关闭标签或退出应用后清空。所有权包含窗口中的标签对象、插件 ID 和代码摘要；更新后仍在结束旧任务的实例不能读写新版本状态。不同标签即使 tabId 相同也隔离。

```js
const saved = await ctx.state.read();
await ctx.state.write({ visits: (saved.value?.visits || 0) + 1 }, saved.revision);
```

并发读写可能冲突，插件应串行处理状态操作，或重新读取后重新计算；不要用旧结果覆盖。`state` 与其他 SDK 调用一样需要有效任务身份，不能在 `activate` 中直接调用。参考 [终端宠物](plugins/terminal-pet/index.js) 的事件处理和 [运维闯关](plugins/ops-quest/index.js) 的进度管理。

## 终端与交互式程序

```js
const result = await ctx.terminal.exec({ argv: ['docker', 'ps', '-a'] });
if (result.exitCode !== 0) throw new Error(result.output);

const { sessionId } = await ctx.terminal.open({ argv: ['docker', 'logs', '--follow', 'my-container'] });
let cursor = 0;
while (!ctx.signal.aborted) {
    const chunk = await ctx.terminal.read(sessionId, { cursor, waitMs: 1000 });
    cursor = chunk.cursor;
    if (chunk.text) ctx.progress(chunk.text);
    if (chunk.ended) break;
}
```

`exec` 支持 `argv` 或显式 `command`。优先使用参数数组，宿主按实际 Shell 转义，并同时审计参数语义与最终命令。`requiresConfirmation: true` 可以提高审计要求，不能降低要求。

交互式 API 还包括 `write(sessionId, text)`、`resize(sessionId, cols, rows)`、`close(sessionId)`。会话只属于创建它的任务，任务结束会关闭；需要持续运行的程序应保持处理器等待。文件 API 是 `files.read(path)` 与 `files.write(path, text)`，写操作接受统一确认策略。执行服务在每次异步确认后重验原始标签、连接和任务身份。

插件任务在独立命令/PTY 中执行，使用所属标签的直连 SSH 主机或本地环境，不跟随可见终端内的嵌套 SSH。Windows 本地环境使用同一个 WSL 发行版及 Linux 路径。普通本地任务在执行时查询终端进程当前目录；高级接管工具使用 AI 当前工作目录。它们不继承可见 Shell 的临时变量、别名或 tmux pane 状态。通过 `context.read()` 核对目录，重要路径使用绝对路径；插件不能自行切换所属标签或替换执行环境。显式配置的 MCP stdio 服务仍是宿主进程，其启动命令与终端执行服务分开配置。

取消会先发出信号、释放任务资源；不响应取消的插件宿主会终止。远端进程是否已退出无法总是确认，取消不应当被解释为撤销服务器副作用。

## 模型与 AI 工具

普通聊天可注入插件指引，不自动调用运维工具。高级主机/插件接管提供原生 function tools；默认的当前终端接管只读屏和输入，不加载插件指令、模型适配器或工具。不接受原生工具参数的服务在高级模式通过同一执行路由使用文本形式：

```text
plugin_tool("aiterminal.docker-tools", "list", {})
```

输入、目标、当前启用版本和执行内容均在主进程校验。一次模型请求最多处理 8 轮、每轮 16 个工具调用。模型适配器在插件详情中按标签选用，示例见 [模型策略](plugins/model-policy/index.js)。宿主代理跟随本标签配置的 Chat Completions、Responses 或 Messages 协议，见 [模型 API](AI_PROVIDERS.md)；其他协议的适配器需自行实现协议部分，SDK 不向其直接交付宿主 API Key。

## 标准 MCP

v2 包可以声明 `runtime: "mcp"`，不包含 JS 文件。例如：

```json
{
  "schemaVersion": 2,
  "id": "example.mcp",
  "name": "我的 MCP 服务",
  "version": "1.0.0",
  "description": "接入自己的标准 MCP 服务",
  "author": "Your name",
  "license": "Apache-2.0",
  "runtime": "mcp",
  "engines": { "aiterminal": ">=1.5.0", "pluginApi": "^1.0.0" },
  "permissions": ["mcp.connect"],
  "mcp": { "transport": "http", "url": "http://127.0.0.1:3000/mcp" }
}
```

支持 Streamable HTTP 和 `stdio`。后者的 `mcp` 字段为 `{"transport":"stdio","command":"服务器程序","args":[]}`，服务器程序由用户安装。插件自身不依赖系统 Node，外部 MCP 服务的运行环境取决于该服务。

未声明配置 Schema 时，宿主自动生成 URL 或程序/参数表单。HTTP 允许 HTTPS 和本机 HTTP，不允许 URL 内嵌凭据；当前未实现 MCP OAuth 配置流。工具 ID 由服务工具名称稳定派生，支持最多 30 个工具以及资源列表/读取。远端工具也需使用本文支持的 Schema 子集；不支持的 Schema 会显示加载错误。

## 包、目录与信任

v1 JSON 插件继续可用。v2 的 `files` 是相对路径到 UTF-8 文本的映射，完整包摘要决定不可变目录。插件源格式为：

```json
{ "schemaVersion": 1, "plugins": [
  { "id": "example.hello", "name": "Hello", "version": "1.0.0", "description": "示例插件", "url": "https://example.com/example.hello.aitplugin.json", "sha256": "填写实际包文件的64位SHA256" }
] }
```

源码包、元数据和依赖在安装前预览；摘要保证下载内容一致，来源可信度仍由用户判断。更新先初始化新实例，再发布新任务路由；已有任务及其依赖继续使用绑定实例。失败保留旧版本，界面保留最近三个历史版本用于恢复。恢复时一并恢复历史用户/连接配置，清除各标签的覆盖，预览中会明确提示。正常更新遇到配置不兼容或新依赖未启用时拒绝切换；外部数据修改不由包恢复自动回滚。

第三方代码和 MCP 服务具有宿主用户权限。独立进程隔离崩溃与模块状态，SDK 负责自身出口的审计和任务资源，不能限制任意 Node 代码绕过 SDK。不要把凭据写入包、指引、普通配置或日志。强权限沙箱、任意网页 UI 和原生依赖包属于独立的后续扩展。

## 适配 Cordis / DSH 插件

把现有插件的工具、提示、模型、配置和事件映射到上述接口；将会话状态移入当前插件实例，避免全局会话变量。对于只依赖兼容 Cordis 服务的逻辑，可在 `ctx.cordis` 下挂载，再提供所需服务代理。该入口依赖内部 Cordis 版本，应随适配包锁定验证。DSH profile/bundle 的应用组合与 UI 需要单独迁移。

插件开发与回归命令：`npm test`、`npm run smoke:plugins`、`npm run smoke:plugin-runtime`。安装产物测试 `npm run smoke:package-startup` 会启动实际打包的插件宿主并验证清理。
