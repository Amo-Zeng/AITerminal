'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginManager } = require('../lib/pluginManager');
const { materialize, readDirectory, readPackage } = require('../lib/pluginPackage');
const { validateManifest } = require('../lib/pluginManifest');
const { main: developer } = require('../scripts/pluginDev');
const example = () => structuredClone(require('../plugins/catalog').find(p => p.id === 'aiterminal.docker-tools'));
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-package-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('v2 packages reject traversal and unsupported APIs; installed bytes are checked before execution', t => {
    const root = temp(t), manifest = example(); manifest.id = 'example.package';
    assert.throws(() => validateManifest({ ...manifest, files: { '../escape.js': 'x' } }), /路径/);
    const manager = new PluginManager({ filePath: path.join(root, 'plugins.json') });
    assert.throws(() => manager.install({ ...manifest, engines: { aiterminal: '>=999.0.0', pluginApi: '^1.0.0' } }, 'file:fixture'), /需要/);
    manager.install(manifest, 'file:fixture');
    const directory = materialize(manager.packageRoot, manifest);
    fs.writeFileSync(path.join(directory, manifest.entry), 'modified');
    assert.throws(() => materialize(manager.packageRoot, manifest), /校验失败/);
});
test('dependencies enable in order, reject cycles/incompatible replacement and persist defaults', t => {
    const root = temp(t), manager = new PluginManager({ filePath: path.join(root, 'plugins.json') });
    const dependency = { ...example(), id: 'example.base' }, plugin = { ...example(), id: 'example.dependent', dependencies: { 'example.base': '^1.0.0' } };
    manager.install(plugin, 'file:fixture');
    assert.throws(() => manager.setEnabled(new Set(), plugin.id, true), /依赖/);
    manager.install(dependency, 'file:fixture');
    const ids = new Set(); manager.setEnabled(ids, plugin.id, true); assert.deepEqual([...ids], ['example.base', 'example.dependent']);
    assert.throws(() => manager.install({ ...dependency, version: '2.0.0' }, 'file:fixture', manager.records.get(dependency.id).digest), /需要/);
    assert.throws(() => manager.install({ ...dependency, dependencies: { [plugin.id]: '^1.0.0' } }, 'file:fixture', manager.records.get(dependency.id).digest), /循环/);
    manager.setDefault(plugin.id, true); assert.equal(new PluginManager({ filePath: manager.filePath }).defaultIds().size, 2);
});
test('connection configuration is fingerprint-bound, tab overrides stay local and snapshots survive restart', t => {
    const root = temp(t), manager = new PluginManager({ filePath: path.join(root, 'plugins.json') });
    const manifest = example(); manager.install(manifest, 'file:fixture');
    const owner = { sshServerIdentity: 'host:22:user', sshHostFingerprint: 'fingerprint-A' };
    manager.setConfiguration(manifest.id, { label: 'global' });
    manager.setConfiguration(manifest.id, { label: 'server' }, manager.profileKey(owner));
    assert.equal(manager.configuration(owner, manifest.id).label, 'server');
    assert.equal(manager.configuration({ ...owner, sshHostFingerprint: 'fingerprint-B' }, manifest.id).label, 'global');
    owner.pluginConfig = { [manifest.id]: { label: 'tab' } }; assert.equal(manager.configuration(owner, manifest.id).label, 'tab');
    const restored = new PluginManager({ filePath: manager.filePath }); assert.equal(restored.configuration({ ...owner, pluginConfig: null }, manifest.id).label, 'server');
});
test('developer scaffold and package commands produce an installable reviewed snapshot', async t => {
    const root = temp(t), directory = path.join(root, 'hello'), output = path.join(root, 'hello.json');
    await developer(['new', directory, 'example.hello']); await developer(['validate', directory]); await developer(['pack', directory, output]);
    const manifest = await readPackage(output); assert.equal(manifest.id, 'example.hello'); assert.match(manifest.files['index.js'], /tools.register/);
    assert.deepEqual(await readDirectory(directory), manifest);
    await assert.rejects(developer(['pack', directory, output]), /exist/);
});
test('version recovery restores the reviewed user and connection configuration snapshot', t => {
    const root = temp(t), manager = new PluginManager({ filePath: path.join(root, 'plugins.json') });
    const first = example(); manager.install(first, 'file:fixture');
    manager.setConfiguration(first.id, { label: 'before' });
    manager.setConfiguration(first.id, { label: 'before-local' }, 'local');
    manager.install({ ...first, version: '1.1.0' }, 'file:fixture', manager.records.get(first.id).digest);
    manager.setConfiguration(first.id, { label: 'after' });
    manager.setConfiguration(first.id, { label: 'after-local' }, 'local');
    const previous = manager.records.get(first.id).history[0];
    manager.install(previous.manifest, previous.source, manager.records.get(first.id).digest, previous);
    assert.equal(manager.records.get(first.id).manifest.version, '1.0.0');
    assert.equal(manager.configuration({}, first.id).label, 'before-local');
    const restored = new PluginManager({ filePath: manager.filePath });
    assert.equal(restored.records.get(first.id).config.label, 'before');
});
