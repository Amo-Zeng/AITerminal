# Log Inspector — a read-only file example (Plugin API 1.1)

A small read-only plugin that inspects a log file you name: it shows the most
recent lines, counts a literal keyword, and publishes a plain-text panel. It
needs no model, no server and no keys, and it never modifies anything.

## What it shows

| Teaching point | Where |
| --- | --- |
| Read-only host access: `ctx.files.read` + the `files.read` permission | `index.js`, `plugin.json` |
| Input validated by the manifest schema before the handler runs | `inputSchema` of the `inspect` tool |
| Bounded output: last N lines plus a hard 20 000-character cap | `MAX_LINES` / `MAX_CHARS` in `index.js` |
| Honest diagnostics: file-service errors passed through verbatim | `exitCode !== 0` branch in `index.js` |
| Local vs SSH target shown on every panel | `ctx.context.read()` in `index.js` |
| Per-tab state with revision-conflict handling | `record()` in `index.js` |
| Cancellation honored between read and publish | `ctx.signal` check in `index.js` |

## Try it

From the application checkout (Node.js 22+, `npm ci` completed):

```bash
npm run plugin:dev -- validate examples/log-inspector
npm start
```

Make a small non-sensitive fixture log (contains nothing real):

- macOS / Linux:

```bash
for i in 1 2 3; do echo "$(date -u +%FT%TZ) INFO demo line $i" >> /tmp/log-inspector-demo.log; done
echo "$(date -u +%FT%TZ) ERROR demo something broke" >> /tmp/log-inspector-demo.log
```

- Windows PowerShell:

```powershell
1..3 | ForEach-Object { Add-Content "$env:TEMP\log-inspector-demo.log" "$(Get-Date -Format o) INFO demo line $_" }
Add-Content "$env:TEMP\log-inspector-demo.log" "$(Get-Date -Format o) ERROR demo something broke"
```

Then in the app:

1. Open the Plugin Center (`Ctrl/Cmd+Shift+P`), load the development
   directory `examples/log-inspector`, review the package, install it and
   enable it for the current tab.
2. Run **Inspect a log file** with the fixture's absolute path and
   `keyword: demo`. The panel names the tab's target and shell (local or
   SSH), the file, the line counts and the keyword hits, followed by the
   recent lines.
3. Run it with a missing path or a file you cannot read: the file service's
   own message is shown instead of a generic failure.
4. Enable the plugin in a second tab and inspect a different file there:
   panels, returned text and the per-tab state history stay separate.
5. Cancel the tab's task mid-inspection or close the tab: the handler stops
   at the `ctx.signal` check, and the host releases everything — the plugin
   holds no resources of its own.

Re-import the development directory after editing any file: the host runs an
immutable reviewed snapshot, not a live view of your development files.

## Safety properties

- **Read-only:** the only host calls are `context.read`, `files.read`,
  `ui.publish` and `state.read/write`. Nothing is written to the log, no
  service is restarted, and nothing is sent to a model — there is no
  `terminal.execute` or `models.request` permission to misuse.
- **Bounded:** schema-validated input (1–200 lines, 80-char keyword),
  a 20 000-character panel cap and a 10-entry state history keep every
  artifact small.
- **Literal matching only:** keywords are counted case-insensitively as plain
  strings; no regex, so input can never turn into a pattern to execute.
- **Per-tab isolation:** state is scoped to one plugin instance and one tab
  by the host, and the panel always names the tab it belongs to. Conflicting
  state writes are re-read and retried, never overwritten blindly.

## Manifest checklist

- `engines.pluginApi: "^1.1.0"`, `aiterminal: ">=1.5.1"`.
- `permissions: ["files.read", "context.read"]` — exactly the two host APIs
  that need one here; `ui.publish` and `ctx.state` need none.
- One tool with a host-validated input schema; one `log` panel.
- `platforms` defaults to win32, linux and darwin; the license is Apache-2.0.

## Verify against the SDK types

`sdk.d.ts` is a copy of [`plugins/sdk/index.d.ts`](../../plugins/sdk/index.d.ts)
so editors pick up the real host types. The JSDoc annotation on
`exports.activate` types `ctx` as `PluginContext`, so a plain check compiles
the example against the SDK:

```bash
npx -y -p typescript@5.9 tsc --noEmit --allowJs --checkJs --target es2022 --module commonjs --moduleResolution node10 --strict examples/log-inspector/index.js
```

## Not supported on purpose

- No tail/follow and no scheduled polling: one bounded read per invocation.
- No whole-file scans: only the most recent lines are read into the panel.
- No path expansion beyond what the host file service already provides: the
  path must be absolute and valid for the tab's target (on a Windows local
  tab that is the host PowerShell's view; SSH targets see the remote view).
- No writes, no restarts, no model round-trips — and this example makes no
  request to be bundled into `plugins/catalog.json`; that needs its own
  review.
