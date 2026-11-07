'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    findPackagedExecutable,
    hasRendererReadyOutput,
    hasPackagedRuntimeReadyOutput,
    terminateProcessTree
} = require('../scripts/packageStartupSmoke');

test('finds deterministic packaged executable paths for every target platform', (t) => {
    const releaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiterminal-package-smoke-'));
    t.after(() => fs.rmSync(releaseDirectory, { recursive: true, force: true }));
    const paths = {
        win32: path.join(releaseDirectory, 'win-unpacked', 'AITerminal.exe'),
        linux: path.join(releaseDirectory, 'linux-unpacked', 'aiterminal'),
        darwin: path.join(releaseDirectory, 'mac', 'AITerminal.app', 'Contents', 'MacOS', 'AITerminal')
    };
    for (const executable of Object.values(paths)) {
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(executable, 'fixture');
    }
    for (const [platform, executable] of Object.entries(paths)) {
        assert.equal(findPackagedExecutable(releaseDirectory, platform), executable);
    }
});

test('requires the renderer initialization completion signal', () => {
    assert.equal(hasRendererReadyOutput('[INFO:CONSOLE] App initialization complete'), true);
    assert.equal(hasRendererReadyOutput('ERR_FILE_NOT_FOUND'), false);
    assert.equal(hasRendererReadyOutput('Error loading V8 startup snapshot file'), false);
});

test('packaged Unix startup also requires a working local PTY', () => {
    const renderer = '[INFO:CONSOLE] App initialization complete';
    const pty = 'Local PTY session ready';
    assert.equal(hasPackagedRuntimeReadyOutput(`${renderer}\n${pty}`, 'darwin'), true);
    assert.equal(hasPackagedRuntimeReadyOutput(renderer, 'darwin'), false);
    assert.equal(hasPackagedRuntimeReadyOutput(renderer, 'linux'), false);
    assert.equal(hasPackagedRuntimeReadyOutput(renderer, 'win32'), true);
});

test('packaged smoke cleanup terminates an owned child that ignores SIGTERM', { skip: process.platform === 'win32', timeout: 6000 }, async () => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    await terminateProcessTree(child);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.stdout.destroyed, true);
});
