'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginManager } = require('../lib/pluginManager');
const { parseManifest, validateManifest, describeManifest, parsePluginCall } = require('../lib/pluginManifest');
const { validatePluginUrl } = require('../lib/pluginDownload');
const catalog = require('../plugins/catalog.json');
const example = () => ({ schemaVersion: 1, id: 'example.ops', name: 'Ops', version: '1.0.0', description: 'test plugin', author: 'test', license: 'Apache-2.0', instructions: 'Check before changing.', actions: [{ id: 'check', title: 'Check', target: 'remote', commands: { posix: 'uname -a' } }] });
function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-plugin-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'plugins.json');
    return { filePath, manager: new PluginManager({ filePath, catalog }) };
}
test('plugin install, per-tab enable, restart defaults, update revocation and uninstall', t => {
    const { manager, filePath } = setup(t);
    const manifest = example(); manager.install(manifest, 'file:plugin.json');
    const first = manager.defaultIds(), second = manager.defaultIds();
    assert.equal(first.size, 0);
    manager.setEnabled(first, manifest.id, true);
    assert.match(manager.prompt(first), /plugin_run\("example.ops", "check"\)/);
    assert.equal(manager.prompt(second), '');
    assert.throws(() => manager.resolveAction(second, manifest.id, 'check', { target: 'remote', shell: 'posix' }), /未在此标签启用/);
    assert.throws(() => manager.resolveAction(first, manifest.id, 'check', { target: 'local', shell: 'posix' }), /目标/);
    assert.throws(() => manager.resolveAction(first, manifest.id, 'check', { target: 'remote', shell: 'powershell' }), /不支持/);
    const lease = manager.resolveAction(first, manifest.id, 'check', { target: 'remote', shell: 'posix' });
    assert.equal(lease.command, 'uname -a');
    assert.equal(manager.isCurrent(first, manifest.id, lease.digest, lease.activation), true);
    manager.setEnabled(first, manifest.id, false);
    manager.setEnabled(first, manifest.id, true);
    assert.equal(manager.isCurrent(first, manifest.id, lease.digest, lease.activation), false, 'disable/re-enable must revoke outstanding approvals even when bytes did not change');
    manager.setDefault(manifest.id, true);
    assert.equal(second.size, 0, 'defaults must not mutate existing tabs');
    assert.deepEqual(new PluginManager({ filePath, catalog }).defaultIds(), new Set([manifest.id]));
    assert.throws(() => manager.install(manifest, 'file:plugin.json'), /其他窗口修改/);
    manager.install({ ...manifest, version: '1.1.0' }, 'file:plugin.json', lease.digest);
    assert.equal(manager.isCurrent(first, manifest.id, lease.digest), false);
    assert.equal(manager.defaultIds().size, 0);
    manager.uninstall(manifest.id);
    assert.equal(manager.prompt(first), '');
    assert.throws(() => manager.resolveAction(first, manifest.id, 'check', { target: 'remote', shell: 'posix' }), /卸载/);
});
test('strict manifests reject executable hooks, traversal, controls, unsupported schema and oversized data', () => {
    for (const extra of [{ id: '../escape' }, { schemaVersion: 2 }, { main: 'evil.js' }, { hooks: {} }, { instructions: '\x1b[31m' }]) {
        assert.throws(() => validateManifest({ ...example(), ...extra }));
    }
    assert.throws(() => parseManifest(' '.repeat(128 * 1024 + 1)), /128 KiB/);
    assert.throws(() => validateManifest({ ...example(), actions: [{ ...example().actions[0], commands: { posix: 'echo ok\rreboot' } }] }), /控制符/);
    assert.throws(() => validateManifest({ ...example(), actions: [example().actions[0], example().actions[0]] }), /重复/);
    assert.throws(() => validateManifest({ ...example(), actions: [{ ...example().actions[0], commands: { posix: '__INTERACTIVE__:START:local:payload' } }] }), /内部控制协议/);
    assert.deepEqual(parsePluginCall('plugin_run("example.ops", "check")'), { pluginId: 'example.ops', actionId: 'check' });
    assert.throws(() => parsePluginCall('plugin_run("example.ops", "check"); reboot'), /格式/);
    assert.equal(parsePluginCall('echo hi'), null);
});
test('risk preview is derived from actual commands and built-in IDs cannot be replaced by imports', t => {
    const manifest = example(); manifest.actions[0].commands.posix = 'rm -rf /tmp/example';
    assert.equal(describeManifest(validateManifest(manifest)).actions[0].audits.posix.requiresConfirmation, true);
    const { manager } = setup(t);
    assert.throws(() => manager.install(catalog[0], 'file:forged.json'), /覆盖/);
    manager.install(catalog[0], 'bundled');
    assert.equal(manager.list().plugins[0].installed, true);
});
test('corrupt plugin storage fails closed without overwriting user data', t => {
    const { filePath } = setup(t);
    fs.writeFileSync(filePath, '{broken');
    const manager = new PluginManager({ filePath, catalog });
    assert.equal(manager.defaultIds().size, 0);
    assert.match(manager.list().warning, /损坏/);
    assert.throws(() => manager.install(example(), 'file:test'), /损坏/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});
test('URL imports reject cleartext, credential-bearing, query and fragment URLs', () => {
    for (const value of ['http://example.com/p.json', 'file:///tmp/p.json', 'https://user:pass@example.com/p.json', 'https://example.com/p.json?key=secret', 'https://example.com/p.json#fragment']) assert.throws(() => validatePluginUrl(value));
    assert.equal(validatePluginUrl('https://example.com/p.json').hostname, 'example.com');
});
