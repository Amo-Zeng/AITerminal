'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const { createLocalEnvironment, terminalLaunch, terminalDirectory, commandSpec, executeInEnvironment } = require('../lib/localEnvironment');
const { createPluginServices } = require('../lib/pluginServices');
const { quotePosix } = require('../lib/shellCommand');

async function waitFor(check, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${label}`);
}
async function main() {
    const pty = require('node-pty');
    const environment = createLocalEnvironment();
    const launch = terminalLaunch(environment);
    const terminal = pty.spawn(launch.file, launch.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: launch.cwd, env: environment.env });
    const session = { environment, cwd: environment.cwd, environmentTracker: launch.tracker, pty: terminal, active: true };
    let output = '', directory, interactive, interactiveEnded = false;
    terminal.onData(data => { output += launch.tracker ? launch.tracker.feed(data) : data; });
    terminal.onExit(() => { session.active = false; });
    try {
        const initial = await terminalDirectory(session);
        const created = await executeInEnvironment(environment, 'mktemp -d /tmp/aiterm-env-smoke.XXXXXXXX', initial);
        assert.equal(created.exitCode, 0); directory = created.output;
        assert.match(directory, /^\/tmp\/aiterm-env-smoke\.[A-Za-z0-9]+$/);
        // Change the actual visible terminal, then read cwd without injecting pwd.
        terminal.write(`cd -- ${quotePosix(directory)}\r`);
        await waitFor(async () => {
            const actual = await terminalDirectory(session);
            return actual === directory || (!environment.wsl && actual === fs.realpathSync(directory));
        }, 'visible terminal cd');
        const result = await executeInEnvironment(environment, 'uname -s; printf "中文😀\\n"; pwd', directory);
        assert.equal(result.exitCode, 0); assert.match(result.output, /中文😀/); assert.ok(result.output.endsWith(directory));
        if (process.platform === 'win32') assert.match(result.output, /^Linux\n/);
        const binding = { target: 'local', shell: 'posix', environment, cwd: directory, valid: () => session.active, resolveCwd: () => terminalDirectory(session) };
        const service = createPluginServices({ capture: () => binding, approve: async () => true, getPty: () => pty });
        const task = { binding, valid: binding.valid, signal: new AbortController().signal, disposables: new Set() };
        assert.equal((await service({}, 'files.write', { path: 'note.txt', text: 'Ubuntu/Unix 中文' }, task)).exitCode, 0);
        assert.equal((await service({}, 'files.read', { path: 'note.txt' }, task)).output, 'Ubuntu/Unix 中文');
        const spec = commandSpec(environment, 'printf "ENV_PROMPT>"; read -r answer; printf "\\nENV_REPLY:%s\\n" "$answer"', directory, { interactive: true });
        interactive = pty.spawn(spec.file, spec.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: spec.cwd, env: spec.env });
        let repl = '', ended = false, code;
        interactive.onData(data => { repl += data; }); interactive.onExit(exit => { ended = true; interactiveEnded = true; code = exit.exitCode; });
        await waitFor(() => repl.includes('ENV_PROMPT>'), 'interactive prompt');
        interactive.resize(120, 35); interactive.write('交互成功\r');
        await waitFor(() => ended, 'interactive exit'); assert.equal(code, 0); assert.match(repl, /ENV_REPLY:交互成功/);
        console.log(JSON.stringify({ success: true, platform: process.platform, terminalSystem: environment.platform, terminal: environment.label, shell: environment.shellFile, visibleCwd: directory, aiExec: true, pluginFiles: true, interactiveInputAndResize: true }));
    } finally {
        if (interactive && !interactiveEnded) { try { interactive.kill(); } catch {} }
        if (directory) await executeInEnvironment(environment, `rm -f -- ${quotePosix(directory + '/note.txt')}; rmdir -- ${quotePosix(directory)}`, '/tmp').catch(() => {});
        if (session.active) {
            try { terminal.write('exit\r'); await waitFor(() => !session.active, 'terminal exit'); }
            catch { try { terminal.kill(); } catch {} }
        }
    }
}
if (process.versions.electron) {
    const { app } = require('electron');
    app.whenReady().then(main).then(() => app.exit(0), error => { console.error(error.message); app.exit(1); });
} else main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
