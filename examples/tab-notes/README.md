# Tab Notes — a session-state example (Plugin API 1.1)

A small offline plugin that demonstrates AITerminal's per-tab session state:
`ctx.state.read()` / `ctx.state.write(value, revision)`, revision-conflict
retry, and tab isolation. It needs no terminal connection, no model, no server
and no keys — every tool runs against host-held state only.

## What it shows

| Teaching point | Where |
| --- | --- |
| Read → compute → write with the revision from your read | `withState()` in `index.js` |
| Bounded retry when a concurrent write rejects your revision | `MAX_ATTEMPTS` loop in `withState()` |
| Serializing same-tab tool handlers so they do not race each other | `serial()` queue in `index.js` |
| State is per plugin + per tab, and not durable storage | panel text plus the two-tab check below |
| Declaring what the code uses: tools, panel, `context.read`, API 1.1 | `plugin.json` |

## Try it

From the application checkout (Node.js 22+, `npm ci` completed):

```bash
npm run plugin:dev -- validate examples/tab-notes
npm start
```

Then in the app:

1. Open the Plugin Center (`Ctrl/Cmd+Shift+P`) and load the development
   directory `examples/tab-notes`.
2. Review the package, install it, and enable it for the current tab.
3. Run **Add a note** with a short text, then **Show this tab's notes**. The
   `notes` panel prints the tab id and the note list.
4. Open a second tab, enable the plugin there and add a different note. Each
   tab shows only its own list — state is scoped to one plugin instance and
   one tab, even if the tabs share a target or shell.
5. Run **Clear this tab's notes** without `confirm`, then with
   `confirm: true`, to see an explicit-confirmation guard.

Re-import the development directory after editing any file: the host runs an
immutable reviewed snapshot, not a live view of your development files.

## How state behaves

- `ctx.state` holds up to 32 KiB of JSON per plugin and tab and needs no
  permission entry in the manifest.
- `write(value, revision)` rejects instead of overwriting when the revision is
  stale. Real plugins should serialize state operations or re-read and
  recompute; this example does both and gives up after three attempts.
- State survives idle host recycling, but is cleared on disable, code update,
  tab close and app exit. Treat it as session memory, never as storage.
- `ctx.state` calls need a valid task context, so they belong inside tool,
  event, model or prompt callbacks — not at the top level of `activate()`,
  which only registers capabilities.

## Manifest checklist

Every capability used by `index.js` is declared in `plugin.json`:

- `engines.pluginApi: "^1.1.0"` — session state is an API 1.1 feature
  (`aiterminal: ">=1.5.1"` matches where API 1.1 shipped).
- `tools` — `add`, `show`, `clear`, each with an input schema the host
  validates before the handler runs.
- `panels` — the `notes` panel used by `ctx.ui.publish`.
- `permissions: ["context.read"]` — the only host API that requires one here;
  state and `ui.publish` need no permission entry.
- `configSchema` — the `keepLast` option, merged by the host with defaults.

## Verify against the SDK types

`sdk.d.ts` is a copy of [`plugins/sdk/index.d.ts`](../../plugins/sdk/index.d.ts)
so editors pick up the real host types. The JSDoc annotation on
`exports.activate` types `ctx` as `PluginContext`, so a plain check compiles
the example against the SDK:

```bash
npx -y typescript tsc --noEmit --allowJs --checkJs --target es2022 --module commonjs --moduleResolution node examples/tab-notes/index.js
```

## Limits

- Notes are capped at `keepLast` (1–50, default 10) per tab to stay far below
  the 32 KiB state bound.
- The plugin registers no commands, so nothing adds to the host's risk audit.
- This is an example, not a bundled plugin: it is not listed in
  `plugins/catalog.json` and makes no request to be. Third-party plugins can
  live in their own repositories.
