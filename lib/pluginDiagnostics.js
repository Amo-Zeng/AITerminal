'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginManager } = require('./pluginManager');
const { PluginRuntime } = require('./pluginRuntime');
// Exercises the shipped bootstrap and bundled Cordis in the actual packaged
// Electron binary; no external scripts, credentials or user profiles are used.
async function verifyPackagedPluginHost() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-plugin-diagnostic-'));
    const manager = new PluginManager({ filePath: path.join(directory, 'plugins.json'), catalog: require('../plugins/catalog') });
    const id = 'aiterminal.docker-tools'; manager.install(manager.catalog.get(id), 'bundled');
    const owner = { tabId: 'diagnostic', pluginIds: new Set([id]) };
    const runtime = new PluginRuntime({ manager, owned: candidate => candidate === owner && !owner.closed, service: async (_owner, method) => {
        if (method === 'context.read') return { tabId: owner.tabId, target: 'local', shell: 'diagnostic' };
        throw new Error('diagnostic service unavailable');
    } });
    try {
        const result = await runtime.invoke(owner, id, 'tool', 'environment');
        if (result.tabId !== owner.tabId || result.label !== 'Docker') throw new Error('packaged plugin returned invalid state');
        const quest = 'aiterminal.ops-quest'; manager.install(manager.catalog.get(quest), 'bundled'); owner.pluginIds.add(quest);
        if ((await runtime.invoke(owner, quest, 'tool', 'next')).id !== 'inodes') throw new Error('packaged quest did not start');
        await runtime.invoke(owner, quest, 'tool', 'answer', { choice: 'B' });
        runtime.stop(await runtime.ensure(owner, quest));
        if ((await runtime.invoke(owner, quest, 'tool', 'score')).points !== 10) throw new Error('packaged session state did not survive recycling');
        owner.closed = true; runtime.dispose(owner);
        const deadline = Date.now() + 3000;
        while (runtime.hosts.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (runtime.hosts.size) throw new Error('packaged plugin did not exit');
        return true;
    } finally { runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { verifyPackagedPluginHost };
