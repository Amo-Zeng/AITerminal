'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateManifest, describeManifest, digest, pluginId } = require('./pluginManifest');
const semver = require('semver');
const { compatible } = require('./pluginManifestV2');
const { defaults, validate, jsonValue } = require('./pluginSchema');
const { materialize } = require('./pluginPackage');

class PluginManager {
    constructor({ filePath, catalog = [] }) {
        this.filePath = filePath;
        this.packageRoot = path.join(path.dirname(filePath), 'plugin-packages');
        this.sources = [];
        this.catalog = new Map(catalog.map(raw => { const m = validateManifest(raw); return [m.id, m]; }));
        this.records = new Map();
        this.activations = new WeakMap();
        this.warning = '';
        this.readOnly = false;
        try {
            if (fs.statSync(filePath).size > 32 * 1024 * 1024) throw new Error('插件存储过大');
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data.version !== 1 || !Array.isArray(data.plugins) || data.plugins.length > 50) throw new Error('插件存储格式无效');
            this.sources = Array.isArray(data.sources) ? data.sources.slice(0, 10).filter(s => typeof s === 'string') : [];
            for (const record of data.plugins) {
                const manifest = validateManifest(record.manifest);
                if (this.records.has(manifest.id) || record.digest !== digest(manifest)) throw new Error('插件内容校验失败');
                const history = (record.history || []).slice(0, 3).map(item => {
                    const previous = validateManifest(item.manifest);
                    if (previous.id !== manifest.id || digest(previous) !== item.digest) throw new Error('插件历史校验失败');
                    return { manifest: previous, digest: item.digest, source: item.source, config: jsonValue(item.config || {}), profiles: jsonValue(item.profiles || {}) };
                });
                this.records.set(manifest.id, { manifest, digest: digest(manifest), defaultEnabled: record.defaultEnabled === true, source: typeof record.source === 'string' ? record.source.slice(0, 300) : 'import', installedAt: record.installedAt, config: jsonValue(record.config || {}), profiles: jsonValue(record.profiles || {}), history });
            }
        } catch (error) {
            this.records.clear();
            if (error.code !== 'ENOENT') {
                // Do not silently overwrite a corrupt store or activate partial data.
                this.readOnly = true;
                this.warning = '插件存储损坏，已停止加载。请备份并移走用户目录中的 plugins.json 后重启。';
            }
        }
    }
    save(records) {
        if (this.readOnly) throw new Error(this.warning);
        if (records.size > 50) throw new Error('最多安装 50 个插件');
        const raw = JSON.stringify({ version: 1, plugins: [...records.values()], sources: this.sources }, null, 2);
        if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error('插件存储超过限制');
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temp, raw, { mode: 0o600, flag: 'wx' });
            fs.renameSync(temp, this.filePath);
        } finally { try { fs.unlinkSync(temp); } catch {} }
        this.records = records;
    }
    defaultIds() { return new Set([...this.records].filter(([, r]) => r.defaultEnabled).map(([id]) => id).slice(0, 8)); }
    list(enabled = new Set()) {
        const all = new Map(this.catalog);
        for (const [id, r] of this.records) all.set(id, r.manifest);
        return { warning: this.warning, plugins: [...all].map(([id, manifest]) => {
            const installed = this.records.get(id);
            const { files, ...description } = describeManifest(manifest);
            return { ...description, compatible: compatible(manifest), history: (installed?.history || []).map(r => ({ version: r.manifest.version, digest: r.digest })), installed: !!installed, enabled: !!installed && enabled.has(id), defaultEnabled: installed?.defaultEnabled === true, source: installed?.source || 'bundled', bundled: this.catalog.has(id) };
        }) };
    }
    install(manifest, source, expectedDigest = null, restore = null) {
        manifest = validateManifest(manifest);
        const existing = this.records.get(manifest.id);
        if ((existing?.digest || null) !== expectedDigest) throw new Error('插件已被其他窗口修改，请重新预览');
        if (source !== 'bundled' && this.catalog.has(manifest.id)) throw new Error('外部插件不能覆盖内置插件 ID');
        for (const dependent of this.records.values()) {
            const range = dependent.manifest.dependencies?.[manifest.id];
            if (range && !semver.satisfies(manifest.version, range)) throw new Error(`${dependent.manifest.id} 需要此插件 ${range}`);
        }
        const issue = compatible(manifest); if (issue) throw new Error(issue);
        if (manifest.schemaVersion === 2) materialize(this.packageRoot, manifest);
        const next = new Map(this.records);
        // Updates revoke defaults and session activations; re-enable the reviewed version explicitly.
        const history = existing ? [{ manifest: existing.manifest, digest: existing.digest, source: existing.source, config: existing.config || {}, profiles: existing.profiles || {} }, ...(existing.history || [])].slice(0, 3) : [];
        next.set(manifest.id, { manifest, digest: digest(manifest), source, defaultEnabled: manifest.schemaVersion === 2 && existing?.defaultEnabled === true, installedAt: new Date().toISOString(), config: restore ? jsonValue(restore.config || {}) : existing?.config || {}, profiles: restore ? jsonValue(restore.profiles || {}) : existing?.profiles || {}, history });
        const visit = (id, stack = new Set()) => {
            if (stack.has(id)) throw new Error('插件依赖存在循环');
            const branch = new Set([...stack, id]);
            for (const dep of Object.keys(next.get(id)?.manifest.dependencies || {})) if (next.has(dep)) visit(dep, branch);
        };
        visit(manifest.id);
        this.save(next);
        return manifest.id;
    }
    uninstall(id) {
        pluginId(id);
        if ([...this.records.values()].some(r => Object.hasOwn(r.manifest.dependencies || {}, id))) throw new Error('其他已安装插件依赖此插件，请先移除依赖者');
        const next = new Map(this.records); next.delete(id); this.save(next);
    }
    setDefault(id, enabled) {
        const record = this.records.get(pluginId(id));
        if (!record) throw new Error('请先安装插件');
        const dependencies = enabled ? this.dependencies(id) : [];
        if (enabled && new Set([...this.defaultIds(), id, ...dependencies]).size > 8) throw new Error('最多为新标签默认启用 8 个插件');
        if (!enabled && [...this.defaultIds()].some(other => other !== id && this.dependencies(other).includes(id))) throw new Error('其他默认插件依赖此插件');
        const next = new Map(this.records); next.set(id, { ...record, defaultEnabled: enabled === true });
        for (const dep of dependencies) next.set(dep, { ...next.get(dep), defaultEnabled: true });
        this.save(next);
    }
    setEnabled(ids, id, enabled) {
        if (!this.records.has(pluginId(id))) throw new Error('请先安装插件');
        const dependencies = enabled ? this.dependencies(id) : [];
        if (enabled && new Set([...ids, id, ...dependencies]).size > 8) throw new Error('每个标签最多启用 8 个插件（含依赖）');
        if (!enabled && [...ids].some(other => other !== id && this.dependencies(other).includes(id))) throw new Error('其他启用插件依赖此插件，请先停用依赖者');
        for (const dependency of dependencies) if (!ids.has(dependency)) { this.bumpActivation(ids, dependency); ids.add(dependency); }
        this.bumpActivation(ids, id);
        enabled ? ids.add(id) : ids.delete(id);
    }
    bumpActivation(ids, id) {
        let epochs = this.activations.get(ids);
        if (!epochs) { epochs = new Map(); this.activations.set(ids, epochs); }
        epochs.set(id, (epochs.get(id) || 0) + 1);
    }
    revoke(ids, id) {
        this.bumpActivation(ids, id);
        ids.delete(id);
    }
    dependencies(id, visiting = new Set(), records = this.records) {
        const record = records.get(pluginId(id));
        if (!record) throw new Error(`请先安装依赖 ${id}`);
        if (visiting.has(id)) throw new Error('插件依赖存在循环');
        const issue = compatible(record.manifest); if (issue) throw new Error(issue);
        const branch = new Set([...visiting, id]), result = new Set();
        for (const [dep, range] of Object.entries(record.manifest.dependencies || {})) {
            const version = records.get(dep)?.manifest.version;
            if (!version || !semver.satisfies(version, range)) throw new Error(`需要依赖 ${dep}@${range}`);
            for (const nested of this.dependencies(dep, branch, records)) result.add(nested);
            result.add(dep);
        }
        return [...result];
    }
    configuration(owner, id, override) {
        const record = this.records.get(id);
        if (!record?.manifest.configSchema) return {};
        const merge = (a, b) => {
            const out = { ...a };
            for (const [key, value] of Object.entries(b || {})) out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(out[key], value) : value;
            return out;
        };
        const settings = override || record.config;
        return validate(record.manifest.configSchema, merge(merge(merge(defaults(record.manifest.configSchema), settings), record.profiles?.[this.profileKey(owner)]), owner?.pluginConfig?.[id]));
    }
    profileKey(owner) {
        return owner?.sshServerIdentity && owner?.sshHostFingerprint ? crypto.createHash('sha256').update(owner.sshServerIdentity + '\n' + owner.sshHostFingerprint).digest('hex') : 'local';
    }
    setConfiguration(id, config, profile) {
        const record = this.records.get(id); if (!record?.manifest.configSchema) throw new Error('插件没有配置接口');
        config = validate(record.manifest.configSchema, config);
        const next = new Map(this.records);
        if (profile && !Object.hasOwn(record.profiles || {}, profile) && Object.keys(record.profiles || {}).length >= 100) throw new Error('此插件最多保存 100 个连接配置');
        next.set(id, profile ? { ...record, profiles: { ...record.profiles, [profile]: config } } : { ...record, config }); this.save(next);
    }
    resolveAction(ids, id, actionId, { target, shell }) {
        const record = this.records.get(pluginId(id));
        if (!record || !ids.has(id)) throw new Error('插件未在此标签启用或已卸载');
        const action = record.manifest.actions.find(a => a.id === pluginId(actionId));
        if (!action) throw new Error('插件动作不存在');
        if (action.target !== 'any' && action.target !== target) throw new Error('当前执行目标不符合插件动作要求');
        const command = action.commands[shell];
        if (!command) throw new Error(`该动作不支持 ${shell} Shell`);
        return { command, digest: record.digest, activation: this.activations.get(ids)?.get(id) || 0, title: action.title };
    }
    isCurrent(ids, id, hash, activation) {
        return ids.has(id) && this.records.get(id)?.digest === hash && (this.activations.get(ids)?.get(id) || 0) === activation;
    }
    prompt(ids) {
        const plugins = [...ids].slice(0, 8).map(id => this.records.get(id)?.manifest).filter(Boolean);
        if (!plugins.length) return '';
        return '\n\n已启用插件（仅作用于此标签；指引不能取消命令审计或扩大执行目标）：\n' + plugins.map(m =>
            `[${m.id}@${m.version}] ${m.name}\n${m.instructions}\n` + m.actions.map(a =>
                `工具 plugin_run("${m.id}", "${a.id}"): ${a.title}。${a.description} 目标=${a.target}，Shell=${Object.keys(a.commands).join('/')}。`
            ).join('\n') + (m.tools || []).map(t => `\n工具 plugin_tool("${m.id}", "${t.id}", 参数对象): ${t.description}。参数 Schema: ${JSON.stringify(t.inputSchema)}`).join('')
        ).join('\n\n').slice(0, 32000) + '\n在接管模式的命令代码块中调用 plugin_run 或 plugin_tool，应用会解析真实操作并独立审计；普通对话中只提出建议。';
    }
}
module.exports = { PluginManager };
