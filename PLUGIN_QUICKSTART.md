# Build your first AITerminal plugin

AITerminal has its own plugin host and SDK. Cordis manages internal lifecycles; third-party plugins target the AITerminal API. Version 1.5.1 ships Plugin API **1.1**, compatible with API 1.0. See the [full SDK reference](PLUGIN_SDK.md) and [TypeScript definitions](plugins/sdk/index.d.ts).

## Create, load and try

With Node.js 22+ and `npm ci` completed in the application checkout:

```bash
npm run plugin:dev -- new ../hello-aiterminal example.hello
npm run plugin:dev -- validate ../hello-aiterminal
npm start
```

Open the Plugin Center (`Ctrl/Cmd+Shift+P`), load the development directory, review the package, install it and enable it for the current tab. Run its greeting tool. The template needs no terminal connection or model key.

The generated directory contains `plugin.json`, `index.js` and `sdk.d.ts`. `activate(ctx, config)` registers capabilities declared in the manifest:

```js
exports.activate = ctx => {
    ctx.tools.register('hello', async ({ name = 'friend' }) => {
        const context = await ctx.context.read();
        const text = `Hello, ${name}! Tab: ${context.tabId}`;
        await ctx.ui.publish('greeting', { type: 'text', text });
        return { text };
    });
};
```

The template declares the `hello` tool, its input schema, the `greeting` panel and `context.read` permission. Re-import the directory after editing: installed code is an immutable reviewed snapshot, not a live view of your development files.

## Choose an example

| Goal | Example |
| --- | --- |
| Session state with revision-conflict retry, per tab (offline, English guide) | [Tab Notes](examples/tab-notes/) |
| Offline panels, events and per-tab session state | [Terminal Pet](plugins/terminal-pet/) and [Ops Quest](plugins/ops-quest/) |
| Validated parameters and interactive terminal sessions | [Docker Workbench](plugins/docker-tools/) |
| Task events and host-managed Webhook delivery | [Task Notifier](plugins/task-notifier/) |
| Model adapters and host-proxied model requests | [Model Policy](plugins/model-policy/) |
| Read-only commands and AI text without tool execution | [Git Time Machine](plugins/git-time-machine/) |

Use `ctx.terminal.exec({ argv: [...] })` for commands; `open/read/write/resize/close` support interactive sessions. Use `ctx.models.request({ messages, allowTools: false })` for text generation without nested execution. Model credentials remain with the host. `ctx.state.read/write` provides bounded session state per plugin and tab, with revision conflict checks; it is not durable storage.

Register capabilities in `activate`; invoke services inside a tool/event/model callback with a valid task context. Honor `ctx.signal`, register resource cleanup, and test cancellation, disable, close-tab and two-tab behavior. Terminal commands retain the host's risk audit. A separate plugin process does not restrict arbitrary Node.js code to an OS sandbox.

## Package and share

```bash
npm run plugin:dev -- validate ../hello-aiterminal
npm run plugin:dev -- pack ../hello-aiterminal ../example.hello.aitplugin.json
```

The packer prints the package SHA-256. Publish the JSON package over HTTPS or share it for manual import. A catalog can list its URL and digest; the full format is in the [SDK](PLUGIN_SDK.md). The host does not run npm installation scripts. Bundle JavaScript dependencies during development; packages cannot include native extensions.

For a contribution, open a [plugin proposal](https://github.com/Amo-Zeng/AITerminal/issues/new?template=plugin_proposal.yml) or a PR with a focused example, license, requested capabilities and test evidence. Community plugins may live in independent repositories. Inclusion in the bundled catalog requires review.

## Porting DSH, Cordis or MCP integrations

Map the original plugin's required services to AITerminal's `ctx` APIs, convert registrations to the manifest and `activate` interface, and replace global terminal/model references with the task-bound host services. Keep effects inside lifecycle scopes and verify tab isolation. An existing DSH/Cordis package is not automatically compatible simply because both hosts use Cordis.

Standard MCP servers can instead use a v2 package with `runtime: "mcp"`, `mcp.connect`, and either stdio or Streamable HTTP transport. The host currently supports a bounded tool-schema subset and has no MCP OAuth configuration flow. See the [MCP example and adaptation details](PLUGIN_SDK.md) before choosing a transport.
