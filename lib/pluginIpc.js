'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { describeManifest, digest } = require('./pluginManifest');
const { readPackage, readDirectory } = require('./pluginPackage');
const { downloadPackage, downloadCatalog, validatePluginUrl } = require('./pluginDownload');
const { defaults, validate, jsonValue, merge } = require('./pluginSchema');

function registerPluginIpc({ ipcMain, dialog, getManager, getRuntime, getTab, getWindow, ownsTab, allTabs, notify, execute }) {
    const previews = new WeakMap();
    let mutation = Promise.resolve();
    const serialized = operation => { const result = mutation.then(operation, operation); mutation = result.catch(() => {}); return result; };
    function list(manager, tab) {
        const result = manager.list(tab.pluginIds);
        for (const plugin of result.plugins) {
            if (plugin.schemaVersion !== 2 || !plugin.installed) continue;
            plugin.runtimeState = getRuntime?.().snapshot(tab, plugin.id);
            if (plugin.runtimeState?.tools) plugin.tools = plugin.runtimeState.tools;
            try { plugin.config = manager.configuration(tab, plugin.id); } catch { plugin.config = { ...defaults(plugin.configSchema), ...(manager.records.get(plugin.id)?.config || {}), ...(tab.pluginConfig?.[plugin.id] || {}) }; }
            plugin.tabConfig = tab.pluginConfig?.[plugin.id] || {};
            plugin.modelSelected = tab.pluginModel?.pluginId === plugin.id ? tab.pluginModel.id : '';
        }
        return { ...result, sources: manager.sources };
    }
    function handle(name, callback) {
        ipcMain.handle(name, async (event, payload = {}) => {
            try {
                if (event.senderFrame !== event.sender.mainFrame) throw new Error('无效调用来源');
                if (!payload || typeof payload !== 'object' || typeof payload.tabId !== 'string') throw new Error('请指定目标标签');
                const tab = getTab(event, payload.tabId), win = getWindow(event);
                if (!tab || !ownsTab(win, tab)) throw new Error('标签已关闭');
                const result = await callback(payload, tab, win, getManager(), event);
                if (!ownsTab(win, tab)) return { success: false, error: '标签已关闭' };
                return { success: true, ...result };
            } catch (e) { return { success: false, error: e.message }; }
        });
    }
    handle('plugins-list', (_p, tab, _w, manager) => list(manager, tab));
    handle('plugins-preview', async (p, tab, win, manager) => {
        let manifest, source, downloadHash, restore = null;
        if (p.kind === 'bundled') {
            manifest = manager.catalog.get(p.id); source = 'bundled';
            if (!manifest) throw new Error('内置插件不存在');
        } else if (p.kind === 'rollback') {
            const record = manager.records.get(p.id)?.history.find(r => r.digest === p.digest);
            if (!record) throw new Error('历史版本不存在');
            manifest = record.manifest; source = record.source;
            restore = { config: record.config || {}, profiles: record.profiles || {} };
        } else if (p.kind === 'directory') {
            const result = await dialog.showOpenDialog(win, { title: '选择包含 plugin.json 的开发目录', properties: ['openDirectory'] });
            if (result.canceled) return { cancelled: true };
            if (!ownsTab(win, tab)) throw new Error('标签已关闭');
            manifest = await readDirectory(result.filePaths[0]); source = `dev:${path.basename(result.filePaths[0])}`;
        } else if (p.kind === 'file') {
            const result = await dialog.showOpenDialog(win, { title: '选择 AITerminal 插件清单', properties: ['openFile'], filters: [{ name: 'AITerminal plugin', extensions: ['json'] }] });
            if (result.canceled) return { cancelled: true };
            if (!ownsTab(win, tab)) throw new Error('标签已关闭');
            manifest = await readPackage(result.filePaths[0]);
            source = `file:${path.basename(result.filePaths[0])}`;
        } else if (p.kind === 'url') {
            ({ manifest, source, downloadHash } = await downloadPackage(p.url, p.sha256 || ''));
        } else throw new Error('未知插件来源');
        if (!ownsTab(win, tab)) throw new Error('标签已关闭');
        const token = crypto.randomUUID();
        const previous = manager.records.get(manifest.id)?.digest || null;
        previews.set(tab, { token, manifest, source, previous, restore, expires: Date.now() + 10 * 60000 });
        const { files, ...description } = describeManifest(manifest);
        return { preview: { ...description, source, downloadHash, files, restoring: !!restore, restoredConfig: restore?.config, fileNames: Object.keys(files || {}), updating: !!previous, token } };
    });
    handle('plugins-install', (p, tab, win, manager) => serialized(async () => {
        if (!ownsTab(win, tab)) throw new Error('标签已关闭');
        const preview = previews.get(tab);
        if (!preview || p.token !== preview.token || preview.expires < Date.now()) throw new Error('安装预览已过期，请重新预览');
        const prepared = [];
        try {
            if (preview.manifest.schemaVersion === 2 && getRuntime) {
                const record = { manifest: preview.manifest, digest: digest(preview.manifest) };
                for (const owner of allTabs()) if (owner.pluginIds.has(record.manifest.id)) {
                    const settings = preview.restore || manager.records.get(record.manifest.id) || {};
                    const config = validate(record.manifest.configSchema, merge(merge(merge(defaults(record.manifest.configSchema), settings.config), settings.profiles?.[manager.profileKey(owner)]), preview.restore ? {} : owner.pluginConfig?.[record.manifest.id]));
                    prepared.push([owner, await getRuntime().prepare(owner, record, config)]);
                }
            }
            if (!ownsTab(win, tab)) throw new Error('标签已关闭');
            const id = manager.install(preview.manifest, preview.source, preview.previous, preview.restore);
            if (preview.restore) for (const owner of allTabs()) if (owner.pluginConfig) delete owner.pluginConfig[id];
            for (const [owner, instance] of prepared) getRuntime().adopt(owner, id, instance);
        } catch (error) { for (const [, instance] of prepared) getRuntime().stop(instance); throw error; }
        previews.delete(tab);
        if (preview.manifest.schemaVersion === 1) for (const t of allTabs()) { manager.revoke(t.pluginIds, preview.manifest.id); getRuntime?.().disable(t, preview.manifest.id); }
        notify();
        return list(manager, tab);
    }));
    handle('plugins-enable', (p, tab, win, manager) => serialized(async () => {
        if (!ownsTab(win, tab)) throw new Error('标签已关闭');
        if (typeof p.enabled !== 'boolean') throw new Error('启用状态无效');
        const previous = new Set(tab.pluginIds);
        manager.setEnabled(tab.pluginIds, p.id, p.enabled);
        if (p.enabled && manager.records.get(p.id)?.manifest.schemaVersion === 2 && getRuntime) {
            try { await getRuntime().ensure(tab, p.id); }
            catch (error) { for (const id of tab.pluginIds) if (!previous.has(id)) { manager.revoke(tab.pluginIds, id); getRuntime().disable(tab, id); } notify(); throw error; }
        } else if (!p.enabled) getRuntime?.().disable(tab, p.id);
        notify(); return list(manager, tab);
    }));
    handle('plugins-default', (p, tab, _w, manager) => {
        if (typeof p.enabled !== 'boolean') throw new Error('默认状态无效');
        manager.setDefault(p.id, p.enabled); notify();
        return list(manager, tab);
    });
    handle('plugins-uninstall', (p, tab, win, manager) => serialized(async () => {
        if (!ownsTab(win, tab)) throw new Error('标签已关闭');
        manager.uninstall(p.id);
        for (const t of allTabs()) { manager.revoke(t.pluginIds, p.id); getRuntime?.().disable(t, p.id); }
        notify();
        return list(manager, tab);
    }));
    handle('plugins-run', (p, _tab, _w, _manager, event) => execute(event, { tabId: p.tabId, pluginId: p.id, actionId: p.actionId }));
    handle('plugins-tool', (p, tab) => getRuntime().startTool(tab, p.id, p.toolId, p.params || {}));
    handle('plugins-cancel', (p, tab) => { getRuntime().cancel(tab, p.taskId); return {}; });
    handle('plugins-config', (p, tab, win, manager) => serialized(async () => {
        if (!ownsTab(win, tab) || !['tab', 'connection', 'user'].includes(p.scope)) throw new Error('配置作用域无效');
        const record = manager.records.get(p.id); if (!record?.manifest.configSchema) throw new Error('插件不存在或不支持配置');
        const config = validate(record.manifest.configSchema, merge(defaults(record.manifest.configSchema), jsonValue(p.config)));
        const profile = manager.profileKey(tab);
        const owners = p.scope === 'tab' ? [tab] : [...allTabs()].filter(owner => !owner.pluginConfig?.[p.id] && (p.scope === 'connection' ? manager.profileKey(owner) === profile : !record.profiles?.[manager.profileKey(owner)]));
        const prepared = [];
        try {
            for (const owner of owners) if (owner.pluginIds.has(p.id)) prepared.push([owner, await getRuntime().prepare(owner, record, config)]);
            if (!ownsTab(win, tab)) throw new Error('标签已关闭');
            if (p.scope !== 'tab') manager.setConfiguration(p.id, config, p.scope === 'connection' ? profile : null);
            else { tab.pluginConfig ||= {}; tab.pluginConfig[p.id] = jsonValue(config); }
            for (const [owner, instance] of prepared) getRuntime().adopt(owner, p.id, instance);
        } catch (error) { for (const [, instance] of prepared) getRuntime().stop(instance); throw error; }
        notify(); return list(manager, tab);
    }));
    handle('plugins-model', (p, tab, _w, manager) => {
        if (!p.id) { tab.pluginModel = null; return {}; }
        if (!tab.pluginIds.has(p.id) || !manager.records.get(p.id)?.manifest.models?.some(m => m.id === p.modelId)) throw new Error('请先启用此模型插件');
        tab.pluginModel = { pluginId: p.id, id: p.modelId }; notify(); return {};
    });
    handle('plugins-sources', (p, tab, win, manager) => serialized(async () => {
        if (!ownsTab(win, tab)) throw new Error('标签已关闭');
        if (!Array.isArray(p.sources) || p.sources.length > 10) throw new Error('最多配置 10 个插件源');
        const previous = manager.sources;
        manager.sources = [...new Set(p.sources.map(url => validatePluginUrl(url).href))];
        try { manager.save(new Map(manager.records)); } catch (error) { manager.sources = previous; throw error; }
        return list(manager, tab);
    }));
    handle('plugins-catalog', async (_p, _tab, _w, manager) => {
        const results = await Promise.allSettled(manager.sources.map(downloadCatalog));
        return { entries: results.flatMap(r => r.status === 'fulfilled' ? r.value : []), errors: results.filter(r => r.status === 'rejected').map(r => r.reason.message) };
    });
}
module.exports = { registerPluginIpc };
