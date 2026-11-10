<p align="center"><img src="build/icon.png" alt="AITerminal logo" width="112"></p>

# AITerminal

[中文](README.md) · [Downloads](https://github.com/Amo-Zeng/AITerminal/releases/latest) · [Installation](INSTALLATION.md#english) · [User guide](USER_GUIDE_en.md) · [Documentation](DOCUMENTATION.md) · [Plugin quickstart](PLUGIN_QUICKSTART.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Cross-platform build](https://github.com/Amo-Zeng/AITerminal/actions/workflows/windows-build.yml/badge.svg)](https://github.com/Amo-Zeng/AITerminal/actions/workflows/windows-build.yml)

**Use AI to operate local computers and remote servers, and turn your operations knowledge into plugins.**

AITerminal is an open-source desktop terminal built with Electron, xterm.js and SSH2. It combines local PTYs, SSH, AI conversations, interactive command execution and a Plugin Center. The source is licensed under **Apache License 2.0** and runs on Windows, Linux and macOS.

## Try these workflows

| Situation | What to do |
| --- | --- |
| You connected through a jump host and want AI to continue on the inner SSH host | Select that pane, keep the default Current terminal mode and describe the task. AI reads its text screen and types into the same stream; changing pane focus does not move the task |
| Codex / Claude Code will take a while | Start it with Run and notify, configure a Webhook for completion or abnormal exits, and use output keywords for situations that need attention |
| A server produced an image or report | Use `rfe path` on the directly connected SSH host, then click the file to download and open it locally |
| Your team repeats the same diagnostics | Package the workflow as a parameterized tool, panel or MCP integration. Enable it per session and pin its panel to the workspace |

Notifications require the app to remain running; a disconnected remote process has an unknown state. File services and plugin background tools use the directly connected host, not a nested SSH session. See [takeover](AI_TAKEOVER_MODE_README.md) and [notification details](WEBHOOKS.md).

## Demos

**Workspace and minimal mode:** cyan/indigo accents and rounded terminal cards, with independent terminals and a plugin panel pinned to its session. Version 1.7.2 adds minimal mode (`Ctrl/Cmd+Shift+M`): terminals and a compact AI input, with session switching, replies on demand and a saved preference. Only the pane with actual keyboard focus displays a terminal cursor; composing AI messages, opening dialogs or switching away from the app stops terminal blinking. These are real application screenshots showing local tests and plugin example validation.

![Dark workspace with three independent terminals and a pinned Terminal Pet panel](assets/workspace-dark.png)

**Minimal mode:** keep your splits and connections, with terminals and the bottom AI input filling the window.

![Minimal mode: full-area terminals with a compact session selector and AI input](assets/workspace-minimal.png)

<details>
<summary>Light appearance</summary>

![Light workspace](assets/workspace-light.png)

</details>

**Plugin Center:** a real screenshot of the offline Ops Quest panel. Try a plugin without a model key, then use the SDK to create your own tools and panels.

![Plugin Center showing the catalog, session ownership and Ops Quest panel](assets/plugin-center.png)

These recordings from earlier versions show the application in use. The current UI, tab isolation and command confirmation flow have since been updated; follow the current application and documentation for exact behavior.

**Natural language to commands**: ask to find files larger than 100 MB, review the suggested command and execute it when needed.

![Natural language to commands: enter a request, review the suggestion and execute it](https://raw.githubusercontent.com/Amo-Zeng/AITerminal/d586885dc0a4c94cc4d5543da8052aaea4209949/assets/ai-cmd.gif)

<details>
<summary>More demos: AI takeover, AI chat, file transfers and terminal themes</summary>

**AI takeover (2× speed)**: ask the AI to build a webpage about general relativity, let it carry out the development task and request further changes.

![AI takeover: create and refine a webpage from a natural-language request, at 2× speed](https://raw.githubusercontent.com/Amo-Zeng/AITerminal/d586885dc0a4c94cc4d5543da8052aaea4209949/assets/agent_2x.gif)

**AI chat and suggestions**: ask how to check Linux memory usage and receive explanations with command examples.

![AI chat: ask about Linux memory usage and read the response](https://raw.githubusercontent.com/Amo-Zeng/AITerminal/d586885dc0a4c94cc4d5543da8052aaea4209949/assets/ai-chat.gif)

**Drag-and-drop file transfers**: drag a local file into a connected SSH terminal, then browse and download remote files.

![File transfers: upload by dragging, then browse and download remote files](https://raw.githubusercontent.com/Amo-Zeng/AITerminal/d586885dc0a4c94cc4d5543da8052aaea4209949/assets/drag-upload.gif)

**Terminal themes**: adjust fonts and colors to suit your preferred terminal appearance.

![Terminal appearance: switch color themes in the configuration dialog](https://raw.githubusercontent.com/Amo-Zeng/AITerminal/d586885dc0a4c94cc4d5543da8052aaea4209949/assets/terminal-themes.gif)

</details>

## Features

- Native multi-session workspaces: split local and different SSH terminals horizontally or vertically, resize/rearrange/zoom panes, search sessions and save/import/export layouts, without a commercial session quota.
- Local and SSH terminals with real PTY support for Codex, Vim, tmux and other interactive tools.
- AI chat, `fix` diagnostics, `analyze` system analysis and `cmd` natural-language commands; streaming replies, split views, Markdown, code highlighting, math rendering and custom answer requirements.
- Password/key SSH login, drag-and-drop uploads and `rfe` remote browsing/downloads. Filenames in ordinary `ls` output that match the directly connected SSH directory can be clicked to download. Use `send` for shell commands and `/` for saved commands.
- Configuration profiles, session configuration import/export, remembered authentication, automatic login and startup commands; configurable themes, fonts, cursor and scrollback.
- Independent connections, AI settings/history, execution state, output, plugins and terminal dimensions for every tab.
- AI operations on local, remote or mixed targets; confirmation before recognized high-risk commands, with optional trust for a verified SSH server identity.
- `Ctrl+Shift+C/V` clipboard shortcuts and Enter to copy and clear a selection. Right click copies a selection or pastes; tmux/Vim mouse tracking receives mouse/wheel input, with Shift+right click for the local clipboard. Enable tmux mouse mode with `set -g mouse on`.
- HTTPS Webhooks for task results, program exits and output keyword matches. Use “🔔 Run and notify” for manual interactive commands. Case sensitivity, cooldowns and redacted excerpts are configurable; see [notification details](WEBHOOKS.md).
- A Plugin Center with parameterized tools, model adapters, standard MCP, task events, panels, configuration, catalogs and version recovery. Pin panels to the workspace while keeping their original session ownership. Code plugins use dedicated processes and a Cordis lifecycle.
- SSH host fingerprint verification and platform-encrypted storage for SSH credentials, model API keys and Webhook URLs.

AI defaults to the terminal selected when you submit the task: it reads that text screen and types into the same stream, including nested SSH and existing interactive programs. Changing focus does not retarget a running task. Windows local terminals default to **WSL Ubuntu**; Linux/macOS use their local shell. Advanced host/plugin execution uses separate services and does not reliably follow nested SSH; see [takeover modes](AI_TAKEOVER_MODE_README.md).

### Everyday commands

Enter these in the bottom command/AI input. Typing inside the terminal goes directly to its shell.

| Input or action | Purpose |
| --- | --- |
| `How do I check Linux memory usage?` | AI chat; `ai` and `ask` prefixes also work |
| `cmd find files larger than 100 MB in the current directory` | Generate a command for review before execution |
| `fix` / `analyze` | Diagnose/analyze the current text screen; suggest additional checks when metrics are missing |
| `send ls -lah` | Send a command to this tab's local or SSH shell, without a model key |
| `/` | Search saved commands, select one and press Enter to send |
| `rfe /var/log` | Browse/download SSH files or download and open them locally; filenames in terminal `ls` output can also be clicked to download |
| `search keyword` | Search this tab's advanced takeover history index |
| AI takeover / Plugin Center / Run and notify | Multi-step tasks, plugin tools and program-exit notifications |
| Horizontal/vertical split / Save workspace | Show independent terminals together and save their layout; reopening creates new sessions and requires manual SSH reconnection |

See the [user guide](USER_GUIDE_en.md) for detailed instructions, shortcuts and additional original recordings.

## Install

Download an **AITerminal** package from the [latest release](https://github.com/Amo-Zeng/AITerminal/releases/latest) and verify `SHA256SUMS.txt`. **1.7.2** adds minimal mode and makes filename download links independent of the removed `myls` command. Light/dark themes, native splits, workspaces, plugins, nested SSH control and automatic Release publishing remain available.

| Platform | Package | Requirements |
| --- | --- | --- |
| Windows x64 | `.exe` installer | WSL and a distribution named `Ubuntu` for the local terminal; run `wsl --install -d Ubuntu` in an administrator terminal and finish Ubuntu initialization |
| Linux x64 | `.AppImage` | Make the file executable; use FUSE or AppImage extraction mode |
| macOS Apple Silicon | `.dmg` | Current CI builds are arm64, unsigned and not notarized; verify the source before allowing launch through system settings |

There is no iOS `.ipa` target. Packaged applications do not require Node.js.

### macOS: “AITerminal is damaged and can't be opened”

The current macOS package is unsigned and not notarized, which can trigger a quarantine warning. Download from this repository's Releases, verify `SHA256SUMS.txt`, then drag the app into Applications. If macOS still reports damage or an unverified developer, run this in the macOS Terminal:

```bash
sudo xattr -r -d com.apple.quarantine /Applications/AITerminal.app
```

Open the app again. This removes the quarantine attribute from this app only; it does not repair corrupted downloads. Re-download if the checksum differs, and adjust the path if installed elsewhere. See [installation and troubleshooting](INSTALLATION.md#english) for all three platforms.

Open a local terminal or configure SSH. For AI features, supply your model API endpoint, model name and key. AI settings support **Chat Completions** (`/v1/chat/completions`), **Responses** (`/v1/responses`) and **Messages** (`/v1/messages`). Select a format or use a full endpoint for automatic detection; see [Model API configuration](AI_PROVIDERS.md). Open the Plugin Center from the top-right button or `Ctrl/Cmd+Shift+P`. Terminal Pet and Ops Quest work without model credentials or a server connection.

## Build the plugin ecosystem with us

Contribute operations tools, interactive CLI helpers, model adapters, MCP integrations, teaching plugins, documentation or tests. AITerminal owns its package format and SDK, drawing inspiration from DeepSeek Harness and using Cordis internally. Existing DSH/Cordis plugins need service-level adaptation; see the [SDK guide](PLUGIN_SDK.md).

| Bundled examples | What to explore |
| --- | --- |
| System health, Docker, Git review, interactive CLI | Declarative instructions and static commands |
| [Docker Workbench](plugins/docker-tools/index.js) | Parameterized tools, inspections and interactive logs |
| [Task Notifier](plugins/task-notifier/index.js), [Model Policy](plugins/model-policy/index.js) | Task events, Webhooks and model adapters |
| [Terminal Pet](plugins/terminal-pet/index.js), [Ops Quest](plugins/ops-quest/index.js) | Offline panels, session state and events |
| [Git Time Machine](plugins/git-time-machine/index.js) | Read-only Git timelines and optional AI stories |

Start with the [contribution guide](CONTRIBUTING.md), try the [plugin quickstart](PLUGIN_QUICKSTART.md), or open a [plugin proposal](https://github.com/Amo-Zeng/AITerminal/issues/new?template=plugin_proposal.yml). The [roadmap](ROADMAP.md) lists concrete collaboration opportunities. Small examples, translations and reproducible bug reports are welcome.

## Run from source

Use Node.js 22+, npm, and native module build tools if prebuilt modules are unavailable. Do not share `node_modules` between operating systems.

```bash
git clone https://github.com/Amo-Zeng/AITerminal.git
cd AITerminal
npm ci
npm start
```

Create a plugin outside the checkout:

```bash
npm run plugin:dev -- new ../hello-aiterminal example.hello
npm run plugin:dev -- validate ../hello-aiterminal
npm run plugin:dev -- pack ../hello-aiterminal ../example.hello.aitplugin.json
```

Load its development directory in the Plugin Center, preview the installation, enable it for one tab and run the greeting tool. Re-import after changing the development files.

## Test and build

```bash
npm test
npm run security:scan
npm run doctor
# Select the command for the target operating system:
npm run build:win
npm run build:linux
npm run build:mac:unsigned
```

The public [Actions workflow](https://github.com/Amo-Zeng/AITerminal/actions/workflows/windows-build.yml) builds all three platforms for pull requests, pushes to `main` / `release/**`, `v*` tags and manual runs. Fork owners can enable Actions in their repositories; no private build repository or model key is required. Checks include locked dependencies, tests, audits, real Electron/plugin/notification smoke tests, source-to-package verification and actual packaged startup. Successful non-PR builds in the main repository automatically publish installers, checksums and platform SBOMs to Releases after verifying every upload. Actions artifacts expire after 14 days; use Releases for durable downloads.

See [Contributing](CONTRIBUTING.md) for focused smoke tests and [Releasing](RELEASING.md) for the optional maintainer build helper.

## Documentation and security

[Documentation index](DOCUMENTATION.md) · [Installation and troubleshooting](INSTALLATION.md#english) · [User guide](USER_GUIDE_en.md)

[AI takeover](AI_TAKEOVER_MODE_README.md) · [Plugin usage](PLUGINS.md) · [SDK reference](PLUGIN_SDK.md) · [Notifications](WEBHOOKS.md) · [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Open-source checks](OPEN_SOURCE_AUDIT.md)

AITerminal executes with the current local or SSH user's permissions. A working directory, command audit or separate plugin process is not an operating-system sandbox. Enable trusted plugins only. Credentials remain session-only when secure storage is unavailable. Report vulnerabilities through [private security reporting](https://github.com/Amo-Zeng/AITerminal/security/advisories/new), following the [security policy](SECURITY.md); do not post keys or sensitive terminal output in public issues. Participants follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Contact and support

- [GitHub Issues](https://github.com/Amo-Zeng/AITerminal/issues) for bugs and feature requests; [Discussions](https://github.com/Amo-Zeng/AITerminal/discussions) for questions and plugin ideas.
- **Email**: [1019191262@qq.com](mailto:1019191262@qq.com)
- **QQ group**: 1053768305

Include the app version, OS/architecture, local/WSL/SSH environment, reproduction steps and redacted errors or screenshots. For installation problems, include the downloaded filename. Report security issues privately following the [security policy](SECURITY.md).

## Acknowledgments

- The [linux.do community](https://linux.do/) for discussion, feedback and support.
- [lorsque](https://github.com/lorsque-sir) for reporting the macOS installation issue and sharing the `xattr` workaround above.
- **Jasonvip** for reporting that dragging the app into **Sentinel** resolved the launch problem. This preserves the original community report; its tool version and behavior have not been reverified. The explicit app-specific command above remains available.
- [painbaba](https://github.com/painbaba) for English plugin examples, and everyone contributing code, plugins, tests and feedback.

## License

Copyright © Amo Zeng and AITerminal contributors. Licensed under the [Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses; see [Third-Party Notices](THIRD_PARTY_NOTICES.md).
