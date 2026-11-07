'use strict';
// This bootstrap is shipped inside app.asar. No ELECTRON_RUN_AS_NODE is used.
const { AsyncLocalStorage } = require('async_hooks');
const { jsonValue } = require('./pluginJson');
const scope = new AsyncLocalStorage();
const pending = new Map(), tasks = new Map();
const maps = { tool: new Map(), prompt: new Map(), model: new Map(), service: new Map(), event: new Map() };
const port = process.parentPort;
const send = message => port ? port.postMessage(message) : process.send?.(message);
let seq = 0, fiber, pluginContext, manifest, stopping = false;
function call(method, params) {
    const task = scope.getStore();
    if (!task || task.controller.signal.aborted || stopping) return Promise.reject(new Error('调用作用域已结束'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, taskId: task.id });
        send({ type: 'call', id, taskId: task.id, method, params: jsonValue(params ?? {}) });
    });
}
function sdk(ctx, config) {
    function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
    freeze(config);
    const effect = fn => (scope.getStore()?.ctx || ctx).effect(fn);
    function register(kind, id, handler) {
        if (typeof id !== 'string' || typeof handler !== 'function' || maps[kind].has(id)) throw new Error('插件注册无效或重复');
        const declared = { tool: 'tools', model: 'models', service: 'services' }[kind];
        if (declared && !manifest[declared]?.some(item => item.id === id)) throw new Error(`未在清单声明 ${kind}:${id}`);
        if (maps[kind].size >= 32) throw new Error('插件注册过多');
        maps[kind].set(id, handler);
        return effect(() => () => { maps[kind].delete(id); });
    }
    const api = {
        apiVersion: require('./pluginManifestV2').API_VERSION, cordis: ctx, config: Object.freeze(config),
        tools: { register: (id, fn) => register('tool', id, fn) },
        prompts: { register: (id, fn) => register('prompt', id, fn) },
        models: { register: (id, fn) => register('model', id, fn), request: params => call('models.request', params) },
        services: { register: (id, fn) => register('service', id, fn), call: (pluginId, id, params) => call('services.call', { pluginId, id, params }) },
        events: { on: (id, fn) => register('event', id, fn) },
        terminal: {
            exec: params => call('terminal.exec', params),
            open: params => call('terminal.open', params),
            read: (sessionId, options = {}) => call('terminal.read', { sessionId, ...options }),
            write: (sessionId, text) => call('terminal.write', { sessionId, text }),
            resize: (sessionId, cols, rows) => call('terminal.resize', { sessionId, cols, rows }),
            close: sessionId => call('terminal.close', { sessionId })
        },
        files: { read: path => call('files.read', { path }), write: (path, text) => call('files.write', { path, text }) },
        context: { read: () => call('context.read', {}) },
        notifications: { send: params => call('notifications.send', params) },
        ui: { publish: (id, panel) => call('ui.publish', { id, panel }) },
        state: { read: () => call('state.read', {}), write: (value, revision) => call('state.write', { value, revision }) },
        progress: value => { const task = scope.getStore(); if (task && !task.controller.signal.aborted) send({ type: 'progress', taskId: task.id, value: jsonValue(value, 65536) }); },
        onDispose: fn => effect(() => fn),
        effect,
        setInterval: (fn, ms) => effect(() => { const timer = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, Math.max(100, ms)); return () => clearInterval(timer); })
    };
    Object.defineProperty(api, 'signal', { get: () => scope.getStore()?.controller.signal });
    return Object.freeze(api);
}
async function initialize(message) {
    manifest = message.manifest;
    send({ type: 'loading', stage: 'framework' });
    const { Context } = await import('cordis');
    const root = new Context();
    fiber = root.plugin(async ctx => {
        pluginContext = ctx;
        const api = sdk(ctx, message.config);
        send({ type: 'loading', stage: 'entry' });
        if (manifest.runtime === 'mcp') {
            const { activateMcp } = require('./pluginMcpHost');
            await activateMcp(api, manifest, stage => send({ type: 'loading', stage }));
        } else {
            const module = require(message.entry);
            const activate = module.activate || module.default || module;
            if (typeof activate !== 'function') throw new Error('插件必须导出 activate(ctx, config)');
            const dispose = await activate(api, message.config);
            if (typeof dispose === 'function') api.onDispose(dispose);
        }
        for (const tool of manifest.tools || []) if (!maps.tool.has(tool.id)) throw new Error(`工具未注册：${tool.id}`);
        for (const model of manifest.models || []) if (!maps.model.has(model.id)) throw new Error(`模型未注册：${model.id}`);
    });
    await fiber;
    send({ type: 'ready', tools: manifest.tools, prompts: [...maps.prompt.keys()], models: [...maps.model.keys()], events: [...maps.event.keys()], services: [...maps.service.keys()] });
}
async function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'init') {
        if (manifest) return;
        try { await initialize(message); }
        catch (e) { send({ type: 'fatal', error: String(e.message).slice(0, 2000) }); }
    } else if (message.type === 'response') {
        const item = pending.get(message.id); if (!item) return;
        pending.delete(message.id);
        message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
    } else if (message.type === 'invoke') {
        const controller = new AbortController(), task = { id: message.id, controller };
        tasks.set(message.id, task);
        try {
            const handler = maps[message.kind]?.get(message.name);
            if (stopping || !handler) throw new Error('插件扩展未注册或正在停止');
            task.fiber = pluginContext.plugin(async ctx => { task.ctx = ctx; task.value = await scope.run(task, () => handler(message.params)); });
            await task.fiber;
            await task.fiber.dispose();
            const value = task.value;
            if (!controller.signal.aborted) send({ type: 'result', id: message.id, value: jsonValue(value === undefined ? null : value) });
        } catch (e) { if (!controller.signal.aborted) send({ type: 'result', id: message.id, error: String(e.message).slice(0, 2000) }); }
        finally {
            controller.abort();
            await task.fiber?.dispose();
            tasks.delete(message.id);
            if (task.cancelled) send({ type: 'cancelled', id: message.id });
        }
    } else if (message.type === 'cancel') {
        const task = tasks.get(message.id);
        if (task) { task.cancelled = true; task.controller.abort(); }
        else send({ type: 'cancelled', id: message.id });
        for (const [id, entry] of pending) if (entry.taskId === message.id) { pending.delete(id); entry.reject(new Error('任务已取消')); }
    } else if (message.type === 'stop') {
        stopping = true;
        for (const task of tasks.values()) task.controller.abort();
        for (const entry of pending.values()) entry.reject(new Error('插件已停用'));
        pending.clear();
        try { await fiber?.dispose(); } finally { send({ type: 'stopped' }); process.exit(0); }
    }
}
if (port) port.on('message', event => { void receive(event.data); });
else process.on('message', message => { void receive(message); });
process.on('disconnect', () => process.exit(0));
send({ type: 'booted' });
