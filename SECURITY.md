# Security Policy

## Reporting

Please use [private vulnerability reporting](https://github.com/Amo-Zeng/AITerminal/security/advisories/new) for this repository. Reports in Chinese or English are welcome. Do not open a public issue with exploit details, credentials, host information, or terminal output containing sensitive data.

Include the affected version, platform, reproduction steps, impact, and any suggested mitigation. Maintainers will acknowledge a complete report as soon as practical and coordinate disclosure after a fix is available.

## Security Model

AITerminal can run commands with the permissions of the current local or SSH user. A selected local directory is the initial working directory, not a sandbox. The command audit asks for confirmation before recognized high-risk AI actions, but it is defense in depth and cannot prove that arbitrary shell code is harmless.

Webhook notifications only support HTTPS. Sensitive fields are redacted; command text and terminal excerpts are omitted by default. Generic redaction cannot recognize every business secret. Delivery cannot be guaranteed after network loss or a forced application/OS shutdown. Users remain responsible for protecting API keys, SSH credentials, webhook URLs, and exported configuration.

Code plugins run in separate processes for lifecycle and fault isolation, with the host user's permissions. This is not an operating-system security sandbox: arbitrary Node.js plugin code is not constrained solely by its declared SDK capabilities. Review source and install trusted plugins only. Host-provided execution services preserve tab/task ownership, command auditing and cancellation; host-held model and Webhook credentials are not returned through the SDK. MCP servers are separate programs or services with their own trust boundary.

Security fixes target the current source and latest maintained release. Historical installers may lack current protections; include the exact version or commit in reports. The public CI checks locked dependencies and source-to-package consistency, but unsigned desktop artifacts do not provide platform code-signing identity.

The trusted-server option suppresses repeated high-risk command confirmations only for the active SSH stream whose host, port, username, and verified host-key fingerprint match the selected server. It never applies to local execution, and a changed host key still blocks the connection until the user verifies and explicitly accepts the new fingerprint.

Stored credentials are kept by Electron `safeStorage` when the platform provides a real encrypted backend. The application refuses Electron's `basic_text` fallback and keeps credentials session-only until secure storage is available. SSH host keys are stored in an application-managed `known_hosts` file under the Electron user-data directory; first use and key changes require explicit confirmation.

The API base URL must use HTTPS, with HTTP permitted only for loopback services such as `localhost`, `127.0.0.1`, and `::1`. Local terminals require the packaged `node-pty` native module so interactive programs are not silently run through a non-TTY pipe.
