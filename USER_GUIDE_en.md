# AITerminal user guide

[中文](USER_GUIDE.md) · [Installation](INSTALLATION.md#english) · [Documentation index](DOCUMENTATION.md) · [README](README_en.md)

## Two input areas

Type shell commands such as `pwd`, `ls`, `codex` or `tmux` directly in the **terminal**. Keyboard and mouse input goes to its running program.

The **bottom command/AI input** accepts questions and application commands: `cmd`, `fix`, `analyze`, `send`, `rfe` and `search`. Bare `ls` here is treated as an AI question; use `send ls` to send it to the shell. Local terminals and SSH need no model key. AI features require [provider configuration](AI_PROVIDERS.md); offline plugins such as Terminal Pet and Ops Quest do not.

## Local terminals, SSH and tabs

The app opens a local terminal. Windows uses WSL Ubuntu; Linux/macOS use a local shell. AI and plugins follow the same environment, including `/home/...` and `/mnt/c/...` paths on Windows.

Open SSH settings, enter host, port and username, and choose password or private-key authentication. Browse for a key and supply its passphrase if needed. Verify the SHA-256 host fingerprint on first connection. A changed host key blocks connection. Trusting a verified server reduces command confirmation prompts but never bypasses host-key changes.

Each tab owns its connection, output, AI configuration/history, takeover tasks and plugin instances. Closing a tab cleans up those resources; background responses remain with their originating tab.

## Multi-session workspaces

Use the horizontal/vertical split buttons to open an independent local terminal beside the current pane. Drag dividers to resize; double-click to restore equal sizes. Drag a session from the sidebar or tab strip onto an edge of another pane to rearrange it. Zoom shows one pane temporarily; detach moves it to a separate tab. Moving panes retains their xterm and PTY/SSH connection. Click a pane to direct keyboard input to it.

Search sessions by name or hostname; click a pane title to rename it. Saved SSH profiles appear under Connections and open in new sessions, without sending their startup commands automatically.

Save workspace stores the layout locally; Export layout writes JSON and Import layout opens it. Layouts contain session names, connection identities and pinned-panel references, without passwords, key contents, API keys, Webhook URLs, processes or commands. Hostnames, usernames and private-key paths can still appear; inspect before sharing. Restore appends new sessions and preserves existing ones. Local panes start new shells; SSH panes require manual reconnection. Old processes, working directories and tasks are not restored. Disconnected SSH panes also wait for reconnection instead of falling back to a local shell.

The bottom input labels its target and retains each session's draft and AI settings. The AI sidebar follows focus and can be resized. Pin a plugin panel to keep it visible with its original session ownership. Restoring a panel reference does not install/enable plugins or resume tasks; the user's existing defaults for new tabs still apply.

In a narrow workspace, the AI result panel moves below the terminals. Drag the divider to adjust its height, or focus it and use Up/Down; use Left/Right in the side-by-side layout. Resizing and SSH connection completion preserve focus in the AI message input.

Commands currently run per session; batch execution, keystroke broadcasting and AI orchestration across sessions remain planned. There is no commercial session quota, but usable scale depends on resources. Imported layouts are validated with limits of 512 sessions, 32 nesting levels and 1 MiB. See [workspace verification](WORKSPACE_VERIFICATION.md) for measured coverage.

### Minimal mode

Click Minimal mode in the header or press `Ctrl/Cmd+Shift+M`. The top tabs, terminals and compact bottom AI input remain visible; header menus, the sidebar, pane toolbars, status and pinned panels are hidden. The preference survives restart. Existing splits, connections, tasks, drafts and exclusive cursor focus remain intact.

Click a top tab to switch sessions and choose the terminal input/new-task target. The tab bar retains its new/close controls; there is no bottom session selector. Takeover and Stop remain available. AI replies open on demand in a floating panel without reducing terminal dimensions. The bottom expand button or the same shortcut restores the full interface. Session search (`Ctrl/Cmd+Shift+F`) and explicitly opening an `rfe` file panel restore the full layout.

On Windows/Linux, minimal mode also hides the native menu bar and restores it when you exit. The macOS system menu remains unchanged.

![Earlier SSH configuration and connection demo](https://raw.githubusercontent.com/Amo-Zeng/AITerminal/d586885dc0a4c94cc4d5543da8052aaea4209949/assets/ssh-connect.gif)

These recordings are preserved from the original README. UI layout and confirmation behavior have since changed; follow the current app and instructions.

## AI chat, diagnostics and command generation

| Input | Behavior |
| --- | --- |
| `How do I check Linux memory usage?` | Chat and follow-up questions; `ai` and `ask` prefixes also work |
| `fix` | Diagnose the current pane's text screen |
| `analyze` | Analyze the current text screen and suggest further checks if metrics are missing; no separate first-host collection |
| `cmd find files over 100 MB in the current directory` | Generate a shell command for review before execution |
| `send printf '%s\n' 'hello world'` | Send the shell payload with quotes/pipes intact through command auditing, without AI |
| `help` | Show in-app help |

Review generated commands and recommendations. Use AI takeover for multi-step execution. Understand which terminal output and system information you send to your configured model service.

AI replies default to a split view; AI settings also offer terminal output. The split view supports streaming, Markdown, syntax highlighting, math and conversation history. Custom answer requirements, such as “keep replies concise,” are configurable alongside the model and temperature.

![Earlier streaming and split-view AI demo](https://raw.githubusercontent.com/Amo-Zeng/AITerminal/d586885dc0a4c94cc4d5543da8052aaea4209949/assets/ai-streaming.gif)

## AI takeover and interactive tools

Describe a task, then click Current terminal takeover. For example, ask it to diagnose failed tests, fix the cause and rerun them. You can pause, answer questions, add instructions or retry from a fresh screen read. Advanced mode also supports the existing context compression workflow.

The default **Current terminal** mode reads the selected pane's text screen and sends input to the same stream. A task stays in the pane selected at submission even if you focus another pane. This includes SSH inside SSH and the active tmux pane or interactive program. It does not run a separate command on the first SSH host. It reads terminal characters, not images or graphical desktops; host identity and foreground state must still be inferred from the text.

Task logs appear in the AI sidebar to preserve Codex/Vim screens. Manual input in the original pane pauses AI without moving keyboard focus. Pause does not send Ctrl+C to the foreground program. Resume with a new instruction; retries reread the screen instead of replaying input. Closing, reconnecting or replacing the backend invalidates late responses and approvals. The original goal and latest correction stay in context, with bounded recent history and a pause after 40 automatic steps. High-risk input and alternate-screen Enter require confirmation; trust in the first SSH host does not extend to an unknown inner session.

Select **Advanced · Host and plugins**, or use `local:`, `remote:` or `hybrid:`, for the existing host tools, independent processes, plugin model adapters and context compression. This mode does not reliably follow nested SSH. SFTP and plugin background services use the directly connected host; local services use the terminal's distribution but separate processes and state. Use `terminal:` to explicitly select screen control. Programs must be installed in the actual target environment, including WSL Ubuntu for the Windows local terminal. `search keyword` searches the advanced takeover history index, distinct from standard MCP integrations.

See [AI takeover](AI_TAKEOVER_MODE_README.md) for targets, interaction and permissions. The working directory is not a sandbox, and cancelling a task does not undo executed changes.

## Remote file transfer and browsing

These features require SSH in the current tab and operate on the directly connected host, not a second SSH session inside the terminal. Use the local shell and file manager on local tabs.

- **Upload:** drag local files from your system file manager into the terminal or bottom input. Files go to the current SSH directory. The upload button also opens a file picker.
- **`rfe [path]`:** open an SFTP file pane below its terminal, which remains usable. Click directories to navigate, files to download and open locally, or the download arrow to choose a save location. Omitting the path queries the current remote directory. Quote paths with spaces, such as `rfe "/home/user/my logs"`. The pane's file button starts from the SSH default directory.
- **Terminal `ls`:** click a filename matching the directly connected SSH directory to fetch a temporary local copy and open it in your default application, without a save dialog. Spaces, CJK, emoji and wrapped names are supported. Downloads do not write into the terminal. Executable files retain the existing opening confirmation; use the download arrow in `rfe` if you only want to save a file.
- **Download:** the download control also accepts a remote file path. Download-and-open brings a file to your computer; it does not launch a local viewer on the remote host.

Try these in the bottom input:

```text
rfe /var/log
rfe /home/your-user/Pictures
```

Replace the second path with an existing image/document directory on your server, then click a filename to download and open it.

`myls` has been removed. File links and `rfe` use the directly connected SSH host, not nested SSH/tmux; filename links are disabled in alternate screens and mouse-tracking modes. Matching uses the directory tracked by the app: use `cd` then `ls`, or `rfe` with an explicit path for another directory. Use `rfe` for filenames containing newlines. Switching tabs preserves the download target; reconnecting or changing directory invalidates old links.

Uploads use the SSH user's permissions and may overwrite same-named files. Check the destination, especially when a tmux pane's directory differs from the SSH directory tracked by the app.

## Saved commands, automatic login and profiles

Enter one shell command per line in common-command settings. Type `/` in the bottom input, filter by text, select a command and press Enter to send the resulting `send ...` payload. Arrow keys select entries and Escape dismisses the list.

Remembered authentication enables automatic SSH login on launch. Passwords and passphrases use platform encryption and remain session-only when secure storage is unavailable. Host fingerprints are still checked. Post-login commands run one line at a time after successful connection; enter only commands you intend to run every time, such as `cd /var/www`.

The configuration dialog can save, load and delete named profiles. Profiles contain non-secret settings. Supply the matching key when changing model endpoints. AI runtime settings remain scoped to the tab where they were configured.

File → Save session / Load session exports/imports a JSON **configuration**, not running processes, SSH connections, screen contents or AI conversation history. Passwords, key passphrases, model keys and Webhook URLs are excluded. Review imported settings in the configuration dialog before saving/connecting; configure credentials again on a new computer. Exported files may still contain hostnames, usernames and paths.

This single-configuration export differs from Save workspace in the top-right toolbar; use workspace layouts to reopen multiple panes.

## Appearance and shortcuts

Version 1.7.1 adopts the cyan/indigo, rounded-card design from `beauty.html`, with a new `A>` icon on all platforms. Only the terminal with keyboard focus displays a cursor. Unfocused panes, AI composition, dialogs and inactive application windows show no terminal cursor. Disabling cursor blink keeps a steady cursor in the focused terminal. The selected session still determines the AI submission target; cursor appearance does not indicate whether a background task is running.

Terminal settings include font, size, theme, cursor shape (block/underline/bar), cursor blink and scrollback lines. Resizing adjusts the visible terminal and updates background tabs when they become visible.

| Action | Result |
| --- | --- |
| `Ctrl+Shift+C/V` | Copy selected terminal text / paste; `Cmd+Shift+C/V` also works |
| Enter with terminal text selected | Copy and clear selection without sending Enter to the shell |
| Right click | Copy a selection, otherwise paste |
| Shift+right click | Use the local clipboard even when an application tracks mouse input |
| `Ctrl/Cmd+Shift+P` | Open the Plugin Center |
| `Ctrl/Cmd+Shift+E` | Split left/right beside the current pane |
| `Ctrl/Cmd+Alt+Shift+E` | Split top/bottom beside the current pane |
| `Ctrl/Cmd+Shift+Left/Right` | Focus the previous/next pane in the split group |
| `Ctrl/Cmd+Shift+F` | Search sessions |
| `Ctrl/Cmd+Shift+M` | Toggle minimal mode |
| Arrow keys / Home on a focused divider | Adjust the ratio / restore equal sizes; dragging and double-clicking also work |
| `set -g mouse on` in tmux | Enable tmux mouse handling |

When tmux/Vim tracks the mouse, that application receives ordinary mouse and wheel events; its behavior differs from scrolling terminal history.

## Plugins and notifications

The Plugin Center supports installation previews, per-tab enablement/configuration, custom HTTPS catalogs and version recovery. Extend tools, prompts, panels, events, models and MCP. The 10 bundled examples include Docker Workbench, Git Time Machine, Terminal Pet and Ops Quest. See [plugin usage](PLUGINS.md), the [English quickstart](PLUGIN_QUICKSTART.md) and [SDK](PLUGIN_SDK.md).

Configure a Webhook HTTPS URL, enable the desired events and test delivery. Notifications cover AI task results, normal/abnormal program exits and matching terminal output. Use “Run and notify” for manual commands that need exit notifications. Keyword matching supports case sensitivity and cooldowns. See [Webhooks](WEBHOOKS.md) for exact coverage; an app that is forcibly killed or a computer that loses power cannot itself send a later network notification.

## Support

[Installation troubleshooting](INSTALLATION.md#english) · [GitHub Issues](https://github.com/Amo-Zeng/AITerminal/issues) · [1019191262@qq.com](mailto:1019191262@qq.com) · QQ group **1053768305**. Include app/OS versions, the target environment and reproduction steps, with redacted errors.
