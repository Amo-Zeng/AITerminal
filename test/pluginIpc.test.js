'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginManager } = require('../lib/pluginManager');
const { registerPluginIpc } = require('../lib/pluginIpc');
const catalog = require('../plugins/catalog.json');
function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-plugin-ipc-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manager = new PluginManager({ filePath: path.join(root, 'plugins.json'), catalog });
    const tabs = new Map(['tab-1', 'tab-2'].map(id => [id, { tabId: id, pluginIds: new Set() }]));
    const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame } }, handlers = new Map(), executed = [];
    const dialog = { showOpenDialog: async () => ({ canceled: true }) };
    registerPluginIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog, getManager: () => manager,
        getTab: (_e, id) => tabs.get(id), getWindow: () => ({}), ownsTab: (_w, tab) => tabs.get(tab.tabId) === tab,
        allTabs: () => tabs.values(), notify: () => {}, execute: async (_e, payload) => { executed.push(payload); return { success: true }; }
    });
    const invoke = (name, payload = {}, customEvent = event) => handlers.get('plugins-' + name)(customEvent, { tabId: 'tab-1', ...payload });
    return { root, manager, tabs, invoke, dialog, executed };
}
test('installation preview is bound to tab, content and lifetime; install does not auto-enable', async t => {
    const { manager, tabs, invoke } = setup(t);
    const preview = await invoke('preview', { kind: 'bundled', id: catalog[0].id });
    assert.equal(preview.success, true);
    assert.equal((await invoke('install', { token: preview.preview.token, tabId: 'tab-2' })).success, false);
    assert.equal((await invoke('install', { token: 'guessed-token' })).success, false);
    assert.equal((await invoke('install', { token: preview.preview.token })).success, true);
    assert.equal(tabs.get('tab-1').pluginIds.size, 0);
    assert.equal(manager.records.size, 1);
    assert.equal((await invoke('install', { token: preview.preview.token })).success, false);
    await invoke('enable', { id: catalog[0].id, enabled: true });
    assert.equal(tabs.get('tab-1').pluginIds.size, 1); assert.equal(tabs.get('tab-2').pluginIds.size, 0);
    await invoke('uninstall', { id: catalog[0].id });
    assert.equal(tabs.get('tab-1').pluginIds.size, 0);
});
test('a pending file dialog cannot install or expose data after its tab closes', async t => {
    const { root, tabs, invoke, dialog } = setup(t);
    const filePath = path.join(root, 'plugin.json'); fs.writeFileSync(filePath, JSON.stringify(catalog[0]));
    let finish;
    dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
    const pending = invoke('preview', { kind: 'file' });
    tabs.delete('tab-1'); finish({ canceled: false, filePaths: [filePath] });
    const result = await pending;
    assert.equal(result.success, false); assert.match(result.error, /关闭/);
});
test('subframes and closed tabs cannot call plugin management; runs preserve explicit tab identity', async t => {
    const { invoke, executed } = setup(t);
    assert.equal((await invoke('list', {}, { senderFrame: {}, sender: { mainFrame: {} } })).success, false);
    assert.equal((await invoke('list', { tabId: 'tab-unknown' })).success, false);
    await invoke('run', { tabId: 'tab-2', id: catalog[0].id, actionId: 'overview' });
    assert.deepEqual(executed[0], { tabId: 'tab-2', pluginId: catalog[0].id, actionId: 'overview' });
});

test('file imports install only reviewed bytes and updates revoke activation in every tab', async t => {
    const { root, manager, tabs, invoke, dialog } = setup(t);
    const filePath = path.join(root, 'external.json');
    const first = { ...catalog[0], id: 'example.file-plugin' };
    fs.writeFileSync(filePath, JSON.stringify(first));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    const preview = await invoke('preview', { kind: 'file' });
    assert.equal(preview.success, true);
    // Changing the source file after preview must not change what gets installed.
    fs.writeFileSync(filePath, JSON.stringify({ ...first, version: '2.0.0', instructions: 'NEW VERSION' }));
    await invoke('install', { token: preview.preview.token });
    assert.equal(manager.records.get(first.id).manifest.version, '1.0.0');
    for (const tabId of tabs.keys()) await invoke('enable', { tabId, id: first.id, enabled: true });
    const update = await invoke('preview', { kind: 'file' });
    assert.equal(update.preview.updating, true);
    await invoke('install', { token: update.preview.token });
    assert.equal(manager.records.get(first.id).manifest.version, '2.0.0');
    assert.equal([...tabs.values()].some(tab => tab.pluginIds.has(first.id)), false);
});
