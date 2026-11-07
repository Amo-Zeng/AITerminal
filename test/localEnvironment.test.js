'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createLocalEnvironment, terminalLaunch, terminalDirectory, executeInEnvironment, commandSpec } = require('../lib/localEnvironment');
const { shellSpec } = require('../lib/pluginServices');
const { quotePosix } = require('../lib/shellCommand');

test('Windows terminal, AI commands, interactive tools and plugins share the captured WSL distribution', () => {
    const variables = { AIT_TERMINAL_WSL_DISTRO: 'Ubuntu-Custom', AIT_TERMINAL_SHELL: 'C:\\Windows\\System32\\wsl.exe' };
    const environment = createLocalEnvironment({ platform: 'win32', env: variables });
    variables.AIT_TERMINAL_WSL_DISTRO = 'different';
    const terminal = terminalLaunch(environment), tracker = terminal.tracker;
    const record = `\x1b]777;aiterm-env;${tracker.token};123;${Buffer.from('/home/测试 user').toString('base64')};${Buffer.from('/bin/bash').toString('base64')}\x07`;
    let visible = ''; for (const char of `before${record}after`) visible += tracker.feed(char);
    assert.equal(visible, 'beforeafter'); assert.equal(tracker.pid, 123); assert.equal(environment.cwd, '/home/测试 user');
    const binding = { environment, cwd: '/home/测试 user', shell: 'posix' };
    for (const spec of [terminal, commandSpec(environment, 'uname -s'), commandSpec(environment, 'codex', environment.cwd, { interactive: true }), shellSpec(binding, 'pwd'), shellSpec(binding, 'codex', true)]) {
        assert.equal(spec.file, 'C:\\Windows\\System32\\wsl.exe'); assert.deepEqual(spec.args.slice(0, 2), ['-d', 'Ubuntu-Custom']); assert.equal(spec.cwd, undefined);
    }
    assert.ok(shellSpec(binding, 'codex', true).args.includes('-lic'));
    assert.throws(() => commandSpec(environment, 'pwd', 'C:\\Users\\test'), /Linux/);
});

test('native execution retains literal directories, Unicode, cwd changes, and exit codes', { skip: process.platform === 'win32' }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-env-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const nested = path.join(directory, "中文 ' $(echo unused)"); fs.mkdirSync(nested);
    const environment = createLocalEnvironment({ env: { ...process.env, AIT_TERMINAL_SHELL: '/bin/bash' }, cwd: directory });
    const result = await executeInEnvironment(environment, `cd ${quotePosix(nested)}\nprintf '中文😀'\nfalse # trailing comment`, directory);
    assert.equal(result.exitCode, 1); assert.equal(result.output, '中文😀'); assert.equal(result.cwd, nested);
    const next = await executeInEnvironment(environment, 'pwd', result.cwd);
    assert.equal(next.output, nested);
    const missing = await executeInEnvironment(environment, "printf 'must-not-run'", path.join(directory, 'missing'));
    assert.notEqual(missing.exitCode, 0); assert.doesNotMatch(missing.output, /must-not-run/);
    const exit = await executeInEnvironment(environment, 'exit 7', directory);
    assert.equal(exit.exitCode, 7);
});

test('directory lookup reads the terminal process after cd without sending input into it', { skip: process.platform !== 'linux' }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-cwd-'));
    const nested = path.join(directory, '目标 dir'); fs.mkdirSync(nested);
    const environment = createLocalEnvironment({ cwd: directory });
    const child = spawn('/bin/sh', ['-c', `cd ${quotePosix(nested)}; printf ready; read line`], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const session = { environment, cwd: directory, active: true, pty: { pid: child.pid } };
    assert.equal(await terminalDirectory(session), nested);
    assert.equal(session.cwd, nested);
    await assert.rejects(terminalDirectory(session, null, () => false), /关闭或变化/);
    assert.equal(child.exitCode, null, 'the visible shell still waits for its own input');
});

test('cancellation and backend replacement stop local commands before returning stale output', { skip: process.platform === 'win32' }, async () => {
    const environment = createLocalEnvironment();
    const controller = new AbortController();
    const promise = executeInEnvironment(environment, 'sleep 30', environment.cwd, { signal: controller.signal });
    const rejection = assert.rejects(promise, /取消/); controller.abort(); await rejection;
    let valid = true;
    const pending = executeInEnvironment(environment, 'sleep 30', environment.cwd, { valid: () => valid });
    const replaced = assert.rejects(pending, /变化/); valid = false; await replaced;
});
