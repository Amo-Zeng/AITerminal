# Changelog

All notable changes to AITerminal will be documented here.

## Unreleased

## 1.6.0 - 2026-11-07

- Publish verified Windows, Linux and macOS installers to GitHub Releases automatically after every successful trusted build. Stage uploads in a draft, verify all assets, and then update the latest download. Preserve published version tags and prevent older source builds from replacing newer downloads.
- Added OpenAI Responses and Anthropic Messages adapters alongside Chat Completions, with selectable/automatic endpoint formats, provider authentication, JSON/SSE responses, correlated multi-tool continuation and per-tab cancellation. Switching provider URLs clears the previous provider's key; the settings field now masks keys.
- Unified visible local terminals, AI takeover, interactive programs and plugin execution around the same captured terminal environment. Windows uses WSL Ubuntu throughout; local takeover starts from the visible shell's directory and rejects replaced backends.
- Added local-environment PTY smoke tests covering cwd, Unicode, AI commands, plugin files, interactive input and resize. Windows package verification now checks the shared environment module.
- Merged community PR #8 with an English per-tab state example, offline lifecycle fixes, bounded conflict retries and real plugin-process tests. Added linux.do community links while preserving README demo recordings.

## 1.5.1 - 2026-11-07

- Published the current desktop application and plugin host source under Apache-2.0 in the public AITerminal repository, preserving the original logo and existing public history.
- Added bilingual project and contribution documentation, an English plugin quickstart, a community roadmap, plugin/bug/feature issue forms and a pull request template. Public CI builds all three desktop platforms without private repository access or model credentials.
- Fixed the real Git plugin fixture on Windows by isolating Git configuration in an empty regular file; Git for Windows cannot read Node's device-null path as a configuration file.
- Fixed Windows PowerShell plugin execution mixing CLIXML progress into command output and collapsing native failure exit codes; added real Windows output/exit regressions.

- Added program-stop Webhooks for managed local/SSH commands, interactive PTYs and plugin execution, plus a “Run and notify” button for manual interactive programs. Reports success, failure, cancellation or unknown remote state without duplicating close events.
- Added per-source terminal keyword matching with incremental UTF-8/ANSI handling, case sensitivity, bounded buffers, cooldowns and opt-in redacted excerpts; settings are editable in the Webhook page.
- Added real Electron/HTTPS notification tests to the three-platform workflow and a bounded notification drain on graceful shutdown. Removed a duplicate Execute-button click listener.

- Added Terminal Pet (task reactions and interaction), Ops Quest (eight offline troubleshooting puzzles, hints and badges), and Git Time Machine (read-only timeline, project postcard and optional AI stories) to the bundled catalog.
- Added backward-compatible Plugin API 1.1 session state with per-tab/plugin ownership, a 32 KiB bound, revision conflict checks, idle-recycling persistence and disable/update/close cleanup.
- Added `allowTools: false` for text-only plugin model requests; Git stories send only bounded commit metadata and cannot dispatch takeover tools. Display current plugin panels before tool forms.
- Set UTF-8 output encoding for plugin commands in Windows PowerShell so native Git output matches the host decoder.
- Extended real Cordis/Electron tests for the new plugins, quiz UI, duplicate events/scoring, session-state lifecycle, actual Git commands and model request boundaries.

## 1.5.0 - 2026-11-07

- Added an AITerminal-owned plugin runtime with a pinned Cordis lifecycle, per-tab Electron utility processes, task scopes, cancellable service calls and automatic effect cleanup.
- Added v2 self-contained code packages, API/platform/dependency validation, immutable package snapshots, staged replacement, three-version history, connection/tab configuration, editable forms, task logs and declarative panels. Existing v1 JSON plugins remain supported.
- Added parameterized tools, native model tool-call handling with a text-protocol fallback, dynamic prompt providers, model adapters, dependency services, task events and Webhook delivery through host-held credentials.
- Added standard MCP clients for stdio and Streamable HTTP, stable tool identities and resource discovery/reading. The existing history index remains a separate context feature.
- Added Docker Workbench, task notification/logging and model policy plugins, plus a developer scaffold/package/validation CLI and SDK types.
- Added runtime, package, dependency, cancellation, native tool and MCP regressions. Three-platform CI now exercises the plugin runtime and the actual packaged utility-process bootstrap without enabling Electron RunAsNode.

## 1.4.0 - 2026-11-07

