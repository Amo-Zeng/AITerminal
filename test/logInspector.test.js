'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { PluginManager } = require('../lib/pluginManager');
const { PluginRuntime, hostEnvironment } = require('../lib/pluginRuntime');
const { createPluginServices } = require('../lib/pluginServices');
const { readDirectory } = require('../lib/pluginPackage');

async function fixture(t) {
    const manifest = await readDirectory(path.join(__dirname, '../examples/log-inspector'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-log-inspector-'));
    const manager = new PluginManager({ filePath: path.join(root, 'plugins.json') }); manager.install(manifest, 'file:test');
    const first = { tabId: 'first', pluginIds: new Set([manifest.id]) }, second = { tabId: 'second', pluginIds: new Set([manifest.id]) };
    const capture = owner => ({ target: 'local', shell: process.platform === 'win32' ? 'powershell' : 'posix', cwd: root, valid: () => !owner.closed });
    const service = createPluginServices({ capture, approve: async (_owner, _cmd, audit) => !audit.requiresConfirmation,
        context: (owner, task) => ({ tabId: owner.tabId, target: task.binding.target, shell: task.binding.shell }) });
    const methods = [];
    const runtime = new PluginRuntime({ manager, owned: owner => !owner.closed, capture,
        service: (owner, method, params, task) => { methods.push(method); return service(owner, method, params, task); },
        launch: () => fork(path.join(__dirname, '../lib/pluginHost.js'), [], { env: hostEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }) });
    t.after(async () => { runtime.close(); await new Promise(resolve => setTimeout(resolve, 1200)); fs.rmSync(root, { recursive: true, force: true }); });
    const call = (params, owner = first) => runtime.invoke(owner, manifest.id, 'tool', 'inspect', params);
    const panel = (owner = first) => runtime.snapshot(owner, manifest.id).panels.find(p => p.id === 'inspection');
    return { manifest, root, runtime, first, second, call, panel, methods };
}

test('Log Inspector reads real files through its host, reports errors and separates tabs', async t => {
    const f = await fixture(t);
    const firstPath = path.join(f.root, "first 'quoted' log.txt"), secondPath = path.join(f.root, 'second.log');
    fs.writeFileSync(firstPath, 'INFO old\r\nERROR demo .*\r\nerror demo .*\r\n');
    fs.writeFileSync(secondPath, 'SECOND_ONLY\n');
    const result = await f.call({ path: firstPath, lines: 2, keyword: '.*' });
    assert.equal(result.matches, 2); assert.equal(result.lines, 2);
    assert.match(f.panel().text, /tab first/); assert.doesNotMatch(f.panel().text, /INFO old/);
    await f.call({ path: secondPath }, f.second);
    assert.match(f.panel(f.second).text, /SECOND_ONLY/); assert.doesNotMatch(f.panel().text, /SECOND_ONLY/);
    assert.equal(f.runtime.state(f.first).sessionData.get(f.manifest.id).value.history[0].file, firstPath);
    assert.equal(f.runtime.state(f.second).sessionData.get(f.manifest.id).value.history[0].file, secondPath);
    await assert.rejects(f.call({ path: path.join(f.root, 'absent.log') }), /absent/);
    await assert.rejects(f.call({ path: 'relative.log' }), /absolute path/);
    await assert.rejects(f.call({ path: firstPath, lines: 201 }), /参数/);
    assert.ok(f.methods.every(method => ['context.read', 'files.read'].includes(method)));
    assert.equal(fs.readFileSync(firstPath, 'utf8'), 'INFO old\r\nERROR demo .*\r\nerror demo .*\r\n');
});

test('Log Inspector bounds the entire panel including escaped text and counts only visible matches', async t => {
    const f = await fixture(t), file = path.join(f.root, 'long.log');
    fs.writeFileSync(file, 'HIDDEN_MATCH' + '\u0001'.repeat(22000) + '尾部 😀\n');
    const result = await f.call({ path: file, keyword: 'HIDDEN_MATCH' });
    assert.equal(result.truncated, true); assert.equal(result.matches, 0);
    const panel = f.panel(); assert.ok(panel.text.length <= 20000); assert.ok(Buffer.byteLength(JSON.stringify({ type: panel.type, title: panel.title, text: panel.text })) <= 60000);
    assert.match(panel.text, /first line may be partial/); assert.match(panel.text, /尾部 😀/);
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(f.call({ path: file }), /1 MiB|超过大小/);
});

test('Log Inspector rejects host Windows paths in WSL and honours cancellation before reads and publishing', async () => {
    const { activate } = require('../examples/log-inspector');
    let handler, reads = 0, panels = 0; const controller = new AbortController();
    activate({ signal: controller.signal, tools: { register: (_id, fn) => { handler = fn; } },
        context: { read: async () => ({ target: 'local', shell: 'posix', tabId: 'wsl' }) },
        files: { read: async () => { reads++; controller.abort(); return { exitCode: 0, output: 'test' }; } },
        ui: { publish: async () => { panels++; } } });
    await assert.rejects(handler({ path: 'C:\\Temp\\test.log' }), /absolute path/); assert.equal(reads, 0);
    await assert.rejects(handler({ path: '/tmp/test.log' }), /cancelled/); assert.equal(reads, 1); assert.equal(panels, 0);
    await assert.rejects(handler({ path: '/tmp/test.log' }), /cancelled/); assert.equal(reads, 1);
});

test('Log Inspector retries changed revisions but does not hide unrelated storage errors', async () => {
    const { activate } = require('../examples/log-inspector');
    let handler, writes = 0, revision = 0, value = null, mode = 'conflict', panels = 0;
    activate({ tools: { register: (_id, fn) => { handler = fn; } },
        context: { read: async () => ({ target: 'remote', shell: 'posix', tabId: 'ssh' }) },
        files: { read: async () => ({ exitCode: 0, output: 'demo\n' }) },
        ui: { publish: async () => { panels++; } }, state: {
            read: async () => ({ revision, value }),
            write: async (next, expected) => {
                writes++;
                if (mode === 'error') throw new Error('storage unavailable');
                if (writes === 1) { revision++; value = { history: [{ file: '/other' }] }; throw new Error('conflict'); }
                assert.equal(expected, revision); value = next; revision++; return { revision, value };
            }
        } });
    await handler({ path: '/test' }); assert.equal(writes, 2); assert.equal(value.history.length, 2); assert.equal(panels, 1);
    mode = 'error'; writes = 0;
    await assert.rejects(handler({ path: '/test' }), /storage unavailable/); assert.equal(writes, 1); assert.equal(panels, 1);
});
