'use strict';
const path = require('path');
const crypto = require('crypto');
const { materialize } = require('./pluginPackage');
const { compatible, resolveMcpConfig } = require('./pluginManifestV2');
const { validate, jsonValue } = require('./pluginSchema');
const { redactSensitive } = require('./webhook');

const PERMISSION = { 'terminal.exec': 'terminal.execute', 'terminal.open': 'terminal.interactive', 'terminal.read': 'terminal.interactive', 'terminal.write': 'terminal.interactive', 'terminal.resize': 'terminal.interactive', 'terminal.close': 'terminal.interactive', 'files.read': 'files.read', 'files.write': 'files.write', 'models.request': 'models.request', 'notifications.send': 'notifications.send', 'context.read': 'context.read', 'services.call': 'services.call' };
function hostEnvironment() {
    return Object.fromEntries(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'COMSPEC', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
}
function launchUtilityHost() {
    const { utilityProcess } = require('electron');
    return utilityProcess.fork(path.join(__dirname, 'pluginHost.js'), [], { serviceName: 'AITerminal Plugin', stdio: 'pipe', env: hostEnvironment() });
}
class PluginRuntime {
    constructor({ manager, owned, service, capture = () => ({ valid: () => true }), changed = () => {}, taskEvent = () => {}, launch = launchUtilityHost, maxHosts = 24, idleMs = 120000 }) {
        Object.assign(this, { manager, owned, service, capture, changed, taskEvent, launch, maxHosts, idleMs });
        this.owners = new Map(); this.hosts = new Set();
    }
    state(owner) {
        let state = this.owners.get(owner);
        if (!state) { state = { instances: new Map(), tasks: [], panels: new Map(), sessionData: new Map(), closed: false }; this.owners.set(owner, state); }
        return state;
    }
    current(instance) {
        const state = this.owners.get(instance.owner);
        return !!state && !state.closed && !instance.stopping && this.owned(instance.owner) && instance.owner.pluginIds.has(instance.manifest.id) && !['stopped', 'error'].includes(instance.status) && (state.instances.get(instance.manifest.id) === instance || instance.draining);
    }
    async start(owner, record, config) {
        if (!this.owned(owner)) throw new Error('标签已关闭');
        const issue = compatible(record.manifest); if (issue) throw new Error(issue);
        if (this.hosts.size >= this.maxHosts) {
            const idle = [...this.hosts].find(i => !i.pending.size && !i.leases && i.status === 'running');
            if (idle) this.stop(idle); else throw new Error('插件宿主繁忙，请等待现有任务完成');
        }
        const manifest = record.manifest.runtime === 'mcp' ? { ...record.manifest, mcp: resolveMcpConfig(record.manifest, config) } : record.manifest;
        if (manifest.runtime === 'mcp' && manifest.mcp.transport === 'stdio') await this.service(owner, 'mcp.start', manifest.mcp, { signal: new AbortController().signal, valid: () => this.owned(owner) && owner.pluginIds.has(record.manifest.id) });
        if (!this.owned(owner) || !owner.pluginIds.has(record.manifest.id)) throw new Error('插件已停用或标签已关闭');
        const directory = materialize(this.manager.packageRoot, record.manifest);
        const child = this.launch();
        const instance = { owner, manifest, digest: record.digest, config, child, status: 'loading', pending: new Map(), cancelTimers: new Map(), panels: new Map(), info: {}, lastUse: Date.now(), error: '' };
        this.hosts.add(instance);
        let readyResolve, readyReject;
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        const timer = setTimeout(() => { readyReject(new Error(`插件启动超时（${instance.stage || 'bootstrap'}）`)); this.stop(instance); }, manifest.runtime === 'mcp' ? 60000 : 20000);
        const post = message => { try { child.postMessage ? child.postMessage(message) : child.send(message); } catch {} };
        instance.post = post;
        const fail = error => {
            instance.error = String(error.message || error).slice(0, 1000); instance.status = 'error';
            readyReject(new Error(instance.error));
            for (const task of [...instance.pending.values()]) task.finish(new Error(instance.error));
            this.changed(owner);
        };
        child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
        child.on('error', fail);
        child.on('exit', code => {
            this.hosts.delete(instance); clearTimeout(instance.idleTimer);
            for (const timer of instance.cancelTimers.values()) clearTimeout(timer);
            instance.cancelTimers.clear();
            if (instance.status !== 'stopped') fail(new Error(`插件进程已退出 (${code})`));
        });
        child.on('message', message => {
            try {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'booted') {
                const { files, ...manifest } = instance.manifest;
                post({ type: 'init', entry: path.join(directory, record.manifest.entry || 'index.js'), manifest, config });
            } else if (message.type === 'loading') { instance.stage = String(message.stage).slice(0, 40); }
            else if (message.type === 'ready') {
                const info = jsonValue(message, 256 * 1024);
                if (['tools', 'prompts', 'models', 'events', 'services'].some(key => !Array.isArray(info[key]) || info[key].length > 32)) throw new Error('插件注册协议无效');
                instance.info = info; instance.status = 'running'; readyResolve(instance);
            } else if (message.type === 'fatal') { fail(new Error(message.error)); this.stop(instance, true); }
            else if (message.type === 'cancelled') {
                clearTimeout(instance.cancelTimers.get(message.id)); instance.cancelTimers.delete(message.id);
            } else if (message.type === 'result') {
                const task = instance.pending.get(message.id); if (!task) return;
                task.finish(message.error ? new Error(String(message.error).slice(0, 2000)) : null, message.error ? null : jsonValue(message.value));
            } else if (message.type === 'progress') {
                const task = instance.pending.get(message.taskId);
                if (task && task.valid()) {
                    try { task.output = (task.output + (typeof message.value === 'string' ? message.value : JSON.stringify(message.value)) + '\n').slice(-65536); task.onOutput?.(message.value); this.changed(owner); } catch {}
                }
            } else if (message.type === 'call') void this.handleCall(instance, message);
            } catch (error) { fail(error); this.stop(instance, true); }
        });
        try {
            await ready;
            instance.idleTimer = setInterval(() => {
                if (!instance.pending.size && !instance.leases && Date.now() - instance.lastUse > this.idleMs && !(instance.info.events || []).length) this.stop(instance);
            }, Math.min(this.idleMs, 30000));
            instance.idleTimer.unref?.();
            return instance;
        } catch (error) { this.stop(instance, true); throw error; }
        finally { clearTimeout(timer); }
    }
    async ensure(owner, id) {
        if (!this.owned(owner) || !owner.pluginIds.has(id)) throw new Error('插件未在此标签启用');
        const record = this.manager.records.get(id);
        if (!record || record.manifest.schemaVersion !== 2) throw new Error('插件不支持代码扩展');
        for (const dependency of this.manager.dependencies(id)) if (this.manager.records.get(dependency)?.manifest.schemaVersion === 2) await this.ensure(owner, dependency);
        const state = this.state(owner);
        let instance = state.instances.get(id);
        if (instance?.starting) return instance.starting;
        const config = this.manager.configuration(owner, id);
        if (instance && this.current(instance) && instance.digest === record.digest && instance.status === 'running' && JSON.stringify(instance.config) === JSON.stringify(config)) return instance;
        const slot = {};
        slot.starting = this.start(owner, record, config).then(next => {
            if (state.closed || state.instances.get(id) !== slot || !owner.pluginIds.has(id) || this.manager.records.get(id)?.digest !== record.digest) { this.stop(next); throw new Error('插件启用状态已变化'); }
            state.instances.set(id, next);
            if (state.sessionData.get(id)?.digest !== next.digest) state.sessionData.delete(id);
            if (instance?.child) { instance.draining = true; if (!instance.pending.size && !instance.leases) this.stop(instance); }
            this.changed(owner); return next;
        }).catch(error => { if (state.instances.get(id) === slot) state.instances.set(id, { status: 'error', error: error.message }); throw error; });
        state.instances.set(id, slot);
        return slot.starting;
    }
    async handleCall(instance, message) {
        const task = instance.pending.get(message.taskId);
        try {
            if (/^(terminal\.|files\.|context\.read$)/.test(message.method || '')) task?.requireBackend();
            if (!task?.valid()) throw new Error('插件调用已失效');
            const params = jsonValue(message.params);
            const permission = PERMISSION[message.method];
            const stateMethod = ['state.read', 'state.write'].includes(message.method);
            if (message.method !== 'ui.publish' && !stateMethod && (!permission || !instance.manifest.permissions.includes(permission))) throw new Error('插件未声明此能力');
            if (['prompt', 'event'].includes(task.kind) && !['context.read', 'notifications.send', 'ui.publish', 'state.read', 'state.write'].includes(message.method)) throw new Error('此生命周期阶段不能执行操作');
            let value;
            if (stateMethod) {
                const state = this.state(instance.owner), id = instance.manifest.id;
                if (state.instances.get(id) !== instance || this.manager.records.get(id)?.digest !== instance.digest) throw new Error('插件版本已变化，不能访问会话状态');
                let entry = state.sessionData.get(id);
                if (!entry || entry.digest !== instance.digest) entry = { digest: instance.digest, revision: 0, value: null };
                if (message.method === 'state.write') {
                    if (!Number.isSafeInteger(params.revision) || params.revision !== entry.revision) throw new Error('会话状态已变化，请重新读取后重试');
                    entry = { digest: instance.digest, revision: entry.revision + 1, value: jsonValue(params.value, 32768) };
                    state.sessionData.set(id, entry);
                }
                value = { revision: entry.revision, value: entry.value };
            } else if (message.method === 'ui.publish') {
                if (!instance.manifest.panels.some(p => p.id === params.id)) throw new Error('面板未声明');
                const panel = jsonValue(params.panel, 65536);
                if (!panel || !['text', 'table', 'log'].includes(panel.type)) throw new Error('面板类型无效');
                instance.panels.set(params.id, panel); this.changed(instance.owner); value = true;
            } else if (message.method === 'services.call') {
                if (!Object.hasOwn(instance.manifest.dependencies, params.pluginId) || task.chain.includes(params.pluginId)) throw new Error('服务依赖未声明或发生循环调用');
                value = await this.invoke(instance.owner, params.pluginId, 'service', params.id, params.params, { signal: task.controller.signal, binding: task.binding, instance: task.dependencies.get(params.pluginId), dependencies: task.dependencies, chain: [...task.chain, params.pluginId], onBackendUsed: () => task.requireBackend(), hidden: true });
            } else value = await this.service(instance.owner, message.method, params, task);
            if (!task.valid()) throw new Error('插件调用已失效');
            instance.post({ type: 'response', id: message.id, value: jsonValue(value === undefined ? null : value) });
        } catch (error) { instance.post({ type: 'response', id: message.id, error: String(error.message).slice(0, 2000) }); }
    }
    async invoke(owner, id, kind, name, params = {}, options = {}) {
        const binding = options.binding || this.capture(owner, options);
        const instance = options.instance || await this.ensure(owner, id);
        if (options.signal?.aborted) throw new Error('插件任务已取消');
        let timeoutMs = options.timeoutMs || 60000;
        if (kind === 'tool') {
            const tool = instance.info.tools.find(t => t.id === name);
            if (!tool) throw new Error('插件工具不存在');
            params = validate(tool.inputSchema, params); timeoutMs = tool.timeoutMs;
            if (instance.manifest.runtime === 'mcp' && tool.destructive) await this.service(owner, 'mcp.audit', { title: tool.title, params }, { signal: options.signal || new AbortController().signal, valid: () => this.current(instance) });
        }
        if (!this.current(instance) || options.signal?.aborted) throw new Error('插件实例已失效');
        if (instance.pending.size >= 8) throw new Error('此插件并发任务过多');
        const state = this.state(owner), controller = new AbortController(), taskId = crypto.randomUUID();
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const dependencies = options.dependencies || new Map(this.manager.dependencies(id).map(dep => [dep, state.instances.get(dep)]).filter(([, dependency]) => dependency?.child));
        for (const dependency of dependencies.values()) dependency.leases = (dependency.leases || 0) + 1;
        const task = { id: taskId, pluginId: id, instance, dependencies, version: instance.manifest.version, kind, name, binding, controller, signal: controller.signal, state: 'running', startedAt: Date.now(), output: '', result: null, error: '', disposables: new Set(), chain: options.chain || [id], onOutput: options.onOutput, hidden: options.hidden || kind !== 'tool' };
        task.onOutput = value => { options.onOutput?.(value); this.changed(owner); };
        task.requireBackend = () => { task.backendUsed = true; options.onBackendUsed?.(); };
        task.valid = () => !controller.signal.aborted && (!task.backendUsed || binding.valid()) && this.current(instance) && instance.pending.get(taskId) === task;
        task.finish = (error, result) => {
            if (!instance.pending.has(taskId)) return;
            if (!task.valid() && !error) error = new Error('插件任务已失效');
            instance.pending.delete(taskId); clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
            if (task.aiHandle) owner.aiRequests?.delete(task.aiHandle);
            task.endedAt = Date.now(); task.state = controller.signal.aborted ? 'cancelled' : error ? 'error' : 'completed';
            task.error = error?.message || '';
            if (task.hidden && error && !controller.signal.aborted) instance.error = task.error;
            const serialized = error ? '' : JSON.stringify(result ?? null);
            task.result = error ? null : serialized.length <= 65536 ? result : { truncated: true, preview: serialized.slice(0, 65536) };
            controller.abort();
            for (const dispose of task.disposables) { try { dispose(); } catch {} }
            task.disposables.clear(); instance.lastUse = Date.now();
            for (const dependency of dependencies.values()) {
                dependency.leases--;
                if (dependency.draining && !dependency.pending.size && !dependency.leases) this.stop(dependency);
            }
            if (!task.hidden && this.owned(owner)) {
                this.taskEvent(owner, task); void this.emit(owner, `task.${task.state}`, this.describeTask(task));
            }
            this.changed(owner);
            if (instance.draining && !instance.pending.size && !instance.leases) this.stop(instance);
            error ? reject(error) : resolve(result);
        };
        const abort = () => {
            if (!instance.pending.has(taskId)) return;
            controller.abort(); instance.post({ type: 'cancel', id: taskId }); task.finish(new Error('插件任务已取消'));
            const deadline = setTimeout(() => { instance.cancelTimers.delete(taskId); this.stop(instance, true); }, 1500); deadline.unref?.();
            instance.cancelTimers.set(taskId, deadline);
        };
        task.cancel = abort;
        if (options.mode === 'takeover' || kind === 'model') {
            task.aiHandle = { destroy: abort }; owner.aiRequests ||= new Set(); owner.aiRequests.add(task.aiHandle);
        }
        const timer = setTimeout(() => { abort(); this.stop(instance, true); }, timeoutMs);
        instance.pending.set(taskId, task); state.tasks.push(task);
        while (state.tasks.length > 100 && state.tasks.some(t => t.state !== 'running')) state.tasks.splice(state.tasks.findIndex(t => t.state !== 'running'), 1);
        options.signal?.addEventListener('abort', abort, { once: true });
        instance.post({ type: 'invoke', id: taskId, kind, name, params: jsonValue(params) });
        if (!task.hidden) { this.taskEvent(owner, task); void this.emit(owner, 'task.started', this.describeTask(task)); }
        options.onStart?.(taskId);
        this.changed(owner);
        return promise;
    }
    startTool(owner, id, tool, params) {
        return new Promise((resolve, reject) => {
            this.invoke(owner, id, 'tool', tool, params, { onStart: taskId => resolve({ taskId }) }).catch(reject);
        });
    }
    describeTask(task) {
        return redactSensitive({ id: task.id, pluginId: task.pluginId, version: task.version, name: task.name, target: task.binding.target, state: task.state, startedAt: task.startedAt, endedAt: task.endedAt, output: task.output, result: task.result, error: task.error });
    }
    snapshot(owner, id) {
        const instance = this.owners.get(owner)?.instances.get(id);
        return { status: instance?.status || (instance?.starting ? 'loading' : owner.pluginIds.has(id) ? 'idle' : 'disabled'), error: redactSensitive(instance?.error || ''), tools: instance?.info?.tools, panels: [...(instance?.panels || [])].map(([id, panel]) => ({ id, ...panel })), tasks: (this.owners.get(owner)?.tasks || []).filter(t => t.pluginId === id && !t.hidden).map(t => this.describeTask(t)) };
    }
    cancel(owner, taskId) {
        const task = this.owners.get(owner)?.tasks.find(t => t.id === taskId && !t.hidden);
        if (!task || task.state !== 'running') throw new Error('任务不存在或已结束');
        task.cancel();
        // A plugin ignoring AbortSignal must not retain the event loop indefinitely.
        const instance = task.instance;
        if (instance?.child && !instance.pending.size && !instance.leases) this.stop(instance);
    }
    stop(instance, preserveError = false) {
        if (!instance?.child || instance.status === 'stopped' || instance.stopping) return;
        instance.stopping = true;
        instance.status = preserveError ? 'error' : 'stopped';
        if (preserveError && !instance.error) instance.error = '插件启动、执行超时或未响应取消，宿主已停止';
        clearInterval(instance.idleTimer);
        for (const task of [...instance.pending.values()]) task.cancel();
        instance.panels.clear(); instance.post({ type: 'stop' });
        const kill = setTimeout(() => { try { instance.child.kill(); } catch {} this.hosts.delete(instance); }, 1000); kill.unref?.();
        instance.child.once('exit', () => clearTimeout(kill));
        this.changed(instance.owner);
    }
    disable(owner, id) {
        const state = this.owners.get(owner);
        state?.instances.delete(id);
        state?.sessionData.delete(id);
        for (const instance of this.hosts) if (instance.owner === owner && instance.manifest.id === id) this.stop(instance);
    }
    async prepare(owner, record, config) {
        const records = new Map(this.manager.records); records.set(record.manifest.id, record);
        for (const dependency of this.manager.dependencies(record.manifest.id, new Set(), records)) {
            if (!owner.pluginIds.has(dependency)) throw new Error(`请先在受影响标签启用新依赖 ${dependency}`);
            if (records.get(dependency).manifest.schemaVersion === 2) await this.ensure(owner, dependency);
        }
        return this.start(owner, record, config);
    }
    adopt(owner, id, instance) {
        const state = this.state(owner), old = state.instances.get(id);
        state.instances.set(id, instance);
        if (state.sessionData.get(id)?.digest !== instance.digest) state.sessionData.delete(id);
        if (old?.child) { old.draining = true; if (!old.pending.size && !old.leases) this.stop(old); }
        this.changed(owner);
    }
    async prompt(owner, options = {}) {
        const parts = [];
        for (const id of owner.pluginIds) {
            if (this.manager.records.get(id)?.manifest.schemaVersion !== 2) continue;
            try {
                const instance = await this.ensure(owner, id);
                for (const name of instance.info.prompts) parts.push(String(await this.invoke(owner, id, 'prompt', name, {}, { ...options, hidden: true, timeoutMs: 5000 })).slice(0, 12000));
            } catch (error) { parts.push(`[${id} 插件不可用：${error.message}]`); }
        }
        return parts.join('\n').slice(0, 32000);
    }
    async toolDefinitions(owner) {
        const entries = new Map();
        let bytes = 0;
        for (const id of owner.pluginIds) {
            if (this.manager.records.get(id)?.manifest.schemaVersion !== 2) continue;
            try {
                const instance = await this.ensure(owner, id);
                for (const tool of instance.info.tools) {
                    const name = 'ait_' + crypto.createHash('sha256').update(id + ':' + tool.id).digest('hex').slice(0, 24);
                    const entry = {
                        pluginId: id, toolId: tool.id, digest: instance.digest,
                        activation: this.manager.activations.get(owner.pluginIds)?.get(id) || 0,
                        definition: {
                            type: 'function',
                            function: {
                                name, description: `${id}/${tool.id}: ${tool.description}`,
                                parameters: {
                                    type: 'object',
                                    properties: { target: { type: 'string', enum: ['local', 'remote'] }, arguments: tool.inputSchema },
                                    required: ['arguments'], additionalProperties: false
                                }
                            }
                        }
                    };
                    const size = Buffer.byteLength(JSON.stringify(entry.definition));
                    if (bytes + size > 128 * 1024) continue;
                    bytes += size; entries.set(name, entry);
                    if (entries.size >= 128) return entries;
                }
            } catch {}
        }
        return entries;
    }
    async emit(owner, event, payload) {
        for (const id of [...owner.pluginIds]) {
            const current = this.owners.get(owner)?.instances.get(id);
            if (current?.status !== 'running' || !current.info.events?.includes(event)) continue;
            try {
                const instance = await this.ensure(owner, id);
                if (instance.info.events.includes(event)) await this.invoke(owner, id, 'event', event, payload, { hidden: true, timeoutMs: 15000 });
            } catch {} // State/error is shown in the plugin center; one subscriber cannot stop others.
        }
    }
    dispose(owner) {
        const state = this.owners.get(owner); if (state) state.closed = true;
        for (const instance of this.hosts) if (instance.owner === owner) this.stop(instance);
        this.owners.delete(owner);
    }
    close() { for (const owner of [...this.owners.keys()]) this.dispose(owner); for (const instance of this.hosts) this.stop(instance); }
}
module.exports = { PluginRuntime, launchUtilityHost, hostEnvironment };