- Added a plugin center with search, built-in operations/CLI plugins, reviewed JSON and HTTPS imports, integrity checks, per-tab enable/disable, persistent defaults, updates and uninstall.
- Connected plugin instructions to tab-owned AI requests and plugin actions to the existing main-process command audit. Pending actions are cancelled when their plugin or terminal ownership changes.
- Extracted the AI HTTP client; fixed duplicated `/v1` paths, zero temperature, fragmented/final SSE events, truncated responses, and cancellation during rate-limit retries. Response size and deadline bounds prevent hanging or unbounded buffering.
- Recovered safely from malformed saved configuration and invalid terminal settings, preserving zero values for temperature and scrollback.
- Bound delayed SSH auto-login to its original tab and configuration so switching tabs during startup cannot redirect the connection or replace a manually started one.
- Fixed SSH direct-command quoting and child-shell exit-code capture, quoted tracked working directories, and rechecked plugin/session ownership after asynchronous path expansion.
- Added real Electron plugin/AI-context isolation checks to all three CI targets and expanded packaged-runtime verification for plugin assets.
- Made packaged-startup smoke cleanup terminate its owned Electron helpers and release output pipes instead of hanging after a successful launch.

## 1.3.1 - 2026-11-06

- Fixed tmux split-pane drift by preserving PTY line feeds and using Unicode 11 cell widths for CJK and emoji.
- Forwarded legacy binary mouse reports unchanged to SSH and local PTYs; SGR and legacy right-click/wheel reports now reach the owning terminal.
- Added right-click copy/paste and Shift override for application mouse mode; stopped wheel gestures from typing arrow keys in alternate screens without mouse tracking.
- Coalesced resize work per tab, synchronized xterm size changes with backends, and removed CSS rules that hid terminal columns behind the AI panel.
- Fixed macOS CI clipboard smoke navigation races by waiting for the actual renderer page and using isolated test profiles; moved builds to the supported macOS 15 runner.
- Added real Electron input tests and a tmux two-pane regression gate covering Unicode, render alignment, mouse, resize, and tab isolation.
- Updated Electron, DOMPurify, and build dependencies to security patch releases. Builds still start automatically on a normal push to main or release branches.

## 1.3.0

- Isolated SSH, local PTY, AI state, history, streaming output, takeover state, and resize behavior per tab.
- Added a real local PTY terminal with WSL Ubuntu as the Windows default.
- Added interactive AI control for Codex and other terminal applications.
- Added main-process execution-time command risk auditing and native confirmation for high-risk AI actions; renderer/model approval flags cannot bypass it.
- Hardened tab event routing so explicit event ownership wins over async context and unowned or closed-tab events are dropped.
- Added HTTPS Webhook notifications with event filtering, deduplication, and sensitive-data redaction.
- Restored the original application icon, exposed the Webhook URL controls, and added fingerprint-bound trusted-server execution to reduce repeated high-risk confirmations.
- Added encrypted credential storage, legacy plaintext migration, SSH host-key verification, and API transport restrictions.
- Replaced runtime CDN assets with pinned local dependencies and sanitized rendered AI content.
- Adopted Apache License 2.0 and removed the bytenode build path.
- Removed terminal, clipboard, AI response, and formula content from renderer diagnostic logs.
- Removed inline DOM event attributes, routed static/dynamic controls through `data-action` delegation, extracted the renderer to `renderer.js`, and removed CSP `script-src 'unsafe-inline'`.
- Upgraded DOMPurify to 3.4.13 to address published sanitizer advisories.
- Made tab creation explicit so late IPC cannot recreate a closed tab session.
- Added exclusive per-tab SSH handshake leases, cancellation of superseded connects, shell startup timeouts, stream error cleanup, and validated SSH resize dimensions.
- Fixed delayed renderer work after tab switches or closes: AI streaming panels, takeover/MCP flow state, clipboard/file actions, and menu file dialogs now retain their originating tab and fail closed when it disappears.
- Added regression coverage for bounded terminal dimensions and strengthened Doctor/Windows package gates for the new runtime isolation modules.
- Added deterministic release SBOM generation so root metadata uses the package identity instead of the private checkout directory name.
- Fixed packaged Electron startup by disabling the browser-specific V8 snapshot fuse when no browser snapshot is shipped and retaining the file protocol privileges required by the current `loadFile()` renderer.
- Restored parallel Windows, Linux, and macOS builds and added a packaged startup gate that waits for renderer and xterm readiness.
- Fixed macOS local terminal startup by restoring execute permissions on the `node-pty` spawn helper during locked dependency installation.
- Made Linux Electron PTY smoke tests run under Xvfb and made the Chromium renderer smoke stop on an explicit page result instead of timing out after success.
- Strengthened packaged Linux and macOS startup checks to require a successfully spawned local PTY in addition to renderer readiness.
- Updated Electron and the build dependency tree to audited versions; both runtime-only and full `npm audit` now report zero vulnerabilities.
- Restored terminal `Ctrl+Shift+C` / `Ctrl+Shift+V` clipboard shortcuts through the main process, added Enter-to-copy-and-clear for selections, and kept delayed clipboard work bound to its originating tab.
