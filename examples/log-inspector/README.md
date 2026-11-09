# Log Inspector — a read-only file example (Plugin API 1.1)

A small read-only plugin that inspects a log file you name: it shows the most
recent lines, counts a literal keyword, and publishes a plain-text panel. It
needs an active local terminal or SSH connection, but no model key. It does not
modify the inspected file. Local use needs no server.

This example uses `ctx.files.read`, which reads the file through the host and
fails if command output exceeds **1 MiB**. It then selects recent lines in
memory. It is for small text files, not efficient tailing of large production logs.

## What it shows

| Teaching point | Where |
| --- | --- |
| Read-only host access: `ctx.files.read` + the `files.read` permission | `index.js`, `plugin.json` |
| Input validated by the manifest schema before the handler runs | `inputSchema` of the `inspect` tool |
| Bounded output: last N lines, metadata included in the 20 000-character cap, and a JSON byte cap | `MAX_LINES` / `MAX_CHARS` in `index.js` |
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

- macOS / Linux / Windows WSL Ubuntu (run in the visible local terminal):

```bash
printf '%s\n' 'INFO demo line 1' 'INFO demo line 2' 'INFO demo line 3' 'ERROR demo something broke' > /tmp/log-inspector-demo.log
```

On Windows the visible terminal and plugin run in the same WSL Ubuntu
environment. Use `/tmp/log-inspector-demo.log` there; Windows files use
`/mnt/c/...` paths. A host PowerShell `$env:TEMP` path is not a WSL path.

Then in the app:

1. Open the Plugin Center (`Ctrl/Cmd+Shift+P`), load the development
   directory `examples/log-inspector`, review the package, install it and
   enable it for the current tab.
2. Run **Inspect a log file** with the fixture's absolute path and
   `keyword: demo`. The panel names the tab's target and shell (local or
   SSH), the file, the line counts and the keyword hits, followed by the
   recent lines. Counts refer to text actually displayed; when a long line is
   trimmed the panel says that its first visible line may be partial.
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
  service is restarted, and the plugin makes no model requests. When an AI
  task invokes the tool, its caller receives summary metadata (path and counts),
  not log content. Manifest permissions describe SDK calls; arbitrary plugin
  code still has the host user's privileges and is not an OS sandbox.
- **Bounded:** schema-validated input (1–200 lines, 80-char keyword),
  a 20 000-character / 60 000-byte serialized panel cap and at most 10 state
  summaries (30 000 serialized bytes) keep output within host limits. Unrelated
  state-write failures are reported; only changed revisions are retried.
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

- No tail/follow or scheduled polling. Each invocation reads a small whole file
  with the host output limit, then displays its recent lines. Oversized reads fail.
- No path expansion beyond what the host file service already provides: the
  path must be absolute and valid for the tab's target (on a Windows local
  tab that is WSL Ubuntu's view; SSH targets see the remote view). Windows-style
  paths are accepted only by an explicitly bound PowerShell host integration.
- No writes, no restarts, no model round-trips — and this example makes no
  request to be bundled into `plugins/catalog.json`; that needs its own
  review.
