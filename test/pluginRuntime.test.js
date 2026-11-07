'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { PluginManager } = require('../lib/pluginManager');
const { PluginRuntime, hostEnvironment } = require('../lib/pluginRuntime');
const { validateManifest, digest } = require('../lib/pluginManifest');
function example(code) {
    return { schemaVersion: 2, id: 'example.runtime', name: 'Runtime', version: '1.0.0', description: 'Runtime fixture', author: 'test', license: 'Apache-2.0', runtime: 'node', entry: 'index.js', files: { 'index.js': code || `exports.activate = ctx => { let n = 0; ctx.tools.register('count', async () => ({ n: ++n, label: ctx.config.label, context: await ctx.context.read() })); ctx.tools.register('wait', () => new Promise(resolve => { const t = setTimeout(() => resolve('late'), 10000); ctx.signal.addEventListener('abort', () => { clearTimeout(t); resolve('cancelled'); }); })); ctx.prompts.register('hint', () => ctx.config.label); }` }, engines: { aiterminal: '>=1.4.0', pluginApi: '^1.0.0' }, permissions: ['context.read'], configSchema: { type: 'object', properties: { label: { type: 'string', default: 'default' } } }, tools: [{ id: 'count', title: 'count', description: 'count' }, { id: 'wait', title: 'wait', description: 'wait' }] };
}
function setup(t, input = example()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-runtime-'));
    const manager = new PluginManager({ filePath: path.join(root, 'plugins.json') }); manager.install(input, 'file:test');
    const first = { tabId: 'same-id', pluginIds: new Set(), pluginConfig: { [input.id]: { label: 'FIRST' } } }, second = { tabId: 'same-id', pluginIds: new Set(), pluginConfig: { [input.id]: { label: 'SECOND' } } };
    manager.setEnabled(first.pluginIds, input.id, true); manager.setEnabled(second.pluginIds, input.id, true);
    const runtime = new PluginRuntime({ manager, owned: owner => !owner.closed, service: async owner => ({ label: owner.pluginConfig[input.id].label }), launch: () => fork(path.resolve('lib/pluginHost.js'), [], { env: hostEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }) });
    t.after(async () => { runtime.close(); await new Promise(resolve => setTimeout(resolve, 1200)); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, manager, first, second, runtime };
}
test('real Cordis hosts isolate module globals, configuration and service ownership even with identical tab IDs', async t => {
    const { runtime, first, second } = setup(t);
    assert.deepEqual(await runtime.invoke(first, 'example.runtime', 'tool', 'count'), { n: 1, label: 'FIRST', context: { label: 'FIRST' } });
    assert.equal((await runtime.invoke(first, 'example.runtime', 'tool', 'count')).n, 2);
    assert.deepEqual(await runtime.invoke(second, 'example.runtime', 'tool', 'count'), { n: 1, label: 'SECOND', context: { label: 'SECOND' } });
    assert.equal(await runtime.prompt(first), 'FIRST');
    assert.equal(runtime.snapshot(first, 'example.runtime').tasks.length, 2);
});
test('cancel and tab disposal reject pending work and cannot deliver a late result', async t => {
    const { runtime, first } = setup(t);
    await runtime.ensure(first, 'example.runtime');
    const pending = runtime.invoke(first, 'example.runtime', 'tool', 'wait');
    const rejected = assert.rejects(pending, /取消/);
    await new Promise(resolve => setTimeout(resolve, 40));
    const task = runtime.snapshot(first, 'example.runtime').tasks[0];
    runtime.cancel(first, task.id); await rejected;
    assert.equal(runtime.snapshot(first, 'example.runtime').tasks[0].state, 'cancelled');
    first.closed = true; runtime.dispose(first);
    await assert.rejects(runtime.invoke(first, 'example.runtime', 'tool', 'count'), /关闭|启用/);
});
test('activation failure is diagnosed without terminating another plugin host', async t => {
    const { runtime, first, second, manager } = setup(t);
    await runtime.ensure(first, 'example.runtime');
    const broken = example('exports.activate = () => { throw new Error("broken activation"); };'); broken.version = '2.0.0';
    await assert.rejects(runtime.prepare(second, { manifest: validateManifest(broken), digest: digest(validateManifest(broken)) }, { label: 'SECOND' }), /broken activation/);
    assert.equal((await runtime.invoke(first, 'example.runtime', 'tool', 'count')).n, 1);
    assert.equal(manager.records.get(broken.id).manifest.version, '1.0.0');
    const missing = validateManifest({ ...example(), version: '1.1.0', dependencies: { 'example.missing': '^1.0.0' } });
    await assert.rejects(runtime.prepare(first, { manifest: missing, digest: digest(missing) }, { label: 'FIRST' }), /依赖/);
    assert.equal((await runtime.invoke(first, 'example.runtime', 'tool', 'count')).n, 2);
});
test('upgrades keep old tasks pinned and cancelling an old task cannot stop the new version', async t => {
    const code = `exports.activate=ctx=>{ctx.tools.register('count',()=>ctx.config.label);ctx.tools.register('wait',()=>ctx.context.read());};`;
    const { runtime, first, manager } = setup(t, example(code));
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    runtime.service = async (_owner, _method, _params, task) => {
        entered(); return new Promise(resolve => task.signal.addEventListener('abort', () => resolve('old finished'), { once: true }));
    };
    const pending = runtime.invoke(first, 'example.runtime', 'tool', 'wait');
    const cancelled = assert.rejects(pending, /取消/);
    await started;
    const oldTask = runtime.snapshot(first, 'example.runtime').tasks[0];
    const manifest = validateManifest({ ...example(code), version: '1.1.0' });
    const prepared = await runtime.prepare(first, { manifest, digest: digest(manifest) }, { label: 'FIRST' });
    manager.install(manifest, 'file:test', manager.records.get(manifest.id).digest);
    runtime.adopt(first, manifest.id, prepared);
    runtime.cancel(first, oldTask.id); await cancelled;
    assert.equal(await runtime.invoke(first, manifest.id, 'tool', 'count'), 'FIRST');
    assert.equal(runtime.snapshot(first, manifest.id).status, 'running');
});
test('effects created in a tool handler are disposed at task completion', async t => {
    const { runtime, first } = setup(t, example(`exports.activate=ctx=>{let live=0;ctx.tools.register('count',()=>{live++;ctx.onDispose(()=>{live--});return live;});ctx.tools.register('wait',()=>live);};`));
    assert.equal(await runtime.invoke(first, 'example.runtime', 'tool', 'count'), 1);
    assert.equal(await runtime.invoke(first, 'example.runtime', 'tool', 'wait'), 0);
});
test('configuration prompts survive an exited shell while execution/context calls retain the captured backend', async t => {
    const { runtime, first } = setup(t);
    runtime.capture = () => ({ target: 'local', valid: () => false });
    assert.equal(await runtime.prompt(first), 'FIRST');
    await assert.rejects(runtime.invoke(first, 'example.runtime', 'tool', 'count'), /失效/);
});
test('a host being terminated cannot accept another task before its exit event', async t => {
    const { runtime, first } = setup(t);
    const instance = await runtime.ensure(first, 'example.runtime');
    runtime.stop(instance, true);
    assert.equal(runtime.current(instance), false);
    assert.equal(runtime.snapshot(first, 'example.runtime').status, 'error');
    const replacement = await runtime.ensure(first, 'example.runtime');
    assert.notEqual(instance, replacement);
    assert.equal((await runtime.invoke(first, 'example.runtime', 'tool', 'count')).n, 1);
});
test('session state is scoped, bounded and compare-and-swap writes reject concurrent lost updates', async t => {
    const code = `exports.activate=ctx=>{
        ctx.tools.register('count', async () => ({ api: ctx.apiVersion, ...await ctx.state.read() }));
        ctx.tools.register('wait', async ({big=false}) => { const prior=await ctx.state.read(); await ctx.context.read(); return ctx.state.write(big ? 'x'.repeat(32769) : { n:(prior.value?.n || 0)+1 },prior.revision); });
    };`;
    const input = example(code);
    input.tools[1].inputSchema = { type: 'object', properties: { big: { type: 'boolean' } } };
    const { runtime, first, second } = setup(t, input);
    assert.deepEqual(await runtime.invoke(first, input.id, 'tool', 'count'), { api: '1.1.0', revision: 0, value: null });
    let release;
    const barrier = new Promise(resolve => { release = resolve; }); let calls = 0;
    runtime.service = async () => { if (++calls === 2) release(); await barrier; return {}; };
    const results = await Promise.allSettled([runtime.invoke(first, input.id, 'tool', 'wait'), runtime.invoke(first, input.id, 'tool', 'wait')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /会话状态已变化/);
    assert.equal((await runtime.invoke(first, input.id, 'tool', 'count')).value.n, 1);
    assert.equal((await runtime.invoke(second, input.id, 'tool', 'count')).value, null);
    await assert.rejects(runtime.invoke(first, input.id, 'tool', 'wait', { big: true }), /大小限制/);
    assert.equal((await runtime.invoke(first, input.id, 'tool', 'count')).value.n, 1);
    runtime.stop(await runtime.ensure(first, input.id));
    assert.equal((await runtime.invoke(first, input.id, 'tool', 'count')).value.n, 1);
    runtime.disable(first, input.id);
    assert.equal((await runtime.invoke(first, input.id, 'tool', 'count')).value, null);
});
test('draining versions cannot overwrite session state belonging to the replacement', async t => {
    const code = `exports.activate=ctx=>{ctx.tools.register('count',()=>ctx.state.read());ctx.tools.register('wait',async()=>{const prior=await ctx.state.read();await ctx.context.read();return ctx.state.write({old:true},prior.revision);});};`;
    const { runtime, first, manager } = setup(t, example(code));
    let started, release;
    const entered = new Promise(resolve => { started = resolve; }); const barrier = new Promise(resolve => { release = resolve; });
    runtime.service = async () => { started(); await barrier; return {}; };
    const pending = runtime.invoke(first, 'example.runtime', 'tool', 'wait');
    const rejected = assert.rejects(pending, /版本已变化/);
    await entered;
    const manifest = validateManifest({ ...example(code), version: '1.1.0' });
    const replacement = await runtime.prepare(first, { manifest, digest: digest(manifest) }, { label: 'FIRST' });
    manager.install(manifest, 'file:test', manager.records.get(manifest.id).digest);
    runtime.adopt(first, manifest.id, replacement); release(); await rejected;
    assert.deepEqual(await runtime.invoke(first, manifest.id, 'tool', 'count'), { revision: 0, value: null });
});
