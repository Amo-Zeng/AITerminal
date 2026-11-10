# Third-Party Notices

AITerminal includes the following direct runtime dependencies. Their full license texts are distributed in their npm packages and in Electron's generated license files where applicable.

| Package | Version | License |
| --- | --- | --- |
| @highlightjs/cdn-assets | 11.11.1 | BSD-3-Clause |
| @xterm/addon-fit | 0.10.0 | MIT |
| @xterm/addon-web-links | 0.11.0 | MIT |
| @xterm/addon-unicode11 | 0.9.0 | MIT |
| @xterm/xterm | 5.5.0 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| ajv | 8.20.0 | MIT |
| cordis | 4.0.0-rc.12 | MIT |
| DOMPurify | 3.4.17 | MPL-2.0 OR Apache-2.0 |
| KaTeX | 0.16.22 | MIT |
| marked | 15.0.12 | MIT |
| node-pty | 1.1.0 | MIT |
| Microsoft ConPTY (bundled by node-pty, Windows only) | 1.23.251008001 | MIT |
| ssh2 | 1.16.0 | MIT |
| semver | 7.7.4 | ISC |

The desktop runtime uses Electron 42.11.18, and packaging uses electron-builder 26.18.1; both are under the MIT License. Transitive dependencies retain their respective licenses. Run a complete license inventory from a clean `npm ci` installation before each release when the lockfile changes.
