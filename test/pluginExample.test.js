'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { PluginManager } = require('../lib/pluginManager');
const { PluginRuntime, hostEnvironment } = require('../lib/pluginRuntime');
const { readDirectory } = require('../lib/pluginPackage');

test('Tab Notes works after shell exit, preserves concurrent writes, and isolates tabs and unconfirmed clears', async t => {
    const manifest = await readDirectory(path.join(__dirname, '../examples/tab-notes'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-notes-'));
    const manager = new PluginManager({ filePath: path.join(root, 'plugins.json') }); manager.install(manifest, 'file:test');
    const first = { tabId: 'first', pluginIds: new Set([manifest.id]), pluginConfig: { [manifest.id]: { keepLast: 25 } } };
    const second = { tabId: 'second', pluginIds: new Set([manifest.id]) };
    const runtime = new PluginRuntime({ manager, owned: () => true, capture: () => ({ valid: () => false }),
        service: async () => { throw new Error('Offline example must not use privileged services'); },
        launch: () => fork(path.join(__dirname, '../lib/pluginHost.js'), [], { env: hostEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }) });
    t.after(async () => { runtime.close(); await new Promise(resolve => setTimeout(resolve, 1200)); fs.rmSync(root, { recursive: true, force: true }); });
    const call = (tool, params = {}, owner = first) => runtime.invoke(owner, manifest.id, 'tool', tool, params);
    await Promise.all(['A', 'B', 'C'].map(text => call('add', { text })));
    const notes = await call('show'); for (const label of ['A', 'B', 'C']) assert.match(notes.text, new RegExp('\\] ' + label));
    assert.match((await call('show', {}, second)).text, /no notes/);
    assert.match((await call('clear')).text, /3 note\(s\)/);
    assert.match((await call('show')).text, /3 note\(s\)/);
    runtime.stop(await runtime.ensure(first, manifest.id));
    assert.match((await call('show')).text, /3 note\(s\)/);
    await call('clear', { confirm: true });
    assert.match((await call('show')).text, /no notes/);
    // Worst-case JSON escaping must still fit the host's 32 KiB state limit.
    for (let n = 0; n < 26; n++) await call('add', { text: '\u0001'.repeat(200) });
    assert.match((await call('show')).text, /25 note\(s\)/);
});

test('Tab Notes retries changed revisions but propagates unrelated write failures', async () => {
    const { activate } = require('../examples/tab-notes');
    let revision = 0, value = null, writes = 0, reads = 0, mode = 'conflict'; const handlers = {};
    activate({ config: {}, tools: { register: (name, handler) => { handlers[name] = handler; } }, ui: { publish: async () => true }, state: {
        read: async () => { reads++; return { revision, value }; },
        write: async (next, expected) => {
            writes++;
            if (mode === 'conflict' && writes === 1) { value = { notes: [{ at: 'concurrent', text: 'other writer' }] }; revision++; throw new Error('conflict'); }
            if (mode === 'error') throw new Error('payload too large');
            assert.equal(expected, revision); value = next; revision++; return { value, revision };
        }
    } });
    const result = await handlers.add({ text: 'own note' });
    assert.match(result.text, /other writer/); assert.match(result.text, /own note/); assert.equal(writes, 2);
    mode = 'error'; writes = 0; reads = 0;
    await assert.rejects(handlers.add({ text: 'bad' }), /payload too large/);
    assert.equal(writes, 1); assert.equal(reads, 2);
});
