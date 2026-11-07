const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { Client } = require('ssh2');
const https = require('https');
const { decodeTerminalInput } = require('./lib/terminalInput');
if (!app.isPackaged && process.env.AITERMINAL_CLIPBOARD_SMOKE === '1' && process.env.AITERMINAL_SMOKE_USER_DATA) {
    app.setPath('userData', process.env.AITERMINAL_SMOKE_USER_DATA);
}
const { auditCommand } = require('./lib/securityAudit');
const { normalizeConfiguredApiBaseUrl, validateApiBaseUrl } = require('./lib/apiSecurity');
const { createVerifiedServerTrust, isTrustedRemoteSession, serverIdentity } = require('./lib/serverTrust');
const {
    inspectHostKey,
    parseKnownHosts,
    rememberHostKey,
    serializeKnownHosts
} = require('./lib/knownHosts');
const { SecureStore } = require('./lib/secureStore');
const { appEventToWebhook, normalizeWebhookConfig, sendWebhook, validateWebhookUrl, validateOutputRules } = require('./lib/webhook');
const { createProgramObserver, monitoredCommand, ProgramMarkers } = require('./lib/terminalNotifications');
const {
    activateTabSession,
    closeTabSession,
    createTabRegistry,
    getTabSession,
    formatTabEvent,
    openTabSession
} = require('./lib/tabRegistry');
const { routeTabEvent } = require('./lib/tabEventRouter');
const {
    beginBackendLease,
    cancelBackendLease,
    ownsBackendLease,
    releaseBackendLease
} = require('./lib/backendLease');
const { sanitizeTerminalSize } = require('./lib/terminalSize');
const { PluginManager } = require('./lib/pluginManager');
const { registerPluginIpc } = require('./lib/pluginIpc');
const { parsePluginCall, parsePluginToolCall } = require('./lib/pluginManifest');
const { PluginRuntime } = require('./lib/pluginRuntime');
const { createPluginServices } = require('./lib/pluginServices');
const { requestChat, cancelAiRequests } = require('./lib/aiClient');
const { normalizeApiFormat } = require('./lib/aiProtocol');
const { createLocalEnvironment, terminalLaunch, commandSpec, terminalDirectory, executeInEnvironment } = require('./lib/localEnvironment');
const { quotePosix, wrapDirectCommand } = require('./lib/shellCommand');
let pluginManager;
let pluginRuntime;
const pendingWebhookDeliveries = new Set();
function getPluginManager() {
    if (!pluginManager) pluginManager = new PluginManager({
        filePath: path.join(app.getPath('userData'), 'plugins.json'),
        catalog: require('./plugins/catalog')
    });
    return pluginManager;
}
function capturePluginBinding(owner, options = {}) {
    const win = getWindowForConnectionInfo(owner);
    const validOwner = () => ownsTabConnection(win, owner);
    const remote = options.mode === 'host' ? false : options.mode === 'takeover' ? options.target === 'remote' : !!owner.sshStream;
    if (remote) {
        const connection = owner.sshConnection, stream = owner.sshStream;
        return { target: 'remote', shell: 'posix', cwd: owner.currentWorkingDirectory, connection, backend: stream, valid: () => validOwner() && !!connection && owner.sshConnection === connection && owner.sshStream === stream };
    }
    // MCP stdio servers are explicitly configured host processes. Terminal/file
    // services, including takeover tools, always use the tab's terminal system.
    if (options.mode === 'host') return { target: 'local', shell: process.platform === 'win32' ? 'powershell' : 'posix', cwd: os.homedir(), valid: validOwner };
    if (options.mode === 'takeover') {
        const binding = owner.localTakeoverBinding;
        return { ...binding, target: 'local', shell: binding?.environment?.shell || 'posix', cwd: owner.localWorkingDirectory,
            valid: () => validOwner() && !!binding && owner.localTakeoverBinding === binding && binding.valid() };
    }
    const session = getLocalTerminalMap(owner)?.get(owner.tabId);
    const valid = () => validOwner() && !!session?.active && getLocalTerminalMap(owner)?.get(owner.tabId) === session && !owner.sshStream;
    return { target: 'local', shell: session?.environment?.shell || 'posix', cwd: session?.cwd, environment: session?.environment, backend: session, valid,
        resolveCwd: () => terminalDirectory(session, null, valid) };
}
function getPluginRuntime() {
    if (pluginRuntime) return pluginRuntime;
    const changed = owner => {
        if (owner.pluginChangeTimer) return;
        owner.pluginChangeTimer = setTimeout(() => { owner.pluginChangeTimer = null; const win = getWindowForConnectionInfo(owner); if (ownsTabConnection(win, owner)) win.webContents.send('plugins-changed'); }, 80);
    };
    const service = createPluginServices({
        capture: capturePluginBinding, getPty: getNodePty,
        observe: (owner, binding, command) => observeProgram(owner, binding.target, 'plugin', command),
        approve: (owner, command, audit, binding) => confirmAuditedCommand(getWindowForConnectionInfo(owner), owner, command, audit, { target: binding.target, backend: binding.backend, signal: binding.signal }),
        model: async (owner, params, task) => {
            if (!Array.isArray(params.messages) || params.messages.length > 256) throw new Error('模型请求 messages 无效');
            const config = { ...validateAiConfig(getAiConfig(owner)) };
            if (typeof params.model === 'string') config.model = params.model;
            if (typeof params.temperature === 'number') config.temperature = params.temperature;
            return requestChat({ config, messages: params.messages, maxTokens: params.maxTokens, streaming: params.streaming === true, onUpdate: text => task.onOutput?.(text), owner, signal: task.signal, ...(params.allowTools === false ? {} : await pluginModelTools(owner)) });
        },
        notify: async (owner, params, task) => {
            const config = getWindowStateForConnectionInfo(owner)?.webhookConfig;
            if (!config?.enabled) throw new Error('请在连接配置中启用 Webhook 并填写 URL');
            const event = params.event || 'task_completed';
            if (!config.events.includes(event)) throw new Error('此通知事件未启用');
            let last;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (task.signal.aborted) throw new Error('通知已取消');
                try { await sendWebhook(config, event, { tabId: owner.tabId, taskId: task.id, pluginId: task.pluginId, message: String(params.message || '').slice(0, 2000) }); task.notificationDelivered = true; return { delivered: true, attempts: attempt + 1 }; }
                catch (error) { last = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); }
            }
            throw last;
        },
        context: (owner, task) => ({ tabId: owner.tabId, target: task.binding.target, shell: task.binding.shell, cwd: task.binding.cwd, recentOutput: String(owner.lastTerminalOutput || owner.lastLocalOutput || '').slice(-12000), task: owner.aiTakeoverTask || '' })
    });
    pluginRuntime = new PluginRuntime({ manager: getPluginManager(), owned: owner => ownsTabConnection(getWindowForConnectionInfo(owner), owner), capture: capturePluginBinding, service, changed,
        taskEvent: (owner, task) => { if (!task.notificationDelivered) queueWebhookEvent(owner, task.state === 'running' ? 'task_started' : task.state === 'completed' ? 'task_completed' : 'task_error', { taskId: task.id, pluginId: task.pluginId, status: task.state, message: task.error || `${task.name} ${task.state}`, dedupeKey: task.id }); }
    });
    return pluginRuntime;
}
async function pluginModelTools(owner) {
    if (!owner?.aiTakeoverMode) return {};
    const mode = owner.aiTakeoverTarget || 'remote';
    const bindings = Object.fromEntries(['local', 'remote'].map(target => [target, capturePluginBinding(owner, { mode: 'takeover', target })]));
    const definitions = await getPluginRuntime().toolDefinitions(owner);
    return {
        tools: [...definitions.values()].map(t => t.definition),
        onToolCall: async (name, params, signal) => {
            const tool = definitions.get(name);
            if (!tool || !params || typeof params !== 'object') throw new Error('工具调用无效');
            const target = params.target || (mode === 'local' ? 'local' : 'remote');
            if (!['local', 'remote'].includes(target) || (mode !== 'hybrid' && target !== mode) || !owner.aiTakeoverMode || (owner.aiTakeoverTarget || 'remote') !== mode) throw new Error('工具超出当前接管目标');
            if (!bindings[target].valid()) throw new Error('模型请求期间执行目标已变化，请重新规划');
            if (target === 'local' && !owner.localTakeoverInitialDir) throw new Error('请先配置本地接管工作目录');
            if (!getPluginManager().isCurrent(owner.pluginIds, tool.pluginId, tool.digest, tool.activation)) throw new Error('模型请求期间插件已停用或更新，请重新规划');
            return getPluginRuntime().invoke(owner, tool.pluginId, 'tool', tool.toolId, params.arguments, { signal, binding: bindings[target], mode: 'takeover', target });
        }
    };
}

let mainWindow;
let windows = new Map(); // 存储所有窗口实例
let windowConnections = new Map(); // 存储每个窗口的SSH连接信息
let cachedNodePty = undefined; // null | module
let secureStore = null;
let knownHosts = null;
const memorySecrets = new Map();
const tabExecutionContext = new AsyncLocalStorage();
const INTERNAL_SECURITY_APPROVAL = Symbol('internal-security-approval');

// 窗口连接信息结构
function createEmptyContextGraph() {
    return {
        nodeSeq: 0,
        lastHistoryIndexed: -1,
        lastCompressedIndex: -1,
        nodes: {},          // id -> { id, type: 'msg'|'summary', role, content, ts, children: [], level }
        historyNodeIds: [], // 按历史顺序对应 aiTakeoverHistory 的节点id
        layers: []          // [{ id, start, end, summaryId, ts }]
    };
}

function createTabConnectionInfo(tabId = 'tab-1') {
    return {
        tabId,
        pluginIds: getPluginManager().defaultIds(),
        sshConnection: null,
        sshStream: null,
        sshServerIdentity: '',
        sshHostFingerprint: '',
        sshExecutionTrust: null,
        sshConnectAttempt: null,
        currentWorkingDirectory: '/',
        // Local machine execution context (for local/hybrid AI takeover)
        localTakeoverInitialDir: null,
        localWorkingDirectory: null,
        localTakeoverBinding: null,
        localTerminalContext: null,
        localCommandControllers: new Set(),
        lastLocalOutput: '',
        // Local interactive session (best-effort; prefers node-pty if installed)
        localInteractive: null,
        // Real local terminal sessions shown in xterm.js; one PTY/process per renderer tab.
        localTerminals: new Map(),
        aiConversationHistory: [],
        lastTerminalOutput: '',
        aiTakeoverMode: false,
        aiTakeoverTask: '',
        // 'remote' | 'local' | 'hybrid'
        aiTakeoverTarget: 'remote',
        aiTakeoverHistory: [],
        aiTakeoverInitialDir: '/',
        aiTakeoverInterrupted: false,
        pendingPlanConfirm: null,
        currentAiReq: null,
        currentExecStart: null,
        aiTakeoverContextSize: 0,
        contextCompressed: false,
        lastCompressionTime: null,
        // 执行模式: 'direct' 直传到交互会话, 'exec' 使用 exec()
        executeMode: 'direct',
        // 直传执行时的输出捕获状态
        directCapture: null,
        // 分层上下文索引（MCP）
        contextGraph: createEmptyContextGraph(),
        replMode: null,         // e.g. 'python' | 'cli:codex'
        replTarget: null,       // 'remote' | 'local'
        replBuffer: '',
        replLastOutputAt: 0,
        replPendingContinue: false,
        replPendingHasOutput: false,
        replPendingSince: 0,
        replIdleMs: 600,
        replTimeoutMs: 15000,
        replContinueTimer: null,
        replHardTimeoutTimer: null,
        replWaiter: null,
        replWaiterTimer: null,
        // AI configuration and execution state belong to this tab.
        aiConfig: createDefaultAiConfig()
    };
}

function createWindowConnectionInfo() {
	const state = {
	    ...createTabRegistry(createTabConnectionInfo, 'tab-1'),
	    webhookConfig: normalizeWebhookConfig(),
	    webhookDedup: new Map()
	};
	return state;
}

// AI功能相关变量
function createDefaultAiConfig() {
    return {
        apiKey: null,
        baseUrl: 'https://api.openai.com',
        apiFormat: 'auto',
        model: 'gpt-3.5-turbo',
        maxTokens: 1000,
        temperature: 0.7,
        customRequirements: '',
        showFullConversation: false,
        contextCompressionThreshold: 100000
    };
}

let aiConfig = createDefaultAiConfig();

function getAiConfig(connectionInfo = null) {
    return connectionInfo?.aiConfig || aiConfig;
}

function getSecureStore() {
    if (secureStore) return secureStore;
    if (!app.isReady()) return null;
    secureStore = new SecureStore({
        safeStorage,
        filePath: path.join(app.getPath('userData'), 'secure-secrets.json')
    });
    return secureStore;
}

function getKnownHostsPath() {
    return path.join(app.getPath('userData'), 'known_hosts');
}

function getKnownHosts() {
    if (knownHosts) return knownHosts;
    try {
        knownHosts = parseKnownHosts(fs.readFileSync(getKnownHostsPath(), 'utf8'));
    } catch {
        knownHosts = new Map();
    }
    return knownHosts;
}

function saveKnownHosts() {
    const filePath = getKnownHostsPath();
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, serializeKnownHosts(getKnownHosts()), { mode: 0o600 });
    try { fs.chmodSync(temporaryPath, 0o600); } catch {}
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
}

function credentialScope(config = {}) {
    const host = String(config.host || '').trim().toLowerCase();
    const port = Number.parseInt(config.port, 10) || 22;
    const username = String(config.username || '').trim();
    const authMethod = config.authMethod === 'privateKey' ? 'privateKey' : 'password';
    const privateKeyPath = authMethod === 'privateKey' ? String(config.privateKeyPath || '').trim() : '';
    return `${host}|${port}|${username}|${authMethod}|${privateKeyPath}`;
}

function apiSecretScope(rawBaseUrl) {
    const validation = validateApiBaseUrl(rawBaseUrl || 'https://api.openai.com');
    return validation.valid ? validation.value : `invalid:${String(rawBaseUrl || '').trim()}`;
}

function secretKey(kind, scope) {
    const digest = crypto.createHash('sha256').update(`${kind}|${scope}`).digest('hex');
    return `aiterminal.${kind}.${digest}`;
}

function loadSecret(key) {
    if (memorySecrets.has(key)) return { success: true, value: memorySecrets.get(key), persisted: false };
    const store = getSecureStore();
    if (!store?.isAvailable()) return { success: true, value: null, persisted: false };
    const result = store.load(key);
    if (result.success && result.value) memorySecrets.set(key, result.value);
    return { ...result, persisted: result.success && !!result.value };
}

function saveSecret(key, value) {
    memorySecrets.set(key, value);
    const store = getSecureStore();
    if (!store?.isAvailable()) {
        return { success: true, persisted: false, warning: 'secure-storage-unavailable' };
    }
    const result = store.save(key, value);
    return { ...result, persisted: result.success };
}

function deleteSecret(key) {
    memorySecrets.delete(key);
    const store = getSecureStore();
    if (!store?.isAvailable()) return { success: true, persisted: false };
    return store.delete(key);
}

function loadStoredSecrets(config = {}) {
    const scope = credentialScope(config);
    const ssh = loadSecret(secretKey('ssh', scope));
    const aiScope = apiSecretScope(config.aiBaseUrl);
    const ai = loadSecret(secretKey('ai', aiScope));
    return {
        ...(ssh.success && ssh.value ? { ssh: ssh.value } : {}),
        ...(ai.success && ai.value ? { ai: ai.value } : {})
    };
}

function saveProvidedSecrets(config = {}, options = {}) {
    const scope = credentialScope(config);
    let persisted = true;
    if (options.saveSsh !== false && (config.password || config.passphrase)) {
        const result = saveSecret(secretKey('ssh', scope), {
            password: typeof config.password === 'string' ? config.password : '',
            passphrase: typeof config.passphrase === 'string' ? config.passphrase : ''
        });
        if (!result.success) return result;
        persisted = persisted && result.persisted !== false;
    }
    if (options.saveAi !== false && typeof config.aiApiKey === 'string' && config.aiApiKey.trim()) {
        const apiScope = apiSecretScope(config.aiBaseUrl);
        const result = saveSecret(secretKey('ai', apiScope), { apiKey: config.aiApiKey.trim() });
        if (!result.success) return result;
        persisted = persisted && result.persisted !== false;
    }
    return { success: true, persisted };
}

function resolveApiBaseUrl(value) {
    const result = validateApiBaseUrl(value);
    if (!result.valid) throw new Error(result.error);
    return result.value;
}

function publicWebhookConfig(config) {
    return { ...config, url: '', hasStoredUrl: !!config.url };
}

// 验证和清理AI配置的函数
function validateAiConfig(config = aiConfig) {
    if (typeof config.maxTokens !== 'number' || isNaN(config.maxTokens)) {
        config.maxTokens = 1000;
    }
    if (typeof config.temperature !== 'number' || isNaN(config.temperature)) {
        config.temperature = 0.7;
    }
    if (!config.model || typeof config.model !== 'string') {
        config.model = 'gpt-3.5-turbo';
    }
    config.baseUrl = normalizeConfiguredApiBaseUrl(config.baseUrl);
    config.apiFormat = normalizeApiFormat(config.apiFormat);
    return config;
}

function applyAiConfig(connectionInfo, input = {}, clearWhenDisabled = false) {
    const config = getAiConfig(connectionInfo);
    if (input.enableAI === false && clearWhenDisabled) {
        config.apiKey = null;
        return config;
    }
    const nextBaseUrl = typeof input.aiBaseUrl === 'string' && input.aiBaseUrl.trim() ? input.aiBaseUrl.trim() : config.baseUrl;
    if (apiSecretScope(nextBaseUrl) !== apiSecretScope(config.baseUrl)) config.apiKey = null;
    const stored = loadStoredSecrets({ ...input, aiBaseUrl: nextBaseUrl });
    if (typeof input.aiApiKey === 'string' && input.aiApiKey.trim()) {
        config.apiKey = input.aiApiKey.trim();
    } else if (stored.ai?.apiKey) {
        config.apiKey = stored.ai.apiKey;
    }
    if (typeof input.aiBaseUrl === 'string' && input.aiBaseUrl.trim()) config.baseUrl = input.aiBaseUrl.trim();
    config.apiFormat = normalizeApiFormat(input.aiApiFormat);
    if (typeof input.aiModel === 'string' && input.aiModel.trim()) config.model = input.aiModel.trim();
    const maxTokens = parseInt(input.aiMaxTokens, 10);
    if (Number.isFinite(maxTokens) && maxTokens > 0) config.maxTokens = maxTokens;
    const temperature = parseFloat(input.aiTemperature);
    if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) config.temperature = temperature;
    if (typeof input.aiCustomRequirements === 'string') config.customRequirements = input.aiCustomRequirements.trim();
    if (input.showFullConversation !== undefined) config.showFullConversation = input.showFullConversation === true;
    return validateAiConfig(config);
}

// 获取窗口状态的辅助函数
function getWindowState(event) {
    let win = null;
    try {
        // Some internal callers pass a lightweight mock { sender: { id } }, so guard this.
        if (event && event.sender && typeof event.sender.getURL === 'function') {
            win = BrowserWindow.fromWebContents(event.sender);
        }
    } catch {
        win = null;
    }
    if (win) return windowConnections.get(win.id);
    // Fallback: older code used webContents.id; keep a best-effort lookup.
    return windowConnections.get(event && event.sender ? event.sender.id : undefined);
}

function normalizeTabId(tabId) {
    const value = typeof tabId === 'string' ? tabId.trim() : '';
    if (!value || value.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(value)) return null;
    return value;
}

function clampText(value, maxLength = 200000) {
    const text = typeof value === 'string' ? value : String(value == null ? '' : value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeIpcConfig(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const output = { ...input };
    for (const key of ['host', 'username', 'privateKeyPath', 'aiBaseUrl', 'aiApiFormat', 'aiModel', 'aiCustomRequirements']) {
        if (output[key] !== undefined) output[key] = clampText(output[key], 4096).trim();
    }
    for (const key of ['password', 'passphrase', 'aiApiKey']) {
        if (output[key] !== undefined) output[key] = clampText(output[key], 128000);
    }
    if (output.autoCommand !== undefined) output.autoCommand = clampText(output.autoCommand, 200000);
    output.port = Number.parseInt(output.port, 10) || 22;
    return output;
}

// Look up the tab session captured by the IPC caller. Session creation is only
// allowed through tab-open, so late IPC from a closed tab cannot resurrect it.
function getWindowConnectionInfo(event, tabId = null) {
	const state = getWindowState(event);
	if (!state) return null;
	const hasExplicitTabId = tabId !== null && tabId !== undefined;
	const explicitTabId = normalizeTabId(tabId);
	if (hasExplicitTabId && !explicitTabId) return null;
	const id = explicitTabId || normalizeTabId(state.activeTabId) || 'tab-1';
	const connectionInfo = getTabSession(state, id);
	if (!connectionInfo) return null;
    tabExecutionContext.enterWith(connectionInfo);
    return connectionInfo;
}

function getWindowActiveConnectionInfo(win) {
    const state = win ? windowConnections.get(win.id) : null;
    return state ? getWindowConnectionInfo({ sender: { id: win.id } }, state.activeTabId) : null;
}

function getWindowIdForConnectionInfo(connectionInfo) {
    for (const [windowId, state] of windowConnections.entries()) {
        if (state?.tabs) {
            for (const info of state.tabs.values()) {
                if (info === connectionInfo) return windowId;
            }
        }
    }
    return null;
}

function getWindowStateForConnectionInfo(connectionInfo) {
    const windowId = getWindowIdForConnectionInfo(connectionInfo);
    return windowConnections.get(windowId) || null;
}

// 获取窗口实例的辅助函数
function getWindow(event) {
    let win = null;
    try {
        if (event && event.sender && typeof event.sender.getURL === 'function') {
            win = BrowserWindow.fromWebContents(event.sender);
        }
    } catch {
        win = null;
    }
    if (win) return win;
    // Fallback: older code used webContents.id; keep a best-effort lookup.
    return windows.get(event && event.sender ? event.sender.id : undefined);
}

function getWindowForConnectionInfo(connectionInfo) {
    const windowId = getWindowIdForConnectionInfo(connectionInfo);
    return windowId ? windows.get(windowId) || null : null;
}

function queueWebhookEvent(connectionInfo, event, data = {}, capturedState = null) {
    const state = capturedState || getWindowStateForConnectionInfo(connectionInfo);
    const config = state?.webhookConfig;
    if (!state || !config?.enabled || !config.events.includes(event)) return false;

    const now = Date.now();
    for (const [key, timestamp] of state.webhookDedup.entries()) {
        if (now - timestamp > 60000) state.webhookDedup.delete(key);
    }
    const dedupePart = data.dedupeKey || data.message || data.status || '';
    const dedupeKey = `${event}:${connectionInfo?.tabId || ''}:${String(dedupePart).slice(0, 160)}`;
    if (now - (state.webhookDedup.get(dedupeKey) || 0) < 1500) return false;
    state.webhookDedup.set(dedupeKey, now);

    const payload = {
        tabId: connectionInfo?.tabId || null,
        target: connectionInfo?.aiTakeoverTarget || null,
        ...data
    };
    delete payload.dedupeKey;
    const delivery = sendWebhook(config, event, payload).catch((error) => {
        console.warn(`Webhook ${event} failed:`, error.message);
    });
    pendingWebhookDeliveries.add(delivery);
    delivery.finally(() => pendingWebhookDeliveries.delete(delivery));
    return true;
}

function observeProgram(owner, target, source, command = '') {
    const state = getWindowStateForConnectionInfo(owner);
    const observer = createProgramObserver({
        config: () => state?.webhookConfig,
        emit: (event, data) => queueWebhookEvent(owner, event, data, state),
        target, source, command
    });
    owner.programObservers ||= new Set(); owner.programObservers.add(observer);
    const stop = observer.stop;
    observer.stop = details => { owner.programObservers.delete(observer); return stop(details); };
    return observer;
}

function observeTerminalData(backend, text) {
    backend?.notificationObserver?.output(text);
    backend?.programMonitor?.feed(text);
}

function closeTerminalNotifications(backend, details = {}) {
    backend?.programMonitor?.close(details.reason || 'connection_lost');
    backend?.notificationObserver?.stop(details);
}

function writeRemoteProgram(owner, command) {
    const backend = owner.sshStream;
    if (!backend) throw new Error('SSH 会话已关闭');
    const config = getWindowStateForConnectionInfo(owner)?.webhookConfig;
    if (!config?.enabled || !config.events.includes('program_stopped')) return backend.write(command + '\n');
    if (backend.programMonitor && !backend.programMonitor.done) throw new Error('当前标签的程序尚未退出');
    const observer = observeProgram(owner, 'remote', 'ai-interactive', command);
    backend.programMonitor = new ProgramMarkers(observer.id, observer);
    try { backend.write(monitoredCommand(command, observer.id) + '\n'); }
    catch (error) { backend.programMonitor.close('connection_lost'); throw error; }
}

function queueWebhookFromAppEvent(connectionInfo, channel, payload) {
    const mapped = appEventToWebhook(channel, payload);
    if (connectionInfo && mapped) queueWebhookEvent(connectionInfo, mapped.event, mapped.data);
    if (connectionInfo && mapped && pluginRuntime) void pluginRuntime.emit(connectionInfo, mapped.event.replace('task_', 'task.'), mapped.data);
}

function sendTabEvent(currentWindow, connectionInfo, channel, payload = {}) {
    if (!currentWindow || currentWindow.isDestroyed?.()) return false;
    const tabId = connectionInfo?.tabId || null;
	const state = windowConnections.get(currentWindow.id);
	if (!tabId || state?.tabs?.get(tabId) !== connectionInfo) return false;
	const value = formatTabEvent(channel, tabId, payload);
	currentWindow.webContents.send(channel, value);
	return true;
}

function ownsTabConnection(currentWindow, connectionInfo) {
    if (!currentWindow || currentWindow.isDestroyed?.() || !connectionInfo?.tabId) return false;
    return windowConnections.get(currentWindow.id)?.tabs?.get(connectionInfo.tabId) === connectionInfo;
}

function resetRemoteInteractiveState(connectionInfo) {
    if (!connectionInfo || connectionInfo.replTarget === 'local') return;
    try { clearReplContinueTimers(connectionInfo); } catch {}
    try { clearReplWaiter(connectionInfo); } catch {}
    connectionInfo.replMode = null;
    connectionInfo.replTarget = null;
    connectionInfo.replBuffer = '';
    connectionInfo.directCapture = null;
    connectionInfo.currentExecStart = null;
}

function disposeSshBackend(connectionInfo, reason = 'SSH connection closed') {
    if (!connectionInfo) return false;
    const activeConnection = connectionInfo.sshConnection;
    const activeStream = connectionInfo.sshStream;
    closeTerminalNotifications(activeStream, { reason: 'cancelled' });
    const hadBackend = !!(activeConnection || activeStream || connectionInfo.sshConnectAttempt);

    // Revoke active identity before end/close can synchronously emit callbacks.
    connectionInfo.sshConnection = null;
    connectionInfo.sshStream = null;
    connectionInfo.sshServerIdentity = '';
    connectionInfo.sshHostFingerprint = '';
    connectionInfo.sshExecutionTrust = null;
    connectionInfo.currentWorkingDirectory = '/';
    cancelBackendLease(connectionInfo, 'sshConnectAttempt', reason);
    resetRemoteInteractiveState(connectionInfo);

    try { activeStream?.end?.(); } catch {}
    try { activeConnection?.end?.(); } catch {}
    return hadBackend;
}

function handleActiveSshClosed(connectionInfo, currentWindow, conn, reason = '', exitCode = null, signal = null) {
    if (!connectionInfo || connectionInfo.sshConnection !== conn) return false;
    const activeStream = connectionInfo.sshStream;
    closeTerminalNotifications(activeStream, { reason: exitCode === null && !signal ? 'connection_lost' : '', exitCode, signal });
    connectionInfo.sshConnection = null;
    connectionInfo.sshStream = null;
    connectionInfo.sshServerIdentity = '';
    connectionInfo.sshHostFingerprint = '';
    connectionInfo.sshExecutionTrust = null;
    connectionInfo.currentWorkingDirectory = '/';
    resetRemoteInteractiveState(connectionInfo);
    sendTabEvent(currentWindow, connectionInfo, 'ssh-disconnected', reason);
    try { activeStream?.end?.(); } catch {}
    try { conn?.end?.(); } catch {}
    return true;
}

function disposeTabConnectionInfo(connectionInfo) {
    if (!connectionInfo) return;
    for (const observer of connectionInfo.programObservers || []) observer.stop({ reason: 'cancelled' });
    pluginRuntime?.dispose(connectionInfo);
    clearTimeout(connectionInfo.pluginChangeTimer);
    try { cancelAiRequests(connectionInfo); } catch {}
    for (const controller of connectionInfo.localCommandControllers || []) controller.abort();
    try { stopAllLocalTerminalSessions(connectionInfo); } catch {}
    try { stopLocalInteractiveSession(connectionInfo); } catch {}
    try { clearReplContinueTimers(connectionInfo); } catch {}
    try { clearReplWaiter(connectionInfo); } catch {}
    disposeSshBackend(connectionInfo, 'tab closed');
    connectionInfo.aiTakeoverMode = false;
}

ipcMain.on('tab-active', (event, tabId) => {
    const state = getWindowState(event);
    const id = normalizeTabId(tabId);
    if (!state || !id) return;
	activateTabSession(state, id);
});

ipcMain.handle('tab-open', async (event, payload = {}) => {
    const state = getWindowState(event);
    const tabId = normalizeTabId(payload.tabId);
    if (!state || !tabId) return { success: false, error: 'invalid-tab' };
    const connectionInfo = openTabSession(state, tabId);
    return connectionInfo ? { success: true, tabId } : { success: false, error: 'tab-open-failed' };
});

ipcMain.handle('tab-close', async (event, payload = {}) => {
    const state = getWindowState(event);
    const tabId = normalizeTabId(payload.tabId);
    if (!state || !tabId) return { success: false, error: 'invalid-tab' };
	const closed = closeTabSession(state, tabId, disposeTabConnectionInfo);
    return closed ? { success: true } : { success: false, error: 'unknown-tab' };
});

function getActiveClipboardTab(event, tabId) {
    const state = getWindowState(event);
    const currentWindow = getWindow(event);
    const id = normalizeTabId(tabId);
    if (!state || !currentWindow || !id || state.activeTabId !== id) return null;
    const connectionInfo = getTabSession(state, id);
    return connectionInfo && ownsTabConnection(currentWindow, connectionInfo) ? connectionInfo : null;
}

ipcMain.handle('clipboard-write-text', (event, payload = {}) => {
    const tabId = normalizeTabId(payload.tabId);
    if (!getActiveClipboardTab(event, tabId)) return { success: false, error: 'invalid-active-tab' };
    const text = typeof payload.text === 'string' ? clampText(payload.text, 2 * 1024 * 1024) : '';
    try {
        clipboard.writeText(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('clipboard-read-text', (event, payload = {}) => {
    const tabId = normalizeTabId(payload.tabId);
    if (!getActiveClipboardTab(event, tabId)) return { success: false, error: 'invalid-active-tab' };
    try {
        return { success: true, text: clampText(clipboard.readText(), 2 * 1024 * 1024) };
    } catch (error) {
        return { success: false, error: error.message, text: '' };
    }
});

// 上下文搜索（简单全文搜索，返回片段）
ipcMain.handle('ai-context-search', async (event, { query, limit = 20, tabId } = {}) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo) return { success: false, error: 'no-conn' };
    const hist = connectionInfo.aiTakeoverHistory || [];
    const results = [];
    const q = (query || '').toLowerCase();
    if (!q) return { success: true, results: [] };
    for (let i = hist.length - 1; i >= 0 && results.length < limit; i--) {
        const m = hist[i];
        const text = (m.content || '').toLowerCase();
        const pos = text.indexOf(q);
        if (pos !== -1) {
            const raw = m.content || '';
            const start = Math.max(0, pos - 40);
            const end = Math.min(raw.length, pos + query.length + 40);
            const snippet = raw.slice(start, end).replace(/\n/g, ' ');
            results.push({ index: i, role: m.role, snippet });
        }
    }
    return { success: true, results };
});

// 返回MCP索引
ipcMain.handle('ai-context-index', async (event, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo) return { success: false, error: 'no-conn' };
    const mcp = buildMcpIndex(connectionInfo);
    return { success: true, mcp };
});

// 展开摘要并注入历史
ipcMain.handle('ai-context-expand', async (event, { summaryId, keywords, tabId } = {}) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    const currentWindow = getWindow(event);
    if (!connectionInfo) return { success: false, error: 'no-conn' };
    try {
        const count = mcpExpandInject(connectionInfo, summaryId, keywords || '', currentWindow);
        return { success: true, count };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 摘要详情（返回子消息的索引、角色、摘要、是否是摘要消息）
ipcMain.handle('ai-context-summary-details', async (event, { summaryId, offset = 0, limit = 50, tabId } = {}) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo) return { success: false, error: 'no-conn' };
    const g = connectionInfo.contextGraph;
    if (!g || !g.nodes || !g.nodes[summaryId] || g.nodes[summaryId].type !== 'summary') {
        return { success: false, error: 'invalid-summary-id' };
    }
    const children = g.nodes[summaryId].children || [];
    const results = [];
    const layers = g.layers || [];
    const start = Math.max(0, parseInt(offset, 10) || 0);
    const lim = Math.max(1, parseInt(limit, 10) || 50);
    const end = Math.min(children.length, start + lim);
    for (let i = start; i < end; i++) {
        const childId = children[i];
        const idx = (g.historyNodeIds || []).findIndex(id => id === childId);
        if (idx < 0) continue;
        const msg = connectionInfo.aiTakeoverHistory[idx];
        if (!msg) continue;
        const full = msg.content || '';
        const firstLine = full.split('\n')[0];
        const snippet = firstLine.length > 180 ? firstLine.slice(0, 180) + '...' : firstLine;
        const isSummaryMsg = (msg.role === 'assistant') && /^\[执行历史摘要\s*-/.test(full);
        // 尝试查找该摘要消息对应的 summaryId（通过内容匹配）
        let nestedSummaryId = null;
        if (isSummaryMsg) {
            for (const L of layers) {
                const n = g.nodes?.[L.summaryId];
                if (n && n.content === full) { nestedSummaryId = L.summaryId; break; }
            }
        }
        results.push({ index: idx, nodeId: childId, role: msg.role, snippet, isSummaryMsg, nestedSummaryId });
    }
    const nextOffset = end;
    const hasMore = end < children.length;
    return { success: true, summaryId, results, nextOffset, hasMore, total: children.length };
});

// 获取某条历史的完整消息
ipcMain.handle('ai-context-get-message', async (event, { index, tabId } = {}) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo) return { success: false, error: 'no-conn' };
    const hist = connectionInfo.aiTakeoverHistory || [];
    if (index < 0 || index >= hist.length) return { success: false, error: 'out-of-range' };
    const m = hist[index];
    return { success: true, index, role: m.role, content: m.content };
});

ipcMain.handle('ai-clear-history', async (event, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo) return { success: false, error: 'no-tab' };
    connectionInfo.aiConversationHistory = [];
    connectionInfo.aiTakeoverHistory = [];
    connectionInfo.contextGraph = createEmptyContextGraph();
    return { success: true };
});

function createWindow() {
    const newWindow = new BrowserWindow({
        width: 1400,
        height: 900,
    useContentSize: true,                 // 新增：指定宽高指的是 webContents 内容区
    //backgroundColor: '#2d2d2d',           // 新增：与页面深色背景一致，避免闪白
	    webPreferences: {
	        nodeIntegration: false,
	        contextIsolation: true,
	        sandbox: true,
	        webSecurity: true,
	        preload: path.join(__dirname, 'preload.js')
        },
        titleBarStyle: 'default',
        show: false,
        title: `AITerminal - 标签 ${windows.size + 1}`
    });

    // 如果是第一个窗口，设置为主窗口
    if (!mainWindow) {
        mainWindow = newWindow;
        // 创建Terminal风格的菜单
        createTerminalMenu();
    }

    // 为新窗口创建连接信息
    const windowId = newWindow.id;
    windows.set(windowId, newWindow);
    windowConnections.set(windowId, createWindowConnectionInfo());

    // Preserve the originating tab across nested promises, streams and timers.
    // This also covers legacy deep callbacks that still call webContents.send
    // directly instead of sendTabEvent().
    const rawSend = newWindow.webContents.send.bind(newWindow.webContents);
	newWindow.webContents.send = (channel, ...args) => {
	    const contextConnection = tabExecutionContext.getStore();
	    const route = routeTabEvent(channel, args, contextConnection?.tabId);
	    if (!route.accepted) {
	        console.warn(`Dropped unowned tab event: ${channel} (${route.reason})`);
	        return false;
	    }

	    let connectionInfo = contextConnection || null;
	    if (route.scoped) {
	        const state = windowConnections.get(windowId);
	        connectionInfo = state?.tabs?.get(route.tabId) || null;
	        if (!connectionInfo) {
	            console.warn(`Dropped event for closed or unknown tab: ${channel}`);
	            return false;
	        }
	    }

	    const result = rawSend(channel, ...route.args);
	    if (route.scoped) queueWebhookFromAppEvent(connectionInfo, channel, route.args[0]);
	    return result;
	};

	newWindow.webContents.setWindowOpenHandler(({ url }) => {
	    try {
	        const parsed = new URL(url);
	        if (parsed.protocol === 'https:') shell.openExternal(parsed.toString()).catch(() => {});
	    } catch {}
	    return { action: 'deny' };
	});
	newWindow.webContents.on('will-navigate', (event, url) => {
	    const currentUrl = newWindow.webContents.getURL();
	    if (url !== currentUrl) event.preventDefault();
	});
	newWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	newWindow.webContents.session.setPermissionCheckHandler(() => false);

	const loadOptions = !app.isPackaged && process.env.AITERMINAL_CLIPBOARD_SMOKE === '1'
	    ? { query: { 'aiterminal-clipboard-smoke': '1' } }
	    : undefined;
	newWindow.loadFile('index.html', loadOptions);
    newWindow.once('ready-to-show', () => newWindow.show());
    newWindow.on('closed', () => {
        // 清理窗口相关的连接
        const state = windowConnections.get(windowId);
        for (const connectionInfo of state?.tabs?.values?.() || []) disposeTabConnectionInfo(connectionInfo);

        // 从映射中移除窗口
        windows.delete(windowId);
        windowConnections.delete(windowId);

        // 如果关闭的是主窗口，重新指定主窗口
        if (newWindow === mainWindow) {
            const remainingWindows = Array.from(windows.values());
            mainWindow = remainingWindows.length > 0 ? remainingWindows[0] : null;
        }
    });

    return newWindow;
}

function createTerminalMenu() {
    const getTargetWindow = () => BrowserWindow.getFocusedWindow() || mainWindow;
    const template = [
        {
            label: 'Terminal',
            submenu: [
                {
                    label: '新建连接',
                    accelerator: 'CmdOrCtrl+Shift+N',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-new-connection');
                    }
                },
                {
                    label: '新建窗口',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => {
                        createWindow();
                    }
                },
                {
                    label: '新增标签',
                    accelerator: 'CmdOrCtrl+T',
                    click: () => {
                        // TODO: 实现窗口内标签功能
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-new-tab');
                    }
                },
                {
                    label: '断开连接',
                    accelerator: 'CmdOrCtrl+D',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-disconnect');
                    }
                },
                { type: 'separator' },
                {
                    label: '清屏',
                    accelerator: 'CmdOrCtrl+K',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-clear-terminal');
                    }
                },
                {
                    label: '重置终端',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-reset-terminal');
                    }
                },
                { type: 'separator' },
                {
                    label: '退出',
                    accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                    click: () => {
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'AI助手',
            submenu: [
                {
                    label: 'AI配置',
                    accelerator: 'CmdOrCtrl+Shift+A',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-ai-config');
                    }
                },
                {
                    label: '插件中心',
                    accelerator: 'CmdOrCtrl+Shift+P',
                    click: () => getTargetWindow()?.webContents.send('menu-plugin-center')
                },
                {
                    label: '测试AI连接',
                    accelerator: 'CmdOrCtrl+Shift+T',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-test-ai');
                    }
                },
                { type: 'separator' },
	            {
	                label: '清除对话历史',
	                click: () => {
	                    const win = getTargetWindow();
	                    if (win) win.webContents.send('menu-clear-ai-history');
	                }
	            }
            ]
        },
        {
            label: '文件',
            submenu: [
                {
                    label: '上传文件',
                    accelerator: 'CmdOrCtrl+U',
                    click: async () => {
                        const win = getTargetWindow();
                        if (!win) return;
                        const info = getWindowActiveConnectionInfo(win);
                        if (!info?.sshConnection) {
                            dialog.showMessageBox(win, {
                                type: 'warning',
                                title: '提示',
                                message: '请先建立SSH连接'
                            });
                            return;
                        }

                        const result = await dialog.showOpenDialog(win, {
                            title: '选择要上传的文件',
                            properties: ['openFile', 'multiSelections'],
                            filters: [
                                { name: 'All Files', extensions: ['*'] }
                            ]
                        });

                        if (!result.canceled && result.filePaths.length > 0 &&
                            ownsTabConnection(win, info) && info.sshConnection) {
                            win.webContents.send('menu-upload-files', {
                                tabId: info.tabId,
                                filePaths: result.filePaths
                            });
                        }
                    }
                },
                {
                    label: '下载文件',
                    accelerator: 'CmdOrCtrl+Shift+D',
                    click: () => {
                        const win = getTargetWindow();
                        const info = getWindowActiveConnectionInfo(win);
                        if (win && info && ownsTabConnection(win, info)) {
                            win.webContents.send('menu-download-file', { tabId: info.tabId });
                        }
                    }
                }
            ]
        },
        {
            label: '会话',
            submenu: [
                {
                    label: '保存会话',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-save-session');
                    }
                },
                {
                    label: '加载会话',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-load-session');
                    }
                }
            ]
        },
        {
            label: '工具',
            submenu: [
                {
                    label: '系统监控',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-system-monitor');
                    }
                },
                {
                    label: '端口扫描',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-port-scan');
                    }
                },
                { type: 'separator' },
                {
                    label: '开发者工具',
                    accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.toggleDevTools();
                    }
                }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '使用指南',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-help-guide');
                    }
                },
                {
                    label: 'AI命令帮助',
                    click: () => {
                        const win = getTargetWindow();
                        if (win) win.webContents.send('menu-ai-help');
                    }
                },
                { type: 'separator' },
                {
                    label: '关于AITerminal',
                    click: () => {
                        const win = getTargetWindow();
                        const options = {
                            type: 'info',
                            title: '关于AITerminal',
                            message: `AITerminal v${app.getVersion()}`,
                            detail: 'AI驱动的智能终端\n\n项目地址: https://github.com/Amo-Zeng/AITerminal\n作者: Amo-Zeng\n\n集成AI助手的SSH终端工具，让远程服务器管理更加智能高效。'
                        };
                        if (win) dialog.showMessageBox(win, options);
                        else dialog.showMessageBox(options);
                    }
                }
            ]
        }
    ];

    // macOS特殊处理
    if (process.platform === 'darwin') {
        template.unshift({
            label: 'AITerminal',
            submenu: [
                {
                    label: '关于AITerminal',
                    click: () => {
                        const win = getTargetWindow();
                        const options = {
                            type: 'info',
                            title: '关于AITerminal',
                            message: `AITerminal v${app.getVersion()}`,
                            detail: 'AI驱动的智能终端\n\n项目地址: https://github.com/Amo-Zeng/AITerminal\n作者: Amo-Zeng\n\n集成AI助手的SSH终端工具，让远程服务器管理更加智能高效。'
                        };
                        if (win) dialog.showMessageBox(win, options);
                        else dialog.showMessageBox(options);
                    }
                },
                { type: 'separator' },
          { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
          { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
          { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
          { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
          { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
          { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
                {
                    label: '隐藏AITerminal',
                    accelerator: 'Command+H',
                    role: 'hide'
                },
                {
                    label: '隐藏其他',
                    accelerator: 'Command+Alt+H',
                    role: 'hideothers'
                },
                {
                    label: '显示全部',
                    role: 'unhide'
                },
                { type: 'separator' },
                {
                    label: '退出',
                    accelerator: 'Command+Q',
                    click: () => {
                        app.quit();
                    }
                }
            ]
        });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// Function to track directory changes from terminal output
function trackDirectoryChanges(data, connectionInfo) {
    // 查找常见的提示符模式，这些通常包含当前目录
    const lines = data.split('\n');
    for (const line of lines) {
        // 清理ANSI转义序列
        const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');

        // 匹配多种常见的bash提示符模式，支持中文路径、特殊字符和~符号
        const patterns = [
            // user@host:/path$ 或 user@host:~$ - 支持中文和特殊字符，路径可能包含空格
            /.*?:([\/~][^\$#]*?)\s*[\$#]\s*$/,
            // [user@host path]$ 或 [user@host ~]$
            /\[.*?\s+([\/~][^\]]*?)\s*\][\$#]\s*$/,
            // user@host path $ 或 user@host ~ $
            /.*?\s+([\/~][^\s\$#]*)\s+[\$#]\s*$/,
            // /path $ 或 ~ $
            /^([\/~][^\s\$#]*)\s+[\$#]\s*$/,
            // PS1 with path in parentheses (path)$ 或 (~)$
            /\(([\/~][^\)]*?)\s*\)[\$#]\s*$/
        ];

        for (const pattern of patterns) {
            const match = cleanLine.match(pattern);
            if (match && match[1]) {
                let path = match[1].trim();

                // 接受以/开头的绝对路径或~符号
                if ((path.startsWith('/') && path.length > 1) || path === '~' || path.startsWith('~/')) {
                    connectionInfo.currentWorkingDirectory = path;
                    console.log(`Tracked directory change to: ${path}`);
                    break;
                }
            }
        }
    }
}

// Helper function to get current working directory
function getCurrentPath(conn, connectionInfo) {
    return new Promise((resolve, reject) => {
        // 直接使用track到的目录，这是最准确的
        if (connectionInfo.currentWorkingDirectory &&
            connectionInfo.currentWorkingDirectory !== '/' &&
            ((connectionInfo.currentWorkingDirectory.startsWith('/') && connectionInfo.currentWorkingDirectory.length > 1) ||
             connectionInfo.currentWorkingDirectory === '~' ||
             connectionInfo.currentWorkingDirectory.startsWith('~/'))) {
            console.log(`Using tracked directory: ${connectionInfo.currentWorkingDirectory}`);
            resolve(connectionInfo.currentWorkingDirectory);
            return;
        }

        // 如果没有track到有效目录，使用备用方法
        getCurrentPathFallback(conn).then(resolve).catch(() => {
            resolve('/'); // 最后的默认值
        });
    });
}

// Helper function to safely escape path for shell commands
function escapePath(remotePath) {
    // 如果路径以~开头，不要用引号包围，让shell展开~符号
    if (remotePath.startsWith('~')) {
        // 对~路径进行安全处理，只转义特殊字符但保留~的展开能力
        // 如果路径包含空格，需要特殊处理
        if (remotePath.includes(' ')) {
            // 对于包含空格的~路径，使用双引号但不转义~
            return `"${remotePath.replace(/([\\$`"!])/g, '\\$1')}"`;
        } else {
            // 对于不包含空格的~路径，直接返回不加引号
            return remotePath.replace(/([\\$`"!])/g, '\\$1');
        }
    } else {
        // 对绝对路径使用单引号包围，但要正确转义内部的单引号
        return `'${remotePath.replace(/'/g, "'\\''")}'`;
    }
}

// Helper function to expand ~ path for SFTP operations
function expandTildePath(remotePath, conn) {
    return new Promise((resolve, reject) => {
        if (!remotePath.startsWith('~')) {
            resolve(remotePath);
            return;
        }

        // 使用更简单的方法：先获取HOME目录，然后手动拼接路径
        conn.exec('echo $HOME', (err, stream) => {
            if (err) return reject(err);

            let output = '';
            let errorOutput = '';

            stream.on('data', (data) => {
                output += data.toString();
            });

            stream.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            stream.on('close', () => {
                if (errorOutput) {
                    return reject(new Error(`Failed to get HOME directory: ${errorOutput}`));
                }

                const homeDir = output.trim().split('\n')[0];
                if (homeDir && homeDir.startsWith('/')) {
                    // 手动替换~为HOME目录
                    let expandedPath;
                    if (remotePath === '~') {
                        expandedPath = homeDir;
                    } else if (remotePath.startsWith('~/')) {
                        expandedPath = homeDir + remotePath.substring(1);
                    } else {
                        expandedPath = remotePath; // 不应该到这里，但作为备用
                    }
                    console.log(`Expanded path: ${remotePath} -> ${expandedPath}`);
                    resolve(expandedPath);
                } else {
                    reject(new Error('Failed to get valid HOME directory'));
                }
            });
        });
    });
}

// Normalize shell commands: fix quoted tilde usages like cd "~" or cd '~'
function normalizeShellCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return cmd;
    let out = cmd;
    try {
        // cd "~" -> cd ~ ; cd "~/x" -> cd ~/x ; 同样处理单引号
        out = out.replace(/\bcd\s+(["'])~\/?([^"']*)\1/g, (m, q, rest) => {
            return 'cd ' + (rest ? `~/${rest}` : '~');
        });
        // 兼容多命令串中出现的同类写法
        out = out.replace(/(;|&&|\|\|)\s*cd\s+(["'])~\/?([^"']*)\2/g, (m, sep, q, rest) => {
            return `${sep} cd ${rest ? `~/${rest}` : '~'}`;
        });
    } catch {}
    return out;
}

// Strip ANSI escape codes and bracketed paste sequences from terminal output
function stripAnsi(text) {
    if (!text) return text;
    try {
        // Remove ESC[…command sequences
        let out = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
        // Remove OSC (Operating System Command) sequences: ESC ] … BEL or ESC \
        out = out.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '');
        // Remove stray control chars
        out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
        return out;
    } catch {
        return text;
    }
}

function clearReplContinueTimers(connectionInfo) {
    try {
        if (!connectionInfo) return;
        if (connectionInfo.replContinueTimer) {
            clearTimeout(connectionInfo.replContinueTimer);
            connectionInfo.replContinueTimer = null;
        }
        if (connectionInfo.replHardTimeoutTimer) {
            clearTimeout(connectionInfo.replHardTimeoutTimer);
            connectionInfo.replHardTimeoutTimer = null;
        }
    } catch {}
}

function appendReplBuffer(connectionInfo, chunk) {
    if (!connectionInfo || !chunk) return;
    const maxLen = 24000;
    const cur = connectionInfo.replBuffer || '';
    const next = cur + chunk;
    connectionInfo.replBuffer = next.length > maxLen ? next.slice(-maxLen) : next;
    connectionInfo.replLastOutputAt = Date.now();
}

function beginReplAutoContinue(connectionInfo, currentWindow, opts = {}) {
    if (!connectionInfo) return;
    clearReplContinueTimers(connectionInfo);
    connectionInfo.replPendingContinue = true;
    connectionInfo.replPendingHasOutput = false;
    connectionInfo.replPendingSince = Date.now();
    if (typeof opts.idleMs === 'number' && opts.idleMs > 0) connectionInfo.replIdleMs = opts.idleMs;
    if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) connectionInfo.replTimeoutMs = opts.timeoutMs;

    const timeoutMs = connectionInfo.replTimeoutMs || 15000;
    connectionInfo.replHardTimeoutTimer = setTimeout(() => {
        flushReplAndContinue(connectionInfo, currentWindow, 'timeout');
    }, timeoutMs);

    try {
        if (currentWindow) {
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'waiting',
                message: `⏳ 等待交互输出... (${connectionInfo.replTarget || 'remote'} / ${connectionInfo.replMode || 'interactive'})`
            });
        }
    } catch {}
}

function armReplIdleContinue(connectionInfo, currentWindow) {
    if (!connectionInfo || !connectionInfo.replPendingContinue) return;
    connectionInfo.replPendingHasOutput = true;
    const idleMs = connectionInfo.replIdleMs || 600;
    try {
        if (connectionInfo.replContinueTimer) clearTimeout(connectionInfo.replContinueTimer);
        connectionInfo.replContinueTimer = setTimeout(() => {
            flushReplAndContinue(connectionInfo, currentWindow, 'idle');
        }, idleMs);
    } catch {}
}

function flushReplAndContinue(connectionInfo, currentWindow, reason = 'idle') {
    if (!connectionInfo || !connectionInfo.replPendingContinue) return;

    clearReplContinueTimers(connectionInfo);
    connectionInfo.replPendingContinue = false;

    const target = connectionInfo.replTarget === 'local' ? 'local' : 'remote';
    const mode = connectionInfo.replMode || 'interactive';

    let outputRaw = connectionInfo.replBuffer || '';
    connectionInfo.replBuffer = '';
    outputRaw = outputRaw.replace(/\s+$/, '');

    const output = stripAnsi(outputRaw || '').trim();
    const MAX_LEN = 40000;
    const shown = output.length > MAX_LEN ? output.slice(0, MAX_LEN) + `\n…(输出已截断，共${output.length}字符)` : output;

    try {
        if (target === 'local') connectionInfo.lastLocalOutput = shown;
        else connectionInfo.lastTerminalOutput = shown;
    } catch {}

    // Inject interactive output into history so the model sees full context (not just last chunk).
    try {
        const msg = shown
            ? `交互会话输出 (${target} / ${mode}):\n${shown}`
            : `交互会话输出 (${target} / ${mode}): (无新输出, reason=${reason})`;
        if (Array.isArray(connectionInfo.aiTakeoverHistory)) {
            connectionInfo.aiTakeoverHistory.push({ role: 'user', content: msg });
            buildOrUpdateContextIndex(connectionInfo);
        }
    } catch {}

    // Continue takeover only if it's still running.
    if (connectionInfo.aiTakeoverMode) {
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 800);
    }
}

function clearReplWaiter(connectionInfo) {
    try {
        if (!connectionInfo) return;
        if (connectionInfo.replWaiterTimer) {
            clearTimeout(connectionInfo.replWaiterTimer);
            connectionInfo.replWaiterTimer = null;
        }
        connectionInfo.replWaiter = null;
    } catch {}
}

function checkReplWaiter(connectionInfo, currentWindow) {
    try {
        if (!connectionInfo?.replWaiter) return false;
        const needle = (connectionInfo.replWaiter.text || '').toString();
        if (!needle) return false;
        const hay = connectionInfo.replBuffer || '';
        if (hay.includes(needle)) {
            clearReplWaiter(connectionInfo);
            // Force a flush + continue so the model can act on what it waited for.
            if (!connectionInfo.replPendingContinue) connectionInfo.replPendingContinue = true;
            flushReplAndContinue(connectionInfo, currentWindow, 'wait_for');
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function startReplWaitForText(connectionInfo, currentWindow, text, timeoutMs = 8000) {
    if (!connectionInfo) return;
    clearReplContinueTimers(connectionInfo);
    clearReplWaiter(connectionInfo);
    const needle = (text || '').toString();
    const ms = Math.max(200, parseInt(timeoutMs, 10) || 8000);
    connectionInfo.replPendingContinue = true;
    connectionInfo.replWaiter = { text: needle, startedAt: Date.now(), timeoutMs: ms };
    connectionInfo.replWaiterTimer = setTimeout(() => {
        try {
            clearReplWaiter(connectionInfo);
            if (!connectionInfo.replPendingContinue) connectionInfo.replPendingContinue = true;
            flushReplAndContinue(connectionInfo, currentWindow, 'wait_for_timeout');
        } catch {}
    }, ms);
    try {
        if (currentWindow) {
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'waiting',
                message: `⏳ 等待交互输出包含: "${needle}" (timeout ${ms}ms)`
            });
        }
    } catch {}
    // Check immediately in case the buffer already contains it.
    checkReplWaiter(connectionInfo, currentWindow);
}

function getInteractiveKeySequence(keyName) {
    const k = (keyName || '').toString().trim().toUpperCase();
    if (!k) return null;
    switch (k) {
        case 'ENTER': return '\r';
        case 'TAB': return '\t';
        case 'ESC':
        case 'ESCAPE': return '\x1b';
        case 'UP': return '\x1b[A';
        case 'DOWN': return '\x1b[B';
        case 'RIGHT': return '\x1b[C';
        case 'LEFT': return '\x1b[D';
        case 'BACKSPACE': return '\x7f';
        case 'DELETE': return '\x1b[3~';
        case 'HOME': return '\x1b[H';
        case 'END': return '\x1b[F';
        case 'PAGEUP': return '\x1b[5~';
        case 'PAGEDOWN': return '\x1b[6~';
        default: return null;
    }
}

function getInteractiveCtrlSequence(keyName) {
    const k = (keyName || '').toString().trim().toUpperCase();
    if (k.length !== 1) return null;
    const code = k.charCodeAt(0);
    if (code < 65 || code > 90) return null;
    return String.fromCharCode(code - 64);
}

function getNodePty() {
    if (cachedNodePty !== undefined) return cachedNodePty;
    try {
        cachedNodePty = require('node-pty');
    } catch {
        cachedNodePty = null;
    }
    return cachedNodePty;
}

function inferReplModeFromCommandLine(commandLine) {
    const line = (commandLine || '').trim();
    if (!line) return 'cli:interactive';
    const first = line.split(/\s+/)[0].toLowerCase();
    if (first.startsWith('python')) return 'python';
    if (first === 'node') return 'node';
    if (first === 'mysql') return 'mysql';
    if (first === 'codex' || first === 'claude' || first === 'code') return `cli:${first}`;
    return `cli:${first}`;
}

function cleanupLocalInteractiveState(connectionInfo) {
    if (!connectionInfo) return;
    clearInterval(connectionInfo.localInteractive?.bindingGuard);
    connectionInfo.localInteractive = null;
}

function stopLocalInteractiveSession(connectionInfo) {
    if (!connectionInfo?.localInteractive) return;
    const li = connectionInfo.localInteractive;
    li.notificationObserver?.stop({ reason: 'cancelled' });
    // Detach first so any late exit/output won't schedule takeover steps.
    cleanupLocalInteractiveState(connectionInfo);
    if (connectionInfo.replTarget === 'local') {
        connectionInfo.replMode = null;
        connectionInfo.replTarget = null;
        connectionInfo.replBuffer = '';
        clearReplContinueTimers(connectionInfo);
        clearReplWaiter(connectionInfo);
    }
    try { li.pty?.kill?.(); } catch {}
    try { li.proc?.kill?.(); } catch {}
}

function startLocalInteractiveSession(connectionInfo, currentWindow, commandLine, modeHint = null) {
    if (tabExecutionContext.getStore() !== connectionInfo) {
        return tabExecutionContext.run(
            connectionInfo,
            () => startLocalInteractiveSession(connectionInfo, currentWindow, commandLine, modeHint)
        );
    }
    if (!ownsTabConnection(currentWindow, connectionInfo)) {
	    return { success: false, error: '标签会话已关闭' };
    }
    const binding = connectionInfo.localTakeoverBinding;
    if (!binding?.valid()) return { success: false, error: '本地终端已关闭或变化，请重新启动接管' };
    const cwd = connectionInfo.localWorkingDirectory || connectionInfo.localTakeoverInitialDir;

    // Stop previous local interactive session if any.
    stopLocalInteractiveSession(connectionInfo);

    const shellSpec = commandSpec(binding.environment, commandLine, cwd, { interactive: true });
    const pty = getNodePty();
    if (!pty) {
        const message = 'node-pty 未加载。本地交互式命令已拒绝启动，请在目标平台执行 npm ci 并重新打包。';
        try { currentWindow?.webContents.send('ai-takeover-update', { type: 'error', message }); } catch {}
        return { success: false, error: message };
    }
    const startedAt = Date.now();
    const sessionId = `${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const mode = modeHint || inferReplModeFromCommandLine(commandLine);
    const observer = observeProgram(connectionInfo, 'local', 'ai-interactive', commandLine);

    connectionInfo.replMode = mode;
    connectionInfo.replTarget = 'local';
    connectionInfo.replBuffer = '';

    let exited = false;
    const onOut = (chunk) => {
        if (!connectionInfo.localInteractive || connectionInfo.localInteractive.id !== sessionId) return;
        if (connectionInfo.localTakeoverBinding !== binding || !binding.valid()) { stopLocalInteractiveSession(connectionInfo); return; }
        const text = (chunk || '').toString();
        if (!text) return;
        observer.output(text);
        try { connectionInfo.lastLocalOutput = text; } catch {}
        try {
            if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'repl_output', message: text });
        } catch {}
        appendReplBuffer(connectionInfo, text);
        if (checkReplWaiter(connectionInfo, currentWindow)) return;
        if (!connectionInfo.replWaiter) armReplIdleContinue(connectionInfo, currentWindow);
    };

    const onExit = (exitCode, signal) => {
        observer.stop({ exitCode, signal });
        if (!connectionInfo.localInteractive || connectionInfo.localInteractive.id !== sessionId) return;
        if (exited) return;
        exited = true;
        try {
            const code = (typeof exitCode === 'number') ? exitCode : 0;
            const isErr = code !== 0;
            if (currentWindow) {
                currentWindow.webContents.send('ai-takeover-update', {
                    type: isErr ? 'error' : 'result',
                    message: `👋 本地交互会话已退出 (${mode})${signal ? ` signal=${signal}` : ''} exit=${code}`
                });
            }
        } catch {}

        // Flush any remaining output into history and continue.
        try {
            if (!connectionInfo.replPendingContinue) connectionInfo.replPendingContinue = true;
            flushReplAndContinue(connectionInfo, currentWindow, 'local_exit');
        } catch {}

        clearReplContinueTimers(connectionInfo);
        clearReplWaiter(connectionInfo);
        cleanupLocalInteractiveState(connectionInfo);
        if (connectionInfo.replTarget === 'local') {
            connectionInfo.replMode = null;
            connectionInfo.replTarget = null;
            connectionInfo.replBuffer = '';
        }
    };

    if (pty) {
        try {
            const termName = 'xterm-256color';
            const p = pty.spawn(shellSpec.file, shellSpec.args, {
                name: termName,
                cols: 120,
                rows: 40,
                cwd: shellSpec.cwd,
                env: shellSpec.env
            });
            connectionInfo.localInteractive = {
                notificationObserver: observer,
                id: sessionId,
                active: true,
                usingPty: true,
                pty: p,
                proc: null,
                cwd,
                binding,
                bindingGuard: setInterval(() => { if (connectionInfo.localTakeoverBinding !== binding || !binding.valid()) stopLocalInteractiveSession(connectionInfo); }, 200),
                shell: binding.environment.label,
                command: commandLine,
                startedAt
            };
            p.onData(onOut);
            p.onExit(({ exitCode, signal }) => onExit(exitCode, signal));
            return { success: true, usingPty: true, shell: binding.environment.label };
        } catch (e) {
            observer.stop({ error: e.message });
            try {
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', {
                    type: 'error',
                    message: `⚠️ node-pty 启动失败，交互式命令已拒绝启动: ${e.message}`
                });
            } catch {}
            cleanupLocalInteractiveState(connectionInfo);
            connectionInfo.replMode = null;
            connectionInfo.replTarget = null;
            return { success: false, error: e.message };
        }
    }
    return { success: false, error: '交互式PTY启动失败' };
}

function writeToLocalInteractive(connectionInfo, data) {
    const li = connectionInfo?.localInteractive;
    if (!li || !li.active) throw new Error('无活动的本地交互会话');
    if (!li.binding?.valid()) { stopLocalInteractiveSession(connectionInfo); throw new Error('本地交互目标已关闭或变化'); }
    if (li.pty) {
        li.pty.write(data);
        return;
    }
    if (li.proc && li.proc.stdin) {
        li.proc.stdin.write(data);
        return;
    }
    throw new Error('本地交互会话不可写');
}

function getLocalTerminalMap(connectionInfo) {
    if (!connectionInfo) return null;
    if (!connectionInfo.localTerminals || typeof connectionInfo.localTerminals.get !== 'function') {
        connectionInfo.localTerminals = new Map();
    }
    return connectionInfo.localTerminals;
}

function sanitizeLocalTerminalSize(cols, rows) {
    return sanitizeTerminalSize(cols, rows);
}

function resizeSshTerminalStream(connectionInfo, cols, rows) {
    const stream = connectionInfo?.sshStream;
    if (!stream || typeof stream.setWindow !== 'function') return false;

    const size = sanitizeTerminalSize(cols, rows);
    try {
        // ssh2 expects (rows, cols, pixelHeight, pixelWidth).
        stream.setWindow(size.rows, size.cols, 0, 0);
        return true;
    } catch (error) {
        console.warn('Failed to resize SSH terminal:', error.message);
        return false;
    }
}

function getLocalTerminalCwd(cwd) {
    const fallback = os.homedir() || process.cwd();
    if (!cwd || typeof cwd !== 'string') return fallback;
    try {
        const resolved = path.resolve(expandLocalTilde(cwd));
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    } catch {}
    return fallback;
}


function sendLocalTerminalEvent(currentWindow, channel, payload) {
    try {
        if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.webContents.send(channel, payload);
        }
    } catch {}
}

function stopLocalTerminalSession(connectionInfo, tabId) {
    const sessions = getLocalTerminalMap(connectionInfo);
    if (!sessions || !tabId) return false;
    const session = sessions.get(tabId);
    if (!session) return false;
    closeTerminalNotifications(session, { reason: 'cancelled' });

    sessions.delete(tabId);
    session.active = false;
    revokeLocalTakeover(connectionInfo, session);
    try { session.pty?.kill?.(); } catch {}
    try { session.proc?.kill?.(); } catch {}
    return true;
}

function revokeLocalTakeover(connectionInfo, session) {
    if (connectionInfo.localTakeoverBinding?.backend !== session) return;
    connectionInfo.localTakeoverBinding = null;
    connectionInfo.localTakeoverInitialDir = null;
    connectionInfo.localWorkingDirectory = null;
    connectionInfo.aiTakeoverMode = false;
    connectionInfo.aiTakeoverInterrupted = true;
    for (const controller of connectionInfo.localCommandControllers || []) controller.abort();
    cancelAiRequests(connectionInfo);
    stopLocalInteractiveSession(connectionInfo);
}

async function bindLocalTakeover(connectionInfo, currentWindow, requestedDirectory, hybrid = false) {
    // A hybrid task can reuse the environment of the local shell that this tab
    // had before SSH connected. A local-only task requires its visible backend.
    const session = getLocalTerminalMap(connectionInfo)?.get(connectionInfo.tabId) || (hybrid ? connectionInfo.localTerminalContext : null);
    if (!session?.environment || (!hybrid && (!session.active || connectionInfo.sshStream))) throw new Error('请先在当前标签打开本地终端，再启动本地接管');
    const ssh = connectionInfo.sshConnection, stream = connectionInfo.sshStream;
    const active = session.active;
    const valid = () => ownsTabConnection(currentWindow, connectionInfo) && connectionInfo.localTerminalContext === session &&
        connectionInfo.sshConnection === ssh && connectionInfo.sshStream === stream &&
        (active ? session.active && getLocalTerminalMap(connectionInfo)?.get(connectionInfo.tabId) === session : hybrid && !getLocalTerminalMap(connectionInfo)?.get(connectionInfo.tabId));
    const cwd = await terminalDirectory(session, requestedDirectory, valid);
    if (!valid()) throw new Error('读取本地目录期间标签终端已变化');
    return { target: 'local', shell: session.environment.shell, environment: session.environment, backend: session, cwd, valid };
}

function stopAllLocalTerminalSessions(connectionInfo) {
    const sessions = getLocalTerminalMap(connectionInfo);
    if (!sessions) return;
    for (const tabId of Array.from(sessions.keys())) {
        stopLocalTerminalSession(connectionInfo, tabId);
    }
}

function resizeLocalTerminalSession(connectionInfo, tabId, cols, rows) {
    const sessions = getLocalTerminalMap(connectionInfo);
    const session = sessions?.get(tabId);
    if (!session || !session.active) return false;

    const size = sanitizeLocalTerminalSize(cols, rows);
    session.cols = size.cols;
    session.rows = size.rows;
    if (session.pty && typeof session.pty.resize === 'function') {
        try {
            session.pty.resize(size.cols, size.rows);
            return true;
        } catch (e) {
            return false;
        }
    }
    return !!session.proc;
}

function startLocalTerminalSession(connectionInfo, currentWindow, options = {}) {
    const sessions = getLocalTerminalMap(connectionInfo);
    const tabId = (options.tabId || '').toString();
    if (!connectionInfo || !currentWindow || !sessions || !tabId) {
        return { success: false, message: '缺少窗口或标签页信息' };
    }

    const size = sanitizeLocalTerminalSize(options.cols, options.rows);
    const environment = createLocalEnvironment({ cwd: getLocalTerminalCwd(options.cwd) });
    const shellSpec = terminalLaunch(environment);
    const cwd = environment.cwd;
    const sessionId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const pty = getNodePty();

    // A tab owns exactly one local terminal backend. Restarting should not leave
    // a hidden process that can write into another tab or into an SSH session.
    stopLocalTerminalSession(connectionInfo, tabId);

    const makeSession = (partial) => {
        const session = {
            notificationObserver: observeProgram(connectionInfo, 'local', 'terminal', environment.label),
            id: sessionId,
            tabId,
            active: true,
            usingPty: !!partial.pty,
            shell: environment.label,
            environment,
            environmentTracker: shellSpec.tracker,
            cwd,
            cols: size.cols,
            rows: size.rows,
            startedAt: Date.now(),
            ...partial
        };
        sessions.set(tabId, session);
        connectionInfo.localTerminalContext = session;
        return session;
    };

    const onData = (chunk) => {
        const current = sessions.get(tabId);
        if (!current || current.id !== sessionId || !current.active) return;
        let text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : (chunk || '').toString();
        if (current.environmentTracker) {
            try { text = current.environmentTracker.feed(text); if (current.environmentTracker.pid && current.cwd === '~') current.cwd = environment.cwd; }
            catch (error) { stopLocalTerminalSession(connectionInfo, tabId); sendLocalTerminalEvent(currentWindow, 'terminal-local-exit', { tabId, code: 1, shell: environment.label }); return; }
        }
        if (!text) return;
        observeTerminalData(current, text);
        try { connectionInfo.lastLocalOutput = text; } catch {}
        sendLocalTerminalEvent(currentWindow, 'terminal-local-output', { tabId, data: text });
    };

    const onExit = (code, signal) => {
        const current = sessions.get(tabId);
        if (!current || current.id !== sessionId) return;
        closeTerminalNotifications(current, { exitCode: code, signal });
        sessions.delete(tabId);
        current.active = false;
        revokeLocalTakeover(connectionInfo, current);
        const normalizedCode = (typeof code === 'number') ? code : null;
        sendLocalTerminalEvent(currentWindow, 'terminal-local-exit', {
            tabId,
            code: normalizedCode,
            signal: signal || null,
            shell: environment.label
        });
    };

    if (!pty) {
        return { success: false, message: 'node-pty 未加载。本地终端已拒绝启动，请在目标平台执行 npm ci 并重新打包。' };
    }
    if (pty) {
        try {
            const termPty = pty.spawn(shellSpec.file, shellSpec.args, {
                name: 'xterm-256color',
                cols: size.cols,
                rows: size.rows,
                cwd: shellSpec.cwd,
                env: environment.env
            });
            makeSession({ pty: termPty, proc: null });
            termPty.onData(onData);
            termPty.onExit(({ exitCode, signal }) => onExit(exitCode, signal));
            console.log('Local PTY session ready');
            return { success: true, usingPty: true, shell: environment.label, cwd };
        } catch (e) {
            sendLocalTerminalEvent(currentWindow, 'terminal-local-output', {
                tabId,
                data: `\r\n\x1b[31m[本地PTY启动失败，终端未启动: ${e.message}]\x1b[0m\r\n`
            });
            return { success: false, message: e.message };
        }
    }
    return { success: false, message: '本地PTY启动失败' };
}

// Expand ~ and ~/... inside a shell command for exec-mode reliability
async function expandTildeInCommand(cmd, conn) {
    try {
        if (!cmd || typeof cmd !== 'string') return cmd;
        // Obtain remote $HOME
        const home = await expandTildePath('~', conn);
        if (!home || typeof home !== 'string') return cmd;
        let out = cmd;
        // Replace occurrences like  <boundary>~/path -> <boundary>/home/path
        const boundary = '(^|[\\s;|&\\(\\)\\{\\}\\[\\]<>,:])';
        const reTildePath = new RegExp(boundary + '~/(\\S+)', 'g');
        out = out.replace(reTildePath, (m, pre, rest) => `${pre}${home}/${rest}`);
        // Replace bare ~ at boundaries -> /home
        const reBareTilde = new RegExp(boundary + '~(?=\\s|$)', 'g');
        out = out.replace(reBareTilde, (m, pre) => `${pre}${home}`);
        return out;
    } catch {
        return cmd;
    }
}

// Fallback method using exec
function getCurrentPathFallback(conn) {
    return new Promise((resolve, reject) => {
        conn.exec('pwd', (err, stream) => {
            if (err) return reject(err);

            let output = '';
            stream.on('data', (data) => {
                output += data.toString();
            });

            stream.on('close', () => {
                const path = output.trim().split('\n')[0];
                if (path && path.startsWith('/') && path.length > 1) {
                    console.log(`Fallback method got path: ${path}`);
                    resolve(path);
                } else {
                    reject(new Error('Invalid path'));
                }
            });
        });
    });
}

// Local Terminal Management (xterm.js <-> local shell/PTY)
ipcMain.handle('terminal-local-start', async (event, options = {}) => {
    try {
        const connectionInfo = getWindowConnectionInfo(event, options.tabId);
        const currentWindow = getWindow(event);
        if (!connectionInfo || !currentWindow || !ownsTabConnection(currentWindow, connectionInfo)) {
            return { success: false, message: '缺少有效的窗口或标签页信息' };
        }
        return startLocalTerminalSession(connectionInfo, currentWindow, options || {});
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('terminal-local-send', async (event, payload = {}) => {
    try {
        const connectionInfo = getWindowConnectionInfo(event, payload.tabId);
        const currentWindow = getWindow(event);
        if (!connectionInfo || !currentWindow || !ownsTabConnection(currentWindow, connectionInfo)) {
            return { success: false, code: 'NO_TAB', message: '无有效的本地终端标签页' };
        }
        const sessions = getLocalTerminalMap(connectionInfo);
        const tabId = (payload.tabId || '').toString();
        const data = decodeTerminalInput(payload.data ?? '', payload.encoding);
        const session = sessions?.get(tabId);
        if (!session || !session.active) {
            return { success: false, code: 'NO_SESSION', message: 'No active local terminal session' };
        }
        if (session.pty) {
            session.pty.write(data);
            return { success: true };
        }
        if (session.proc?.stdin && !session.proc.stdin.destroyed) {
            session.proc.stdin.write(data);
            return { success: true };
        }
        return { success: false, code: 'NOT_WRITABLE', message: 'Local terminal is not writable' };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('terminal-local-resize', async (event, payload = {}) => {
    try {
        const connectionInfo = getWindowConnectionInfo(event, payload.tabId);
        const currentWindow = getWindow(event);
        if (!connectionInfo || !currentWindow || !ownsTabConnection(currentWindow, connectionInfo)) {
            return { success: false, message: '无有效的本地终端标签页' };
        }
        const ok = resizeLocalTerminalSession(connectionInfo, (payload.tabId || '').toString(), payload.cols, payload.rows);
        return { success: !!ok };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('terminal-local-stop', async (event, payload = {}) => {
    try {
        const connectionInfo = getWindowConnectionInfo(event, payload.tabId);
        const currentWindow = getWindow(event);
        if (!connectionInfo || !currentWindow || !ownsTabConnection(currentWindow, connectionInfo)) {
            return { success: false, message: '无有效的本地终端标签页' };
        }
        stopLocalTerminalSession(connectionInfo, (payload.tabId || '').toString());
        return { success: true };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

// SSH Connection Management
ipcMain.handle('ssh:resize', async (event, { cols, rows, tabId } = {}) => {
    const currentWindow = getWindow(event);
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!currentWindow || !connectionInfo || !ownsTabConnection(currentWindow, connectionInfo)) return false;
    return resizeSshTerminalStream(connectionInfo, cols, rows);
});
ipcMain.handle('ssh-connect', (event, config) => {
    return new Promise((resolve, reject) => {
        config = sanitizeIpcConfig(config);
        const connectionInfo = getWindowConnectionInfo(event, config?.tabId);
        const currentWindow = getWindow(event);
        if (!connectionInfo || !currentWindow || !ownsTabConnection(currentWindow, connectionInfo)) {
            return reject({ success: false, message: 'Window or tab connection info not found' });
        }
        const stored = loadStoredSecrets(config);
        if (!config.password && stored.ssh?.password) config.password = stored.ssh.password;
        if (!config.passphrase && stored.ssh?.passphrase) config.passphrase = stored.ssh.passphrase;
        if (!config.aiApiKey && stored.ai?.apiKey) config.aiApiKey = stored.ai.apiKey;
        if (!config.host || !config.username) {
            return reject({ success: false, message: '请填写 SSH 主机地址和用户名' });
        }
        let privateKey = null;
        if (config.authMethod === 'privateKey') {
            if (!config.privateKeyPath) {
                return reject({ success: false, message: '请选择 SSH 私钥文件' });
            }
            try {
                // Validate the credential before replacing an already working connection.
                privateKey = fs.readFileSync(config.privateKeyPath);
            } catch (error) {
                return reject({ success: false, message: `读取私钥文件失败: ${error.message}` });
            }
        }
        if (config.rememberPassword) {
            const persisted = saveProvidedSecrets(config, { saveAi: false });
            if (!persisted.success) {
                return reject({ success: false, message: `保存凭据失败: ${persisted.error}` });
            }
        } else {
            deleteSecret(secretKey('ssh', credentialScope(config)));
        }
        if (typeof config.aiApiKey === 'string' && config.aiApiKey.trim()) {
            const persisted = saveProvidedSecrets(config, { saveSsh: false });
            if (!persisted.success) {
                return reject({ success: false, message: `保存AI凭据失败: ${persisted.error}` });
            }
        }
        const tabAiConfig = getAiConfig(connectionInfo);
        if (config.aiBaseUrl && apiSecretScope(config.aiBaseUrl) !== apiSecretScope(tabAiConfig.baseUrl)) tabAiConfig.apiKey = null;
        // 保存AI配置
        if (config.enableAI) {
            tabAiConfig.apiFormat = normalizeApiFormat(config.aiApiFormat);
            if (config.aiApiKey && typeof config.aiApiKey === 'string') {
                tabAiConfig.apiKey = config.aiApiKey.trim();
            }
            if (config.aiBaseUrl && typeof config.aiBaseUrl === 'string') {
                tabAiConfig.baseUrl = config.aiBaseUrl.trim();
            }
            if (config.aiModel && typeof config.aiModel === 'string') {
                tabAiConfig.model = config.aiModel.trim();
            }
            if (config.aiMaxTokens) {
                const maxTokens = parseInt(config.aiMaxTokens);
                if (!isNaN(maxTokens) && maxTokens > 0) {
                    tabAiConfig.maxTokens = maxTokens;
                }
            }
            if (config.aiTemperature !== undefined) {
                const temperature = parseFloat(config.aiTemperature);
                if (!isNaN(temperature) && temperature >= 0 && temperature <= 2) {
                    tabAiConfig.temperature = temperature;
                }
            }
            if (config.aiCustomRequirements && typeof config.aiCustomRequirements === 'string') {
                tabAiConfig.customRequirements = config.aiCustomRequirements.trim();
            }
            if (config.showFullConversation !== undefined) {
                tabAiConfig.showFullConversation = config.showFullConversation === true;
            }

            // 验证配置
            validateAiConfig(tabAiConfig);
        } else {
            // 如果禁用AI，清空配置
            tabAiConfig.apiKey = null;
        }

        disposeSshBackend(connectionInfo, 'SSH connection superseded by reconnect');
        const conn = new Client();
        let settled = false;
        let connectionReady = false;
        let waitingForHostVerification = false;
        let attemptTimeout = null;
        const clearAttemptTimeout = () => {
            if (!attemptTimeout) return;
            clearTimeout(attemptTimeout);
            attemptTimeout = null;
        };
        const settleResolve = (value) => {
            if (settled) return false;
            settled = true;
            resolve(value);
            return true;
        };
        const settleReject = (value) => {
            if (settled) return false;
            settled = true;
            reject(value);
            return true;
        };
        const attempt = beginBackendLease(connectionInfo, 'sshConnectAttempt', conn, (reason) => {
            clearAttemptTimeout();
            const message = reason instanceof Error ? reason.message : String(reason || 'SSH connection cancelled');
            try { conn.end(); } catch {}
            settleReject({ success: false, code: 'SSH_CONNECT_CANCELLED', message });
        });
        const isCurrentAttempt = () => (
            ownsTabConnection(currentWindow, connectionInfo) &&
            ownsBackendLease(connectionInfo, 'sshConnectAttempt', attempt)
        );
        const hostRecords = getKnownHosts();
        let acceptedHostVerification = null;
        const hostVerifier = (key, callback) => {
            if (!isCurrentAttempt()) {
                callback(false);
                return;
            }
            const inspection = inspectHostKey(hostRecords, config.host, config.port, key);
            if (inspection.status === 'trusted') {
                acceptedHostVerification = { ...inspection, accepted: true };
                callback(true);
                return;
            }
            waitingForHostVerification = true;
            const changed = inspection.status === 'changed';
            const options = {
                type: changed ? 'warning' : 'question',
                title: changed ? 'SSH 主机密钥已变化' : '首次连接 SSH 主机',
                message: changed
                    ? `检测到 ${inspection.host} 的主机密钥与已保存指纹不一致。继续可能遭遇中间人攻击。`
                    : `尚未信任 ${inspection.host}。请通过其他可信渠道核对服务器指纹后再继续。`,
                detail: `算法: ${inspection.keyType}\n当前指纹: ${inspection.fingerprint}${changed ? `\n已保存指纹: ${inspection.previousFingerprint}` : ''}`,
                buttons: changed ? ['拒绝并断开', '确认更新并信任'] : ['拒绝并断开', '确认并保存'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            };
            const prompt = currentWindow ? dialog.showMessageBox(currentWindow, options) : dialog.showMessageBox(options);
            Promise.resolve(prompt).then(({ response }) => {
                waitingForHostVerification = false;
                if (response !== 1 || !isCurrentAttempt()) {
                    callback(false);
                    return;
                }
                rememberHostKey(hostRecords, config.host, config.port, key);
                try {
                    saveKnownHosts();
                    acceptedHostVerification = { ...inspection, accepted: true };
                    callback(true);
                } catch (error) {
                    console.warn('保存 SSH 主机指纹失败:', error.message);
                    callback(false);
                }
            }).catch(() => {
                waitingForHostVerification = false;
                callback(false);
            });
        };

        conn.on('ready', () => {
            if (!isCurrentAttempt()) {
                attempt.cancel('SSH connection no longer belongs to this tab');
                return;
            }
            connectionReady = true;
            armShellTimeout();
            conn.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
                if (err) {
                    attempt.cancel(`SSH Shell error: ${err.message}`);
                    return;
                }
                if (!isCurrentAttempt()) {
                    try { stream?.end?.(); } catch {}
                    attempt.cancel('SSH shell no longer belongs to this tab');
                    return;
                }
                clearAttemptTimeout();
                if (!releaseBackendLease(connectionInfo, 'sshConnectAttempt', attempt)) {
                    try { stream?.end?.(); } catch {}
                    attempt.cancel('SSH connection promotion failed');
                    return;
                }
                connectionInfo.sshConnection = conn;
                connectionInfo.sshStream = stream;
                stream.notificationObserver = observeProgram(connectionInfo, 'remote', 'terminal');
                connectionInfo.sshServerIdentity = serverIdentity(config);
                connectionInfo.sshHostFingerprint = acceptedHostVerification?.fingerprint || '';
                connectionInfo.sshExecutionTrust = createVerifiedServerTrust(config, acceptedHostVerification || {});
                stream.setEncoding('utf8');

                // 监听数据流，同时跟踪目录变化
                stream.on('data', (data) => {
                    if (!ownsTabConnection(currentWindow, connectionInfo) ||
                        connectionInfo.sshConnection !== conn || connectionInfo.sshStream !== stream) return;
                    const text = data.toString();
                    observeTerminalData(stream, text);
                    const captureActive = !!(connectionInfo.directCapture && !connectionInfo.directCapture.done);
                    sendTabEvent(currentWindow, connectionInfo, 'ssh-output', text);
                    // 在REPL模式或直传捕获时，同步输出到AI面板
                    try {
                        if (connectionInfo.replMode && connectionInfo.replTarget !== 'local') {
                            if (!connectionInfo.replTarget) connectionInfo.replTarget = 'remote';
                            appendReplBuffer(connectionInfo, text);
                            sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'repl_output', message: text });
                            const waiterDone = checkReplWaiter(connectionInfo, currentWindow);
                            if (!waiterDone && !connectionInfo.replWaiter) armReplIdleContinue(connectionInfo, currentWindow);
                        }
                        // 直传捕获：提取标记内输出
                        if (connectionInfo.directCapture && !connectionInfo.directCapture.done) {
                            const cap = connectionInfo.directCapture;
                            cap.buffer = (cap.buffer || '') + text;
                            if (!cap.gotBegin) {
                                const bi = cap.buffer.indexOf(cap.beginToken);
                                if (bi !== -1) {
                                    cap.gotBegin = true;
                                    cap.buffer = cap.buffer.slice(bi + cap.beginToken.length);
                                } else {
                                    // 还没到起始标记，丢弃缓冲避免膨胀
                                    if (cap.buffer.length > 4096) cap.buffer = cap.buffer.slice(-1024);
                                }
                            }
                            if (cap.gotBegin) {
                                const ei = cap.buffer.indexOf(cap.endToken);
                                if (ei !== -1) {
                                    const body = cap.buffer.slice(0, ei);
                                    const tail = cap.buffer.slice(ei + cap.endToken.length);
                                    const m = tail.match(/^:(-?\d+)/);
                                    cap.exitCode = m ? parseInt(m[1], 10) : undefined;
                                    // 清理ANSI码，避免显示“乱码”
                                    const collected = (cap.collected || '') + stripAnsi(body);
                                    cap.collected = collected;
                                    cap.done = true;
                                    connectionInfo.directCapture = null;
                                    // 向面板汇报结果
                                    let finalText = (collected || '').trim();
                                    const MAX_LEN = 40000;
                                    if (finalText.length > MAX_LEN) finalText = finalText.slice(0, MAX_LEN) + `\n…(输出已截断，共${(collected || '').length}字符)`;
                                    const dur = connectionInfo.currentExecStart ? `\n⏱️ 执行用时: ${Math.round((Date.now()-connectionInfo.currentExecStart)/1000)}s` : '';
                                    const exitPart = cap.exitCode !== undefined ? `\n退出码: ${cap.exitCode}` : '';
                                    const isError = typeof cap.exitCode === 'number' && cap.exitCode !== 0;
                                    sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', {
                                        type: isError ? 'error' : 'result',
                                        message: `${isError ? '❌' : '📤'} 执行结果:\n${finalText || '命令执行完成（无输出）'}${exitPart}${dur}`
                                    });
                                    // 记录历史并推进（供模型读取）
                                    try {
                                        connectionInfo.lastTerminalOutput = finalText;
                                        connectionInfo.aiTakeoverHistory.push({ role: 'user', content: '你的命令执行结果: ' + (finalText || '无输出') });
                                        buildOrUpdateContextIndex(connectionInfo);
                                    } catch {}
                                    setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
                                } else {
                                    // 暂存正文
                                    cap.collected = (cap.collected || '') + cap.buffer;
                                    cap.buffer = '';
                                }
                            }
                        }
                    } catch {}
                    // 尝试从输出中提取当前目录信息
                    trackDirectoryChanges(text, connectionInfo);
                    // 保存最近的终端输出用于AI分析
                    if (!captureActive) {
                        connectionInfo.lastTerminalOutput = text;
                    }
                });

                stream.on('close', (code, signal) => {
                    handleActiveSshClosed(connectionInfo, currentWindow, conn, '', typeof code === 'number' ? code : null, signal);
                });

                stream.on('error', (error) => {
                    handleActiveSshClosed(connectionInfo, currentWindow, conn, error?.message || 'SSH shell error');
                });

                // 连接成功后，尝试获取初始目录
                setTimeout(() => {
                    getCurrentPathFallback(conn).then(path => {
                        if (!ownsTabConnection(currentWindow, connectionInfo) || connectionInfo.sshConnection !== conn) return;
                        connectionInfo.currentWorkingDirectory = path;
                        console.log(`Initial directory set to: ${path}`);
                    }).catch(() => {
                        console.log('Failed to get initial directory, using /');
                    });
                }, 1000);
                settleResolve({ success: true, message: `✓ SSH连接成功: ${config.username}@${config.host}` });
            });
        }).on('error', (err) => {
            if (ownsBackendLease(connectionInfo, 'sshConnectAttempt', attempt)) {
                attempt.cancel(`SSH Connection error: ${err.message}`);
            } else {
                handleActiveSshClosed(connectionInfo, currentWindow, conn, err.message || 'SSH connection error');
            }
        }).on('close', () => {
            if (ownsBackendLease(connectionInfo, 'sshConnectAttempt', attempt)) {
                attempt.cancel(connectionReady ? 'SSH shell closed before it became ready' : 'Connection failed and closed.');
            } else {
                handleActiveSshClosed(connectionInfo, currentWindow, conn, '');
            }
        });

        const armConnectionTimeout = () => {
            clearAttemptTimeout();
            attemptTimeout = setTimeout(() => {
                if (!isCurrentAttempt()) return;
                if (waitingForHostVerification) {
                    armConnectionTimeout();
                    return;
                }
                attempt.cancel('SSH connection timed out.');
            }, 20000);
        };
        const armShellTimeout = () => {
            clearAttemptTimeout();
            attemptTimeout = setTimeout(() => {
                if (isCurrentAttempt()) attempt.cancel('SSH shell startup timed out.');
            }, 15000);
        };
        armConnectionTimeout();


        // 连接配置
        const connectionConfig = {
            host: config.host,
            port: parseInt(config.port) || 22,
            username: config.username,
            hostVerifier
        };

        // 根据认证方式设置认证信息
        if (config.authMethod === 'privateKey') {
            connectionConfig.privateKey = privateKey;
            if (config.passphrase) connectionConfig.passphrase = config.passphrase;
        } else {
            // 使用密码认证
            connectionConfig.password = config.password;
        }

        try {
            conn.connect(connectionConfig);
        } catch (error) {
            attempt.cancel(`SSH Connection error: ${error.message}`);
        }
    });
});

// Send raw data from xterm.js to SSH stream
ipcMain.handle('ssh-send-raw', (event, payload = {}) => {
    const command = typeof payload === 'string' ? payload : String(payload.command || '');
    const connectionInfo = getWindowConnectionInfo(event, payload?.tabId);
    const currentWindow = getWindow(event);
    if (connectionInfo && currentWindow && ownsTabConnection(currentWindow, connectionInfo) && connectionInfo.sshStream) {
        const resizeMatch = /^\x1b\[8;(\d+);(\d+)t$/.exec(command);
        if (resizeMatch) {
            return { success: resizeSshTerminalStream(connectionInfo, resizeMatch[2], resizeMatch[1]) };
        }
        try {
            connectionInfo.sshStream.write(decodeTerminalInput(command, payload.encoding));
            return { success: true };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
    return { success: false, message: 'No active SSH stream' };
});

// 设置AI接管执行模式: 'direct' 或 'exec'
ipcMain.handle('ai-set-execute-mode', async (event, mode, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo) return { success: false, error: 'no-conn' };
    const m = (mode === 'exec') ? 'exec' : 'direct';
    connectionInfo.executeMode = m;
    return { success: true, mode: m };
});

async function confirmAuditedCommand(currentWindow, connectionInfo, command, audit, options = {}) {
    if (!audit.requiresConfirmation) return true;
    if (options.target === 'remote' && isTrustedRemoteSession(connectionInfo, options.backend)) return true;
    queueWebhookEvent(connectionInfo, 'security_confirmation', {
        status: 'awaiting_confirmation',
        risk: audit.risk,
        reasons: audit.matchedPatterns,
        command: audit.commandPreview
    });
    const dialogOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        type: 'warning',
        title: '高危命令确认',
        message: `安全审计检测到${audit.risk === 'critical' ? '严重' : '高'}风险命令`,
        detail: `${audit.commandPreview}\n\n风险原因: ${audit.matchedPatterns.join('、')}\n\n确认后将以当前终端会话权限执行。`,
        buttons: ['取消', '确认执行'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
    };
    const choice = currentWindow
        ? await dialog.showMessageBox(currentWindow, dialogOptions)
        : await dialog.showMessageBox(dialogOptions);
    return choice.response === 1;
}

async function executeAuditedTerminal(event, payload = {}, pluginAction = null) {
    let programMonitor = null;
    try {
        const tabId = normalizeTabId(payload.tabId);
        if (!tabId) return { success: false, error: 'invalid-tab' };
        const connectionInfo = getWindowConnectionInfo(event, tabId);
        const currentWindow = getWindow(event);
        let rawCommand = typeof payload.command === 'string' ? payload.command : '';
        if (rawCommand.length > 200000) return { success: false, error: '命令过长' };
        if (payload.notifyOnExit === true && rawCommand.length > 16000) return { success: false, error: '监控命令不超过 16000 字符，请使用脚本文件' };
        let command = rawCommand.trim();
        pluginAction ||= parsePluginCall(command);
        if (!connectionInfo || !ownsTabConnection(currentWindow, connectionInfo)) {
            return { success: false, error: 'invalid-tab' };
        }
        const toolCall = parsePluginToolCall(command);
        if (toolCall) {
            const result = await getPluginRuntime().invoke(connectionInfo, toolCall.pluginId, 'tool', toolCall.toolId, toolCall.params);
            return { success: true, result };
        }
        if (!command && !pluginAction) return { success: false, error: '命令不能为空' };
	    if (/[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
	        return { success: false, error: '命令包含不允许的终端控制字符' };
	    }

        const localSession = getLocalTerminalMap(connectionInfo)?.get(tabId);
        const sshStream = connectionInfo.sshStream;
        const target = sshStream
            ? 'remote'
            : (localSession?.active ? 'local' : null);
        if (!target) return { success: false, error: '当前标签没有可写终端会话' };

        let pluginLease = null;
        if (pluginAction) {
            // The visible Windows terminal runs WSL Ubuntu, while takeover uses host PowerShell.
            pluginLease = getPluginManager().resolveAction(connectionInfo.pluginIds, pluginAction.pluginId, pluginAction.actionId, { target, shell: 'posix' });
            command = pluginLease.command;
        }

        const audit = auditCommand(command);
        if (!await confirmAuditedCommand(currentWindow, connectionInfo, command, audit, {
            target,
            backend: target === 'remote' ? sshStream : localSession
        })) {
            return { success: false, cancelled: true, error: '用户取消高危命令' };
        }
        if (!ownsTabConnection(currentWindow, connectionInfo)) {
            return { success: false, cancelled: true, error: '标签已关闭' };
        }
        if (pluginLease && !getPluginManager().isCurrent(connectionInfo.pluginIds, pluginAction.pluginId, pluginLease.digest, pluginLease.activation)) {
            return { success: false, cancelled: true, error: '插件已停用或更新，请重新执行' };
        }

        const dispatch = backend => {
            if (payload.notifyOnExit === true) {
                const config = getWindowStateForConnectionInfo(connectionInfo)?.webhookConfig;
                if (!config?.enabled || !config.events.includes('program_stopped')) throw new Error('请先在 Webhook 设置中启用“程序停止”通知');
                if (connectionInfo.replMode || (backend.programMonitor && !backend.programMonitor.done)) throw new Error('当前标签已有交互程序或监控任务，请等待结束后再运行');
                const observer = observeProgram(connectionInfo, target, 'monitored-command', command);
                programMonitor = new ProgramMarkers(observer.id, observer);
                backend.programMonitor = programMonitor;
                command = monitoredCommand(command, observer.id);
            }
            if (backend.pty) backend.pty.write(command + '\r');
            else if (backend.proc?.stdin && !backend.proc.stdin.destroyed) backend.proc.stdin.write(command + '\r');
            else if (typeof backend.write === 'function') backend.write(command + '\r');
            else throw new Error('当前标签终端不可写');
        };

        if (target === 'remote') {
            if (!sshStream || connectionInfo.sshStream !== sshStream) {
                return { success: false, cancelled: true, error: 'SSH 会话已变化，请重新执行' };
            }
            dispatch(sshStream);
        } else if (getLocalTerminalMap(connectionInfo)?.get(tabId) !== localSession || !localSession.active) {
            return { success: false, cancelled: true, error: '本地终端会话已变化，请重新执行' };
        } else {
            dispatch(localSession);
        }
        return { success: true, target };
    } catch (error) {
        programMonitor?.close('cancelled');
        return { success: false, error: error.message };
    }
}
ipcMain.handle('terminal-execute-audited', (event, payload) => executeAuditedTerminal(event, payload));
registerPluginIpc({
    ipcMain, dialog, getManager: getPluginManager, getTab: getWindowConnectionInfo, getWindow,
    getRuntime: getPluginRuntime,
    ownsTab: ownsTabConnection,
    allTabs: () => [...windowConnections.values()].flatMap(state => [...state.tabs.values()]),
    notify: () => { for (const win of windows.values()) if (!win.isDestroyed()) win.webContents.send('plugins-changed'); },
    execute: (event, payload) => executeAuditedTerminal(event, { tabId: payload.tabId }, payload)
});

// Direct interaction: allow the model/renderer to send a command to the active SSH session
ipcMain.handle('ai-direct-send', async (event, payload) => {
    let connectionInfo = null;
    try {
        connectionInfo = getWindowConnectionInfo(event, payload?.tabId);
        const currentWindow = getWindow(event);
        if (!connectionInfo || !connectionInfo.sshStream) {
            return { success: false, error: 'No active SSH connection' };
        }
        const sshStream = connectionInfo.sshStream;
        const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
	    if (typeof input.command !== 'string' || input.command.length > 200000) {
	        return { success: false, error: 'Invalid command' };
	    }
        let command = input.command;
        command = normalizeShellCommand(command);
        try {
            if (command.includes('~')) {
                command = await expandTildeInCommand(command, connectionInfo.sshConnection);
            }
        } catch {}
        const raw = (typeof input === 'object' && input.raw === true);
        let appendNewline = (typeof input === 'object' && 'appendNewline' in input) ? !!input.appendNewline : !raw;
	    if (!command || typeof command !== 'string') {
	        return { success: false, error: 'Empty command' };
	    }
	    if (/[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
	        return { success: false, error: 'Command contains unsupported terminal control characters' };
	    }
	    const audit = auditCommand(command, { requiresConfirmation: input.requiresConfirmation === true });
            if (!await confirmAuditedCommand(currentWindow, connectionInfo, command, audit, {
                target: 'remote',
                backend: sshStream
            })) {
	        return { success: false, cancelled: true, error: '用户取消高危命令' };
	    }
	    if (!ownsTabConnection(currentWindow, connectionInfo) || connectionInfo.sshStream !== sshStream) {
	        return { success: false, cancelled: true, error: 'SSH 会话已变化，请重新执行' };
	    }
        // Record to simplified flow as an executing step
        try {
            const first = String(command).split('\n')[0];
            if (currentWindow) {
                sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', {
                    type: 'executing',
                    message: `➡️ 直接交互: ${first}`
                });
            }
        } catch {}
        // Send to SSH stream
        sshStream.write(appendNewline ? command + '\n' : command);
        return { success: true };
    } catch (e) {
        try {
            const currentWindow = getWindow(event);
            if (currentWindow) sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'error', message: `❌ 直接交互失败: ${e.message}` });
        } catch {}
        return { success: false, error: e.message };
    }
});

ipcMain.handle('secure-migrate-configs', async (_event, payload = {}) => {
    const store = getSecureStore();
    const storageAvailable = !!store?.isAvailable();
    const configs = Array.isArray(payload.configs) ? payload.configs.slice(0, 100) : [];
    for (const input of configs) {
        if (!input || typeof input !== 'object') continue;
        const config = { ...input };
        const persisted = saveProvidedSecrets(config, { saveSsh: config.rememberPassword === true });
        if (!persisted.success) return persisted;
        const webhookUrl = config.webhookConfig?.url || config.webhookUrl;
        if (typeof webhookUrl === 'string' && webhookUrl.trim()) {
            const validation = validateWebhookUrl(webhookUrl);
            if (!validation.valid) return { success: false, error: validation.error };
            const result = saveSecret(secretKey('webhook', 'default'), { url: webhookUrl.trim() });
            if (!result.success) return result;
        }
    }
    return { success: true, persisted: storageAvailable };
});

ipcMain.handle('secure-secret-status', async (_event, config = {}) => {
    const store = getSecureStore();
    const stored = loadStoredSecrets(config);
    const webhook = loadSecret(secretKey('webhook', 'default'));
    return {
        available: !!store?.isAvailable(),
        ssh: !!(stored.ssh?.password || stored.ssh?.passphrase),
        ai: !!stored.ai?.apiKey,
        webhook: !!(webhook.success && webhook.value?.url)
    };
});

// Disconnect SSH
ipcMain.handle('ssh-disconnect', (event, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    const currentWindow = getWindow(event);
    const disconnected = disposeSshBackend(connectionInfo, 'SSH connection disconnected by user');
    if (disconnected && currentWindow && connectionInfo) {
        sendTabEvent(currentWindow, connectionInfo, 'ssh-disconnected', 'user-disconnect');
    }
    return { success: true };
});

// Get current path from terminal
ipcMain.handle('ssh-get-current-path', async (event, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo || !connectionInfo.sshConnection) {
        return { success: false, error: 'No SSH connection' };
    }

    try {
        const currentPath = await getCurrentPath(connectionInfo.sshConnection, connectionInfo);
        return { success: true, path: currentPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 独立的AI测试功能
ipcMain.handle('ai-configure', async (event, config = {}, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo) return { success: false, error: 'no-tab' };
    if (config.enableAI !== false && typeof config.aiApiKey === 'string' && config.aiApiKey.trim()) {
        const persisted = saveProvidedSecrets(config, { saveSsh: false });
        if (!persisted.success) return persisted;
    }
    applyAiConfig(connectionInfo, config, true);
    return { success: true };
});

ipcMain.handle('webhook-configure', async (event, payload = {}) => {
    const state = getWindowState(event);
    if (!state) return { success: false, error: 'no-window' };
    const requested = payload.config || payload;
    const ruleError = validateOutputRules(requested);
    if (ruleError) return { success: false, error: ruleError };
    const config = normalizeWebhookConfig(requested);
    if (requested.clearStoredUrl === true) {
        deleteSecret(secretKey('webhook', 'default'));
    } else if (!config.url) {
        const stored = loadSecret(secretKey('webhook', 'default'));
        if (stored?.success && stored.value?.url) config.url = stored.value.url;
    }
    if (config.enabled && !config.url) {
        return { success: false, error: '启用 Webhook 前请填写 HTTPS URL' };
    }
    if (config.url) {
        const validation = validateWebhookUrl(config.url);
        if (!validation.valid) return { success: false, error: validation.error };
    }
    if (config.url) {
        const stored = saveSecret(secretKey('webhook', 'default'), { url: config.url });
        if (!stored.success) return { success: false, error: `保存Webhook凭据失败: ${stored.error}` };
    }
    state.webhookConfig = config;
    state.webhookDedup.clear();
    return { success: true, config: publicWebhookConfig(config) };
});

ipcMain.handle('webhook-get-config', async (event) => {
    const state = getWindowState(event);
    if (!state) return { success: false, error: 'no-window' };
    const config = normalizeWebhookConfig(state.webhookConfig);
    if (!config.url) {
        const stored = loadSecret(secretKey('webhook', 'default'));
        if (stored?.success && stored.value?.url) config.url = stored.value.url;
    }
    state.webhookConfig = config;
    return { success: true, config: publicWebhookConfig(config) };
});

ipcMain.handle('webhook-test', async (event, payload = {}) => {
    const state = getWindowState(event);
    if (!state) return { success: false, error: 'no-window' };
    const config = normalizeWebhookConfig(payload.config || state.webhookConfig);
    if (!config.url) {
        const stored = loadSecret(secretKey('webhook', 'default'));
        if (stored?.success && stored.value?.url) config.url = stored.value.url;
    }
    const validation = validateWebhookUrl(config.url);
    if (!validation.valid) return { success: false, error: validation.error };
    try {
        const result = await sendWebhook(config, 'test', {
            tabId: normalizeTabId(payload.tabId) || state.activeTabId,
            status: 'test',
            message: 'AITerminal Webhook test'
        });
        return { success: true, statusCode: result.statusCode };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('ai-test-connection', async (event, config, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    try {
        config = config && typeof config === 'object' ? config : {};
        const testConfig = { ...getAiConfig(connectionInfo) };
        if (config.aiBaseUrl && apiSecretScope(config.aiBaseUrl) !== apiSecretScope(testConfig.baseUrl)) testConfig.apiKey = null;
        testConfig.apiFormat = normalizeApiFormat(config.aiApiFormat);
        if (config.aiApiKey && typeof config.aiApiKey === 'string') {
            testConfig.apiKey = config.aiApiKey.trim();
        }
        if (config.aiBaseUrl && typeof config.aiBaseUrl === 'string') {
            testConfig.baseUrl = config.aiBaseUrl.trim();
        }
        if (config.aiModel && typeof config.aiModel === 'string') {
            testConfig.model = config.aiModel.trim();
        }
        if (config.aiMaxTokens) {
            const maxTokens = parseInt(config.aiMaxTokens);
            if (!isNaN(maxTokens) && maxTokens > 0) {
                testConfig.maxTokens = maxTokens;
            }
        }
        if (config.aiTemperature !== undefined) {
            const temperature = parseFloat(config.aiTemperature);
            if (!isNaN(temperature) && temperature >= 0 && temperature <= 2) {
                testConfig.temperature = temperature;
            }
        }
        if (config.aiCustomRequirements && typeof config.aiCustomRequirements === 'string') {
            testConfig.customRequirements = config.aiCustomRequirements.trim();
        }
        if (config.showFullConversation !== undefined) {
            testConfig.showFullConversation = config.showFullConversation === true;
        }

        if (!testConfig.apiKey) {
            const stored = loadStoredSecrets({ ...config, aiBaseUrl: testConfig.baseUrl });
            testConfig.apiKey = stored.ai?.apiKey || null;
        }
        validateAiConfig(testConfig);
        if (!testConfig.baseUrl) throw new Error('API基础URL必须使用HTTPS；仅本机地址允许HTTP');
        return await handleAiTestCommand(connectionInfo, testConfig);
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
});

// 流式AI命令处理
ipcMain.handle('ssh-execute-special-streaming', async (event, command, args, tabId) => {
    try {
        // AI命令不需要SSH连接
        const aiCommands = ['ai', 'ask', 'fix', 'analyze', 'cmd'];
        const connectionInfo = getWindowConnectionInfo(event, tabId);

        switch (command) {
            case 'ai':
            case 'ask':
                return await handleAiCommand(args.join(' '), true, connectionInfo);
            case 'fix':
                return await handleAiFixCommand(args.join(' '), true, connectionInfo);
            case 'analyze':
                return await handleAiAnalyzeCommand(args.join(' '), true, connectionInfo);
            case 'cmd':
                return await handleNaturalLanguageCommand(args.join(' '), true, connectionInfo);
            default:
                // 对于非特殊命令，如果启用了AI，则作为普通AI对话处理
                if (getAiConfig(connectionInfo).apiKey) {
                    const fullInput = [command, ...args].join(' ');
                    return await handleGeneralAiChat(fullInput, true, connectionInfo);
                } else {
                    return { success: false, error: `Streaming not supported for command: ${command}. AI chat disabled (no API key).` };
                }
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 上下文压缩功能
async function compressContext(conversationHistory, connectionInfo = null) {
    const config = getAiConfig(connectionInfo);
    if (!config.apiKey) {
        throw new Error('需要AI API密钥来压缩上下文');
    }

    const contextText = conversationHistory.map(msg => 
        `${msg.role === 'user' ? '用户' : 'AI'}: ${msg.content}`
    ).join('\n\n');

    const compressionPrompt = `请将以下对话历史压缩为简洁的摘要，保留关键信息、重要分析和结论：

${contextText}

请提供一个结构化的摘要，包括：
1. 主要讨论话题
2. 重要的技术信息或命令
3. AI的关键分析和建议
4. 未解决的问题或待办事项

摘要应该简洁但包含足够信息以便后续对话参考。`;

    const messages = [
        { role: "system", content: "你是一个专业的对话摘要助手，能够提取和保留对话中的关键信息。" },
        { role: "user", content: compressionPrompt }
    ];

    try {
        const summary = await callOpenAI(messages, 800, false, null, 0, connectionInfo, config);
        
        // 创建压缩后的历史记录
        const compressedHistory = [
            { role: "system", content: `[压缩的对话历史摘要 - ${new Date().toLocaleString()}]\n${summary}` }
        ];

        return compressedHistory;
    } catch (error) {
        throw new Error(`上下文压缩失败: ${error.message}`);
    }
}

// 检查是否需要压缩上下文
function shouldCompressContext(conversationHistory, connectionInfo = null) {
    const contextSize = JSON.stringify(conversationHistory).length;
    return contextSize > getAiConfig(connectionInfo).contextCompressionThreshold;
}

// 全局修改记录系统
const changeTracker = {
    changes: [],          // 所有修改记录
    commandHistory: [],   // 命令执行历史
    fileWatcher: null,    // 文件监控器
    lastScan: new Date(), // 上次扫描时间
    
    // 记录修改
    recordChange: (type, filePath, operation, details = {}) => {
        const change = {
            timestamp: new Date().toISOString(),
            type: type, // 'builtin', 'command', 'file_change'
            filePath: filePath,
            operation: operation,
            details: details,
            id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };
        
        changeTracker.changes.push(change);
        
        // 保持最近1000条记录
        if (changeTracker.changes.length > 1000) {
            changeTracker.changes.shift();
        }
        
        console.log(`📝 记录修改: ${type} - ${operation} - ${filePath}`);
        return change.id;
    },
    
    // 记录命令执行
    recordCommand: (command, workingDir, result) => {
        const commandRecord = {
            timestamp: new Date().toISOString(),
            command: command,
            workingDir: workingDir,
            result: result,
            success: !result.includes('错误') && !result.includes('失败'),
            id: `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };
        
        changeTracker.commandHistory.push(commandRecord);
        changeTracker.recordChange('command', workingDir, command, commandRecord);
        
        // 保持最近500条命令记录
        if (changeTracker.commandHistory.length > 500) {
            changeTracker.commandHistory.shift();
        }
        
        return commandRecord.id;
    },
    
    // 启动定期扫描
    startPeriodicScan: (projectDir, intervalMinutes = 10) => {
        if (changeTracker.fileWatcher) {
            clearInterval(changeTracker.fileWatcher);
        }
        
        changeTracker.fileWatcher = setInterval(() => {
            console.log('🔍 执行定期项目扫描...');
            changeTracker.scanProjectChanges(projectDir);
        }, intervalMinutes * 60 * 1000);
        
        console.log(`🕐 已启动定期扫描，间隔: ${intervalMinutes} 分钟`);
    },
    
    // 停止定期扫描
    stopPeriodicScan: () => {
        if (changeTracker.fileWatcher) {
            clearInterval(changeTracker.fileWatcher);
            changeTracker.fileWatcher = null;
            console.log('⏹️ 已停止定期扫描');
        }
    },
    
    // 扫描项目文件变化
    scanProjectChanges: (projectDir) => {
        const fs = require('fs');
        const path = require('path');
        
        try {
            const scanFiles = (dir, relativePath = '') => {
                const files = [];
                const items = fs.readdirSync(dir);
                
                for (const item of items) {
                    // 跳过版本控制目录和常见的忽略目录
                    if (['.vc', '.git', 'node_modules', '.DS_Store'].includes(item)) {
                        continue;
                    }
                    
                    const fullPath = path.join(dir, item);
                    const relPath = path.join(relativePath, item);
                    const stat = fs.statSync(fullPath);
                    
                    if (stat.isDirectory()) {
                        files.push(...scanFiles(fullPath, relPath));
                    } else {
                        files.push({
                            path: relPath,
                            fullPath: fullPath,
                            size: stat.size,
                            mtime: stat.mtime.toISOString()
                        });
                    }
                }
                return files;
            };
            
            const currentFiles = scanFiles(projectDir);
            const scanId = `scan_${Date.now()}`;
            
            changeTracker.recordChange('file_scan', projectDir, 'project_scan', {
                scanId: scanId,
                fileCount: currentFiles.length,
                files: currentFiles
            });
            
            return currentFiles;
        } catch (error) {
            console.warn(`项目扫描失败: ${error.message}`);
            return [];
        }
    }
};

// 版本控制系统 - 增强版
const versionControl = {
    snapshots: new Map(), // 存储文件快照
    maxSnapshots: 10,     // 最大快照数量
    
    // 创建文件快照
    createSnapshot: (filePath, operation) => {
        const fs = require('fs');
        const path = require('path');
        
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const timestamp = new Date().toISOString();
                const snapshotId = `${timestamp}_${operation}`;
                
                if (!versionControl.snapshots.has(filePath)) {
                    versionControl.snapshots.set(filePath, []);
                }
                
                const fileSnapshots = versionControl.snapshots.get(filePath);
                fileSnapshots.push({
                    id: snapshotId,
                    timestamp: timestamp,
                    operation: operation,
                    content: content,
                    size: content.length
                });
                
                // 保持最大快照数量
                if (fileSnapshots.length > versionControl.maxSnapshots) {
                    fileSnapshots.shift();
                }
                
                console.log(`快照已创建: ${filePath} (${operation})`);
                return snapshotId;
            }
        } catch (error) {
            console.warn(`创建快照失败: ${error.message}`);
        }
        return null;
    },
    
    // 恢复文件到指定快照
    restoreSnapshot: (filePath, snapshotId) => {
        const fs = require('fs');
        
        try {
            const fileSnapshots = versionControl.snapshots.get(filePath);
            if (!fileSnapshots) {
                return `错误: 文件 ${filePath} 没有快照记录`;
            }
            
            const snapshot = fileSnapshots.find(s => s.id === snapshotId);
            if (!snapshot) {
                return `错误: 快照 ${snapshotId} 不存在`;
            }
            
            // 在恢复前创建当前状态的快照
            versionControl.createSnapshot(filePath, 'restore_backup');
            
            fs.writeFileSync(filePath, snapshot.content, 'utf8');
            return `成功恢复文件 ${filePath} 到快照 ${snapshotId} (${snapshot.operation})`;
        } catch (error) {
            return `恢复失败: ${error.message}`;
        }
    },
    
    // 列出文件的所有快照
    listSnapshots: (filePath) => {
        const fileSnapshots = versionControl.snapshots.get(filePath);
        if (!fileSnapshots || fileSnapshots.length === 0) {
            return `文件 ${filePath} 没有快照记录`;
        }
        
        let result = `=== ${filePath} 的快照历史 ===\n`;
        fileSnapshots.forEach((snapshot, index) => {
            result += `${index + 1}. ${snapshot.id}\n`;
            result += `   时间: ${snapshot.timestamp}\n`;
            result += `   操作: ${snapshot.operation}\n`;
            result += `   大小: ${snapshot.size} 字符\n\n`;
        });
        return result;
    }
};

// 内置bash函数 - 改进版，更安全和精确，带版本控制
const builtinBashFunctions0 = {
    // 查找和替换函数 - 使用Python实现，更健壮，带版本控制
    findAndReplace: (searchPattern, replaceText, specificFile) => {
        if (!specificFile || specificFile === '.' || specificFile === '*') {
            return `echo "错误: findAndReplace必须指定具体文件名，不能使用通配符。例如: findAndReplace('old', 'new', 'index.html')"`;
        }
        
        // 创建快照ID
        const snapshotId = `\${new Date().toISOString()}_findAndReplace`;
        
        // 使用Python进行安全的文本替换，避免shell转义问题
        // 安全地转义Python脚本中的变量
        const safeFileName = specificFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const safeSearchText = searchPattern.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
        const safeReplaceText = replaceText.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
        
        const pythonScript = `
import sys
import shutil
import os
import json
from datetime import datetime

try:
    filename = "${safeFileName}"
    search_text = """${safeSearchText}"""
    replace_text = """${safeReplaceText}"""
    
    if not os.path.exists(filename):
        print(f"错误: 文件 {filename} 不存在")
        sys.exit(1)
    
    # 创建版本控制快照
    with open(filename, 'r', encoding='utf-8') as f:
        original_content = f.read()
    
    timestamp = datetime.now().isoformat()
    snapshot_id = f"{timestamp}_findAndReplace"
    
    # 创建.vc目录存储快照
    vc_dir = os.path.join(os.path.dirname(filename) or '.', '.vc')
    os.makedirs(vc_dir, exist_ok=True)
    
    # 保存快照 - 文件名包含在快照ID中
    base_name = os.path.basename(filename).replace('.', '_')
    snapshot_id_with_file = f"{base_name}_{timestamp}_findAndReplace"
    snapshot_file = os.path.join(vc_dir, f"{snapshot_id_with_file}.snapshot")
    with open(snapshot_file, 'w', encoding='utf-8') as f:
        f.write(original_content)
    
    # 执行替换
    new_content = original_content.replace(search_text, replace_text)
    
    # 写回文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # 统计替换次数
    count = original_content.count(search_text)
    print(f"✅ 成功替换 {filename} 中的 '{search_text}' 为 '{replace_text}'，共替换 {count} 处")
    print(f"📸 快照已保存: {snapshot_id_with_file}")
    print(f"🔄 可使用 restoreFile('{filename}', '{snapshot_id_with_file}') 回退")
    
except Exception as e:
    print(f"❌ 替换失败: {e}")
    sys.exit(1)
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 安全的文件内容替换 - 先预览再确认
    previewReplace: (searchPattern, replaceText, specificFile) => {
        if (!specificFile || specificFile === '.' || specificFile === '*') {
            return `echo "错误: 必须指定具体文件名"`;
        }
        // 使用Python预览替换结果
        const pythonScript = `
import sys
import os

try:
    filename = "${specificFile}"
    search_text = """${searchPattern}"""
    replace_text = """${replaceText}"""
    
    if not os.path.exists(filename):
        print(f"错误: 文件 {filename} 不存在")
        sys.exit(1)
    
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 预览替换结果
    new_content = content.replace(search_text, replace_text)
    count = content.count(search_text)
    
    print(f"=== 预览替换结果 ===")
    print(f"文件: {filename}")
    print(f"查找: '{search_text}'")
    print(f"替换: '{replace_text}'")
    print(f"匹配次数: {count}")
    print(f"=== 替换后内容预览(前20行) ===")
    
    lines = new_content.split('\\n')
    for i, line in enumerate(lines[:20], 1):
        print(f"{i:3d}: {line}")
    
    if len(lines) > 20:
        print(f"... 还有 {len(lines) - 20} 行")
        
except Exception as e:
    print(f"预览失败: {e}")
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 在指定文件的指定位置插入内容 - 使用Python实现
    insertAfter: (targetLine, newContent, specificFile) => {
        if (!specificFile || specificFile === '.' || specificFile === '*') {
            return `echo "错误: 必须指定具体文件名"`;
        }
        // 安全地转义Python脚本中的变量
        const safeFileName = specificFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const safeTargetLine = targetLine.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
        const safeNewContent = newContent.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
        
        const pythonScript = `
import sys
import shutil
import os

try:
    filename = "${safeFileName}"
    target_line = """${safeTargetLine}"""
    new_content = """${safeNewContent}"""
    
    if not os.path.exists(filename):
        print(f"错误: 文件 {filename} 不存在")
        sys.exit(1)
    
    # 创建备份
    shutil.copy2(filename, filename + ".bak")
    
    # 读取文件
    with open(filename, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # 查找目标行并插入内容
    inserted = False
    new_lines = []
    for line in lines:
        new_lines.append(line)
        if target_line in line.strip():
            new_lines.append(new_content + '\\n')
            inserted = True
    
    if not inserted:
        print(f"警告: 未找到目标行 '{target_line}'")
        sys.exit(1)
    
    # 写回文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    print(f"成功在 {filename} 的 '{target_line}' 后插入内容")
    print(f"备份文件: {filename}.bak")
    
except Exception as e:
    print(f"插入失败: {e}")
    sys.exit(1)
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 在指定文件的指定位置前插入内容 - 使用Python实现
    insertBefore: (targetLine, newContent, specificFile) => {
        if (!specificFile || specificFile === '.' || specificFile === '*') {
            return `echo "错误: 必须指定具体文件名"`;
        }
        const pythonScript = `
import sys
import shutil
import os

try:
    filename = "${specificFile}"
    target_line = """${targetLine}"""
    new_content = """${newContent}"""
    
    if not os.path.exists(filename):
        print(f"错误: 文件 {filename} 不存在")
        sys.exit(1)
    
    # 创建备份
    shutil.copy2(filename, filename + ".bak")
    
    # 读取文件
    with open(filename, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # 查找目标行并插入内容
    inserted = False
    new_lines = []
    for line in lines:
        if target_line in line.strip() and not inserted:
            new_lines.append(new_content + '\\n')
            inserted = True
        new_lines.append(line)
    
    if not inserted:
        print(f"警告: 未找到目标行 '{target_line}'")
        sys.exit(1)
    
    # 写回文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    print(f"成功在 {filename} 的 '{target_line}' 前插入内容")
    print(f"备份文件: {filename}.bak")
    
except Exception as e:
    print(f"插入失败: {e}")
    sys.exit(1)
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 搜索指定行内容
    searchLines: (pattern, filePath = '.', lineNumbers = 'false') => {
        const showLineNumbers = lineNumbers === 'true' || lineNumbers === true;
        const grepCmd = showLineNumbers ? 'grep -n' : 'grep';
        const escapedPattern = pattern.replace(/['"]/g, '\\"');
        return `${grepCmd} -r "${escapedPattern}" "${filePath}" 2>/dev/null || echo "未找到匹配内容"`;
    },
    
    // 查看文件指定行
    showLines: (filePath, startLine, endLine = null) => {
        const start = parseInt(startLine) || 1;
        if (endLine && endLine !== 'null') {
            const end = parseInt(endLine) || start;
            return `sed -n '${start},${end}p' "${filePath}" 2>/dev/null || echo "无法读取文件或行号超出范围"`;
        } else {
            return `sed -n '${start}p' "${filePath}" 2>/dev/null || echo "无法读取文件或行号超出范围"`;
        }
    },
    
    // 统计文件行数
    countLines: (filePath) => {
        return `wc -l "${filePath}" 2>/dev/null || echo "无法读取文件: ${filePath}"`;
    },
    
    // 查找大文件
    findLargeFiles: (directory = '.', sizeMB = '100') => {
        const size = parseInt(sizeMB) || 100;
        return `find "${directory}" -type f -size +${size}M -exec ls -lh {} \\; 2>/dev/null | sort -k5 -hr | head -20`;
    },
    
    // 查找最近修改的文件
    findRecentFiles: (directory = '.', days = '7') => {
        const dayCount = parseInt(days) || 7;
        return `find "${directory}" -type f -mtime -${dayCount} -exec ls -lt {} \\; 2>/dev/null | head -20`;
    },
    
    // 磁盘使用情况
    diskUsage: (directory = '.') => {
        return `du -sh "${directory}"/* 2>/dev/null | sort -hr | head -20`;
    },
    
    // 进程监控
    processMonitor: (processName = '') => {
        if (processName && processName !== '') {
            return `ps aux | grep "${processName}" | grep -v grep | head -10`;
        } else {
            return `ps aux --sort=-%cpu | head -10`;
        }
    },
    
    // 网络连接监控
    networkConnections: (port = '') => {
        if (port && port !== '') {
            return `netstat -tulpn 2>/dev/null | grep ":${port}" || ss -tulpn 2>/dev/null | grep ":${port}" || echo "端口 ${port} 未找到监听连接"`;
        } else {
            return `netstat -tulpn 2>/dev/null | grep LISTEN | head -20 || ss -tulpn 2>/dev/null | grep LISTEN | head -20`;
        }
    },
    
    // 系统信息快速查看
    systemInfo: () => {
        return `echo "=== 系统信息 ===" && uname -a && echo "" && echo "=== 内存使用 ===" && free -h && echo "" && echo "=== 磁盘使用 ===" && df -h && echo "" && echo "=== 负载情况 ===" && uptime && echo "" && echo "=== 当前用户 ===" && whoami`;
    },
    
    // 文件权限检查
    checkPermissions: (filePath) => {
        return `ls -la "${filePath}" 2>/dev/null || echo "文件不存在: ${filePath}"`;
    },
    
    // 快速备份文件
    backupFile: (filePath) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `cp "${filePath}" "${filePath}.backup.${timestamp}" 2>/dev/null && echo "已备份到: ${filePath}.backup.${timestamp}" || echo "备份失败: ${filePath}"`;
    },
    
    // 查看目录结构
    showTree: (directory = '.', depth = '2') => {
        const maxDepth = parseInt(depth) || 2;
        return `find "${directory}" -maxdepth ${maxDepth} -type d 2>/dev/null | sort || ls -la "${directory}"`;
    },
    
    // 创建新文件并添加基础内容 - 使用Python实现
    createFile: (fileName, content = '') => {
        if (!fileName || fileName.includes('*') || fileName.includes('..')) {
            return `echo "错误: 文件名不能为空或包含危险字符"`;
        }
        // 安全地转义Python脚本中的变量
        const safeFileName = fileName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const safeContent = content.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
        
        const pythonScript = `
import sys
import os

try:
    filename = "${safeFileName}"
    content = """${safeContent}"""
    
    # 检查文件是否已存在
    if os.path.exists(filename):
        print(f"警告: 文件 {filename} 已存在，将被覆盖")
    
    # 创建目录(如果需要)
    dirname = os.path.dirname(filename)
    if dirname and not os.path.exists(dirname):
        os.makedirs(dirname)
    
    # 写入文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"成功创建文件: {filename}")
    print(f"文件大小: {len(content)} 字符")
    
except Exception as e:
    print(f"创建文件失败: {e}")
    sys.exit(1)
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 追加内容到文件末尾 - 使用Python实现
    appendToFile: (fileName, content) => {
        if (!fileName || fileName.includes('*') || fileName.includes('..')) {
            return `echo "错误: 文件名不能为空或包含危险字符"`;
        }
        const pythonScript = `
import sys
import os

try:
    filename = "${fileName}"
    content = """${content}"""
    
    # 追加内容到文件
    with open(filename, 'a', encoding='utf-8') as f:
        f.write(content)
    
    print(f"成功追加内容到: {filename}")
    print(f"追加内容长度: {len(content)} 字符")
    
except Exception as e:
    print(f"追加内容失败: {e}")
    sys.exit(1)
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 创建项目目录结构
    createProjectStructure: (projectName) => {
        if (!projectName || projectName.includes(' ') || projectName.includes('..')) {
            return `echo "错误: 项目名称不能包含空格或危险字符"`;
        }
        return `mkdir -p "${projectName}"/{src,assets/{css,js,images},docs} && echo "已创建项目结构: ${projectName}/"`;
    },
    
    // 快速创建HTML模板 - 使用Python实现
    createHtmlTemplate: (fileName, title = 'New Page') => {
        if (!fileName || !fileName.endsWith('.html')) {
            return `echo "错误: 必须指定.html文件名"`;
        }
        const pythonScript = `
import sys
import os

try:
    filename = "${fileName}"
    title = """${title}"""
    
    template = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>{title}</h1>
    </header>
    <main>
        <p>页面内容...</p>
    </main>
    <script src="script.js"></script>
</body>
</html>"""
    
    # 检查文件是否已存在
    if os.path.exists(filename):
        print(f"警告: 文件 {filename} 已存在，将被覆盖")
    
    # 写入文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(template)
    
    print(f"成功创建HTML模板: {filename}")
    print(f"页面标题: {title}")
    
except Exception as e:
    print(f"创建HTML模板失败: {e}")
    sys.exit(1)
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 快速创建CSS文件 - 使用Python实现
    createCssTemplate: (fileName) => {
        if (!fileName || !fileName.endsWith('.css')) {
            return `echo "错误: 必须指定.css文件名"`;
        }
        const pythonScript = `
import sys
import os

try:
    filename = "${fileName}"
    
    template = f"""/* {filename} */
* {{
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}}

body {{
    font-family: Arial, sans-serif;
    line-height: 1.6;
    color: #333;
}}

header {{
    background: #f4f4f4;
    padding: 1rem;
    text-align: center;
}}

main {{
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;
}}

/* 响应式设计 */
@media (max-width: 768px) {{
    main {{
        padding: 1rem;
    }}
}}"""
    
    # 检查文件是否已存在
    if os.path.exists(filename):
        print(f"警告: 文件 {filename} 已存在，将被覆盖")
    
    # 写入文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(template)
    
    print(f"成功创建CSS模板: {filename}")
    
except Exception as e:
    print(f"创建CSS模板失败: {e}")
    sys.exit(1)
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 安全删除文件（移动到回收站）
    safeDelete: (fileName) => {
        if (!fileName || fileName.includes('*') || fileName.includes('..')) {
            return `echo "错误: 文件名不能为空或包含危险字符"`;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `mkdir -p .trash && mv "${fileName}" ".trash/${fileName}.deleted.${timestamp}" && echo "已安全删除: ${fileName} -> .trash/"`;
    },
    
    // 查看文件差异
    showDiff: (file1, file2) => {
        if (!file1 || !file2) {
            return `echo "错误: 必须指定两个文件名"`;
        }
        return `diff -u "${file1}" "${file2}" || echo "文件内容相同或其中一个文件不存在"`;
    },

    // === 版本控制函数 ===
    
    // 列出文件的快照历史
    listSnapshots: (filePath) => {
        if (!filePath) {
            return `echo "错误: 必须指定文件路径"`;
        }
        const pythonScript = `
import os
import glob
from datetime import datetime

try:
    filename = "${filePath}"
    base_name = os.path.basename(filename)
    dir_name = os.path.dirname(filename) or '.'
    vc_dir = os.path.join(dir_name, '.vc')
    
    if not os.path.exists(vc_dir):
        print(f"📁 文件 {filename} 没有版本控制记录")
        exit(0)
    
    # 查找快照文件
    pattern = os.path.join(vc_dir, f"{base_name}_*.snapshot")
    snapshots = glob.glob(pattern)
    
    if not snapshots:
        print(f"📁 文件 {filename} 没有快照记录")
        exit(0)
    
    print(f"=== 📸 {filename} 的快照历史 ===")
    snapshots.sort(reverse=True)  # 最新的在前
    
    for i, snapshot_path in enumerate(snapshots):
        snapshot_name = os.path.basename(snapshot_path)
        # 提取快照ID
        snapshot_id = snapshot_name.replace(f"{base_name}_", "").replace(".snapshot", "")
        
        # 获取文件信息
        stat = os.stat(snapshot_path)
        size = stat.st_size
        mtime = datetime.fromtimestamp(stat.st_mtime)
        
        print(f"{i+1}. 🕐 {snapshot_id}")
        print(f"   📅 时间: {mtime.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"   📏 大小: {size} 字节")
        print("")
    
    print("💡 使用 restoreFile(文件路径, 快照ID) 来恢复文件")
    
except Exception as e:
    print(f"❌ 列出快照失败: {e}")
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 恢复文件到指定快照
    restoreFile: (filePath, snapshotId) => {
        if (!filePath || !snapshotId) {
            return `echo "错误: 必须指定文件路径和快照ID"`;
        }
        const pythonScript = `
import os
import shutil
from datetime import datetime

try:
    filename = "${filePath}"
    snapshot_id = "${snapshotId}"
    
    base_name = os.path.basename(filename)
    dir_name = os.path.dirname(filename) or '.'
    vc_dir = os.path.join(dir_name, '.vc')
    
    # 查找快照文件
    snapshot_file = os.path.join(vc_dir, f"{base_name}_{snapshot_id}.snapshot")
    
    if not os.path.exists(snapshot_file):
        print(f"❌ 快照不存在: {snapshot_id}")
        print("💡 使用 listSnapshots('{filename}') 查看可用快照")
        exit(1)
    
    # 在恢复前创建当前状态的快照
    if os.path.exists(filename):
        current_timestamp = datetime.now().isoformat()
        backup_snapshot = f"{current_timestamp}_restore_backup"
        backup_file = os.path.join(vc_dir, f"{base_name}_{backup_snapshot}.snapshot")
        shutil.copy2(filename, backup_file)
        print(f"📸 已创建恢复前快照: {backup_snapshot}")
    
    # 恢复文件
    shutil.copy2(snapshot_file, filename)
    print(f"✅ 成功恢复文件 {filename} 到快照 {snapshot_id}")
    print(f"🔄 如需撤销，可恢复到快照: {backup_snapshot}")
    
except Exception as e:
    print(f"❌ 恢复失败: {e}")
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // === 全局修改记录函数 ===
    
    // 按时间列出所有修改
    listAllChanges: (hours = 24) => {
        const pythonScript = `
import os
import json
from datetime import datetime, timedelta

try:
    hours = int("${hours}")
    cutoff_time = datetime.now() - timedelta(hours=hours)
    
    # 读取修改记录（这里简化为扫描.vc目录）
    changes = []
    
    # 扫描当前目录及子目录的.vc文件夹
    for root, dirs, files in os.walk('.'):
        if '.vc' in dirs:
            vc_dir = os.path.join(root, '.vc')
            for file in os.listdir(vc_dir):
                if file.endswith('.snapshot'):
                    file_path = os.path.join(vc_dir, file)
                    stat = os.stat(file_path)
                    mtime = datetime.fromtimestamp(stat.st_mtime)
                    
                    if mtime > cutoff_time:
                        # 解析快照文件名
                        parts = file.replace('.snapshot', '').split('_')
                        if len(parts) >= 3:
                            file_name = parts[0]
                            timestamp_str = '_'.join(parts[1:-1])
                            operation = parts[-1]
                            
                            changes.append({
                                'time': mtime.strftime('%Y-%m-%d %H:%M:%S'),
                                'file': file_name.replace('_', '.'),
                                'operation': operation,
                                'path': os.path.dirname(file_path).replace('/.vc', ''),
                                'size': stat.st_size
                            })
    
    if not changes:
        print(f"📅 最近 {hours} 小时内没有修改记录")
        exit(0)
    
    # 按时间排序
    changes.sort(key=lambda x: x['time'], reverse=True)
    
    print(f"=== 📝 最近 {hours} 小时的所有修改 ===")
    print("")
    
    for change in changes:
        print(f"🕐 {change['time']}")
        print(f"📁 {change['path']}/{change['file']}")
        print(f"⚡ {change['operation']}")
        print(f"📏 {change['size']} 字节")
        print("")
    
    print(f"💡 总共 {len(changes)} 个修改")
    
except Exception as e:
    print(f"❌ 查看修改记录失败: {e}")
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 扫描项目文件变化
    scanProjectFiles: (directory = '.') => {
        const pythonScript = `
import os
import json
from datetime import datetime

try:
    directory = "${directory}"
    
    def scan_directory(path, relative_path=''):
        files = []
        try:
            for item in os.listdir(path):
                # 跳过版本控制和常见忽略目录
                if item in ['.vc', '.git', 'node_modules', '.DS_Store', '__pycache__']:
                    continue
                
                item_path = os.path.join(path, item)
                rel_path = os.path.join(relative_path, item) if relative_path else item
                
                if os.path.isdir(item_path):
                    files.extend(scan_directory(item_path, rel_path))
                else:
                    stat = os.stat(item_path)
                    files.append({
                        'path': rel_path,
                        'size': stat.st_size,
                        'mtime': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
                        'type': 'file'
                    })
        except PermissionError:
            pass
        return files
    
    files = scan_directory(directory)
    
    print(f"=== 📁 项目文件扫描结果 ===")
    print(f"📍 扫描目录: {os.path.abspath(directory)}")
    print(f"🕐 扫描时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"📊 文件总数: {len(files)}")
    print("")
    
    # 按修改时间排序，显示最近修改的文件
    files.sort(key=lambda x: x['mtime'], reverse=True)
    
    print("🔥 最近修改的文件 (前20个):")
    for i, file in enumerate(files[:20]):
        print(f"{i+1:2d}. {file['mtime']} - {file['path']} ({file['size']} 字节)")
    
    if len(files) > 20:
        print(f"... 还有 {len(files) - 20} 个文件")
    
    print("")
    print("💡 使用 listAllChanges(小时数) 查看详细修改记录")
    
except Exception as e:
    print(f"❌ 扫描失败: {e}")
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },
    
    // 清理旧快照
    cleanSnapshots: (filePath, keepCount = 5) => {
        if (!filePath) {
            return `echo "错误: 必须指定文件路径"`;
        }
        const pythonScript = `
import os
import glob

try:
    filename = "${filePath}"
    keep_count = int("${keepCount}")
    
    base_name = os.path.basename(filename)
    dir_name = os.path.dirname(filename) or '.'
    vc_dir = os.path.join(dir_name, '.vc')
    
    if not os.path.exists(vc_dir):
        print(f"📁 没有版本控制目录")
        exit(0)
    
    # 查找快照文件
    pattern = os.path.join(vc_dir, f"{base_name}_*.snapshot")
    snapshots = glob.glob(pattern)
    
    if len(snapshots) <= keep_count:
        print(f"📸 当前有 {len(snapshots)} 个快照，无需清理")
        exit(0)
    
    # 按时间排序，保留最新的
    snapshots.sort(key=os.path.getmtime, reverse=True)
    to_delete = snapshots[keep_count:]
    
    for snapshot in to_delete:
        os.remove(snapshot)
        snapshot_name = os.path.basename(snapshot)
        print(f"🗑️ 已删除旧快照: {snapshot_name}")
    
    print(f"✅ 清理完成，保留最新 {keep_count} 个快照")
    
except Exception as e:
    print(f"❌ 清理失败: {e}")
`;
        return `python3 -c "${pythonScript.replace(/"/g, '\\"')}" || python -c "${pythonScript.replace(/"/g, '\\"')}"`;
    },

    // === Node.js 开发函数 ===
    
    // 初始化npm项目
    npmInit: (projectName = '', description = '') => {
        const name = projectName || 'my-project';
        const desc = description || 'A new Node.js project';
        return `npm init -y && npm pkg set name="${name}" description="${desc}" && echo "已初始化npm项目: ${name}"`;
    },
    
    // 安装npm包
    npmInstall: (packages, isDev = false) => {
        if (!packages) {
            return `echo "错误: 必须指定要安装的包名"`;
        }
        const devFlag = isDev === true || isDev === 'true' ? '--save-dev' : '';
        return `npm install ${devFlag} ${packages} && echo "已安装包: ${packages}"`;
    },
    
    // 运行npm脚本
    npmRun: (scriptName) => {
        if (!scriptName) {
            return `echo "错误: 必须指定脚本名称"`;
        }
        return `npm run ${scriptName}`;
    },
    
    // 查看npm脚本
    npmScripts: () => {
        return `npm run && echo "--- package.json scripts ---" && cat package.json | grep -A 20 '"scripts"'`;
    },
    
    // 创建Node.js入口文件
    createNodeEntry: (fileName = 'index.js') => {
        const template = `const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.static('public'));

// 路由
app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(PORT, () => {
    console.log(\`Server running on port \${PORT}\`);
});`;
        const safeTemplate = template.replace(/'/g, "'\"'\"'");
        return `echo '${safeTemplate}' > "${fileName}" && echo "已创建Node.js入口文件: ${fileName}"`;
    },

    // === Vite 开发函数 ===
    
    // 创建Vite项目
    createViteProject: (projectName, template = 'vanilla') => {
        if (!projectName) {
            return `echo "错误: 必须指定项目名称"`;
        }
        return `npm create vite@latest "${projectName}" -- --template ${template} && echo "已创建Vite项目: ${projectName}"`;
    },
    
    // Vite开发服务器
    viteServe: () => {
        return `npm run dev || vite`;
    },
    
    // Vite构建
    viteBuild: () => {
        return `npm run build || vite build`;
    },
    
    // 创建Vite配置文件
    createViteConfig: () => {
        const config = `import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})`;
        const safeConfig = config.replace(/'/g, "'\"'\"'");
        return `echo '${safeConfig}' > "vite.config.js" && echo "已创建Vite配置文件"`;
    },

    // === Electron 开发函数 ===
    
    // 初始化Electron项目
    electronInit: (projectName = 'electron-app') => {
        return `npm init -y && npm install electron --save-dev && npm pkg set main="main.js" && npm pkg set scripts.start="electron ." && echo "已初始化Electron项目: ${projectName}"`;
    },
    
    // 创建Electron主进程文件
    createElectronMain: () => {
        const template = `const { app, BrowserWindow } = require('electron');
const path = require('path');

	function createWindow() {
	    const mainWindow = new BrowserWindow({
	        width: 1200,
	        height: 800,
	        webPreferences: {
	            nodeIntegration: false,
	            contextIsolation: true
	        }
	    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});`;
        const safeTemplate = template.replace(/'/g, "'\"'\"'");
        return `echo '${safeTemplate}' > "main.js" && echo "已创建Electron主进程文件"`;
    },
    
    // Electron打包
    electronBuild: () => {
        return `npm install electron-builder --save-dev && npm run build || electron-builder`;
    },

    // === Git 开发函数 ===
    
    // Git初始化
    gitInit: () => {
        return `git init && echo "已初始化Git仓库"`;
    },
    
    // Git添加和提交
    gitCommit: (message = 'Initial commit') => {
        const safeMessage = message.replace(/'/g, "'\"'\"'");
        return `git add . && git commit -m "${safeMessage}" && echo "已提交: ${message}"`;
    },
    
    // 创建.gitignore
    createGitignore: (type = 'node') => {
        let template = '';
        if (type === 'node') {
            template = `node_modules/
dist/
build/
.env
.env.local
.DS_Store
*.log
coverage/`;
        } else if (type === 'web') {
            template = `node_modules/
dist/
build/
.env
.DS_Store
*.log`;
        }
        const safeTemplate = template.replace(/'/g, "'\"'\"'");
        return `echo '${safeTemplate}' > ".gitignore" && echo "已创建.gitignore文件"`;
    },

    // === 通用开发函数 ===
    
    // 创建README文件
    createReadme: (projectName, description = '') => {
        if (!projectName) {
            return `echo "错误: 必须指定项目名称"`;
        }
        const template = `# ${projectName}

${description}

## 安装

\`\`\`bash
npm install
\`\`\`

## 使用

\`\`\`bash
npm start
\`\`\`

## 开发

\`\`\`bash
npm run dev
\`\`\`

## 构建

\`\`\`bash
npm run build
\`\`\``;
        const safeTemplate = template.replace(/'/g, "'\"'\"'");
        return `echo '${safeTemplate}' > "README.md" && echo "已创建README.md文件"`;
    },
    
    // 查看端口占用
    checkPort: (port) => {
        if (!port) {
            return `echo "错误: 必须指定端口号"`;
        }
        return `lsof -i :${port} || netstat -tulpn | grep :${port} || echo "端口 ${port} 未被占用"`;
    },
    
    // 杀死端口进程
    killPort: (port) => {
        if (!port) {
            return `echo "错误: 必须指定端口号"`;
        }
        return `lsof -ti:${port} | xargs kill -9 && echo "已杀死端口 ${port} 的进程" || echo "端口 ${port} 没有运行的进程"`;
    },
    
    // 查看项目依赖
    showDependencies: () => {
        return `echo "=== 生产依赖 ===" && npm list --depth=0 && echo "=== 开发依赖 ===" && npm list --depth=0 --dev`;
    },
    
    // 清理项目
    cleanProject: () => {
        return `rm -rf node_modules package-lock.json && echo "已清理node_modules和package-lock.json"`;
    },
    
    // 重新安装依赖
    reinstallDeps: () => {
        return `rm -rf node_modules package-lock.json && npm install && echo "已重新安装所有依赖"`;
    }
};

// 解析并执行内置bash函数
function parseBuiltinFunction0(command) {
    // 改进的函数解析 - 正确处理嵌套括号
    const functionNameMatch = command.match(/^(\w+)\s*\(/);
    if (!functionNameMatch) {
        return null;
    }
    
    const functionName = functionNameMatch[1];
    const startIndex = command.indexOf('(') + 1;
    
    // 找到匹配的右括号，考虑嵌套括号
    let bracketCount = 1;
    let endIndex = startIndex;
    let inQuotes = false;
    let quoteChar = '';
    
    while (endIndex < command.length && bracketCount > 0) {
        const char = command[endIndex];
        
        if (!inQuotes && (char === '"' || char === "'")) {
            inQuotes = true;
            quoteChar = char;
        } else if (inQuotes && char === quoteChar) {
            // 检查是否是转义的引号 - 需要计算连续的反斜杠数量
            let backslashCount = 0;
            let checkIndex = endIndex - 1;
            while (checkIndex >= 0 && command[checkIndex] === '\\') {
                backslashCount++;
                checkIndex--;
            }
            // 如果反斜杠数量是偶数，则引号没有被转义
            if (backslashCount % 2 === 0) {
                inQuotes = false;
                quoteChar = '';
            }
        } else if (!inQuotes) {
            if (char === '(') {
                bracketCount++;
            } else if (char === ')') {
                bracketCount--;
            }
        }
        
        if (bracketCount > 0) {
            endIndex++;
        }
    }
    
    if (bracketCount !== 0) {
        console.warn('函数调用括号不匹配');
        return null;
    }
    
    const argsString = command.substring(startIndex, endIndex);
    
    // 正确的参数解析 - 支持引号内的逗号
    const args = [];
    if (argsString.trim()) {
        let currentArg = '';
        let inQuotes = false;
        let quoteChar = '';
        let i = 0;
        
        while (i < argsString.length) {
            const char = argsString[i];
            
            if (!inQuotes && (char === '"' || char === "'")) {
                // 开始引号
                inQuotes = true;
                quoteChar = char;
            } else if (inQuotes && char === quoteChar) {
                // 结束引号
                inQuotes = false;
                quoteChar = '';
            } else if (!inQuotes && char === ',') {
                // 参数分隔符
                args.push(currentArg.trim());
                currentArg = '';
                i++;
                continue;
            } else {
                // 普通字符
                currentArg += char;
            }
            i++;
        }
        
        // 添加最后一个参数
        if (currentArg.trim()) {
            args.push(currentArg.trim());
        }
        
        // 移除参数的外层引号并处理转义字符
        for (let i = 0; i < args.length; i++) {
            let arg = args[i];
            if ((arg.startsWith('"') && arg.endsWith('"')) || 
                (arg.startsWith("'") && arg.endsWith("'"))) {
                let unquoted = arg.slice(1, -1);
                // 处理常见的转义字符
                unquoted = unquoted.replace(/\\"/g, '"')
                                 .replace(/\\'/g, "'")
                                 .replace(/\\\\/g, '\\')
                                 .replace(/\\n/g, '\n')
                                 .replace(/\\t/g, '\t')
                                 .replace(/\\r/g, '\r');
                args[i] = unquoted;
            }
        }
    }
    
    // 检查是否是内置函数
    if (builtinBashFunctions[functionName]) {
        console.log(`解析内置函数: ${functionName}，参数数量: ${args.length}`);
        return builtinBashFunctions[functionName](...args);
    }
    
    return null;
}
// 内置bash函数 - 修复版，解决转义和安全问题
const builtinBashFunctions = {
    // 交互式：Python REPL 控制（返回特殊前缀以便上层处理）
    enter_python_repl: () => {
        return '__REPL__:REPL_PY_START';
    },
    py_send: (line) => {
        // 保持原样，不进行转义，由上层直接写入sshStream
        const payload = (line || '').toString();
        const b64 = Buffer.from(payload, 'utf-8').toString('base64');
        return `__REPL__:REPL_PY_SEND:${b64}`;
    },
    py_exit: () => {
        return '__REPL__:REPL_PY_EXIT';
    },
    // Node REPL
    enter_node_repl: () => {
        return '__REPL__:REPL_NODE_START';
    },
    node_send: (line) => {
        const payload = (line || '').toString();
        const b64 = Buffer.from(payload, 'utf-8').toString('base64');
        return `__REPL__:REPL_NODE_SEND:${b64}`;
    },
    node_exit: () => {
        return '__REPL__:REPL_NODE_EXIT';
    },
    // MySQL REPL（需要远端有 mysql 客户端，参数为连接参数串，如 "-u user -p'pass' -h 127.0.0.1 db"）
    enter_mysql_repl: (conn) => {
        const payload = (conn || '').toString();
        const b64 = Buffer.from(payload, 'utf-8').toString('base64');
        return `__REPL__:REPL_MYSQL_START:${b64}`;
    },
    mysql_send: (line) => {
        const payload = (line || '').toString();
        const b64 = Buffer.from(payload, 'utf-8').toString('base64');
        return `__REPL__:REPL_MYSQL_SEND:${b64}`;
    },
    mysql_exit: () => {
        return '__REPL__:REPL_MYSQL_EXIT';
    },
    // 通用交互式会话（remote/local），用于 codex/claude 等交互式CLI
    interactive_start: (cmd, target = 'auto') => {
        const payload = (cmd || '').toString();
        const t = (target || 'auto').toString().trim().toLowerCase();
        const safeTarget = (t === 'local' || t === 'remote') ? t : 'auto';
        const b64 = Buffer.from(payload, 'utf-8').toString('base64');
        return `__INTERACTIVE__:START:${safeTarget}:${b64}`;
    },
    interactive_send: (text) => {
        const payload = (text || '').toString();
        const b64 = Buffer.from(payload, 'utf-8').toString('base64');
        return `__INTERACTIVE__:SEND:${b64}`;
    },
    interactive_line: (text) => {
        const payload = (text || '').toString();
        const b64 = Buffer.from(payload, 'utf-8').toString('base64');
        return `__INTERACTIVE__:LINE:${b64}`;
    },
    interactive_key: (keyName, count = 1) => {
        const key = (keyName || '').toString().trim().toUpperCase();
        const n = Math.max(1, Math.min(50, parseInt(count, 10) || 1));
        return `__INTERACTIVE__:KEY:${key}:${n}`;
    },
    interactive_ctrl: (keyName) => {
        const key = (keyName || '').toString().trim().toUpperCase();
        return `__INTERACTIVE__:CTRL:${key}`;
    },
    interactive_wait: (ms = 800) => {
        const n = Math.max(0, Math.min(60000, parseInt(ms, 10) || 0));
        return `__INTERACTIVE__:WAIT:${n}`;
    },
    interactive_wait_for: (text, timeoutMs = 8000) => {
        const needle = (text || '').toString();
        const b64 = Buffer.from(needle, 'utf-8').toString('base64');
        const ms = Math.max(200, Math.min(60000, parseInt(timeoutMs, 10) || 8000));
        return `__INTERACTIVE__:WAIT_FOR:${b64}:${ms}`;
    },
    interactive_exit: () => {
        return `__INTERACTIVE__:EXIT`;
    },
    interactive_stop: () => {
        return `__INTERACTIVE__:STOP`;
    },
    // MCP 检索类（不在远端执行，返回特殊前缀交由上层处理）
    mcp_expand: (summaryId, keywords = '') => {
        const sid = (summaryId || '').toString().trim();
        const b64 = Buffer.from((keywords || '').toString(), 'utf-8').toString('base64');
        return `__MCP__:EXPAND:${sid}:${b64}`;
    },
    mcp_fetch: (start, end) => {
        const s = parseInt(start, 10); const e = parseInt(end, 10);
        return `__MCP__:FETCH:${isNaN(s)?-1:s}:${isNaN(e)?-1:e}`;
    },
    mcp_search: (query, limit = 20) => {
        const b64 = Buffer.from((query || '').toString(), 'utf-8').toString('base64');
        const lim = parseInt(limit, 10) || 20;
        return `__MCP__:SEARCH:${b64}:${lim}`;
    },
    // 查找和替换函数 - 修复转义问题
    findAndReplace: (searchPattern, replaceText, specificFile) => {
        if (!specificFile || specificFile === '.' || specificFile === '*') {
            return `echo "错误: findAndReplace必须指定具体文件名，不能使用通配符。例如: findAndReplace('old', 'new', 'index.html')"`;
        }
        
        // 验证文件名安全性
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(specificFile)) {
            return `echo "错误: 文件名包含非法字符"`;
        }
        
        // 使用Base64编码避免转义问题
        const fileNameB64 = Buffer.from(specificFile).toString('base64');
        const searchPatternB64 = Buffer.from(searchPattern).toString('base64');
        const replaceTextB64 = Buffer.from(replaceText).toString('base64');
        
        // Python脚本使用单引号包裹，避免双引号转义问题
        const pythonScript = `
import sys
import shutil
import os
import base64
from datetime import datetime

try:
    # 解码Base64参数
    filename = base64.b64decode('${fileNameB64}').decode('utf-8')
    search_text = base64.b64decode('${searchPatternB64}').decode('utf-8')
    replace_text = base64.b64decode('${replaceTextB64}').decode('utf-8')
    
    if not os.path.exists(filename):
        print(f"错误: 文件 {filename} 不存在")
        sys.exit(1)
    
    # 创建版本控制快照
    with open(filename, 'r', encoding='utf-8') as f:
        original_content = f.read()
    
    timestamp = datetime.now().isoformat()
    snapshot_id = f"{timestamp}_findAndReplace"
    
    # 创建.vc目录存储快照
    vc_dir = os.path.join(os.path.dirname(filename) or '.', '.vc')
    os.makedirs(vc_dir, exist_ok=True)
    
    # 保存快照
    base_name = os.path.basename(filename).replace('.', '_')
    snapshot_id_with_file = f"{base_name}_{timestamp}_findAndReplace"
    snapshot_file = os.path.join(vc_dir, f"{snapshot_id_with_file}.snapshot")
    with open(snapshot_file, 'w', encoding='utf-8') as f:
        f.write(original_content)
    
    # 执行替换
    new_content = original_content.replace(search_text, replace_text)
    
    # 写回文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # 统计替换次数
    count = original_content.count(search_text)
    print(f"✅ 成功替换 {filename} 中的 '{search_text}' 为 '{replace_text}'，共替换 {count} 处")
    print(f"📸 快照已保存: {snapshot_id_with_file}")
    print(f"🔄 可使用 restoreFile('{filename}', '{snapshot_id_with_file}') 回退")
    
except Exception as e:
    print(f"❌ 替换失败: {e}")
    sys.exit(1)
`;
        
        // 将Python脚本写入临时文件执行，避免shell转义问题
        const tempFileName = `/tmp/findreplace_${Date.now()}.py`;
        const scriptB64 = Buffer.from(pythonScript).toString('base64');
        
        return `echo '${scriptB64}' | base64 -d > ${tempFileName} && python3 ${tempFileName} && rm -f ${tempFileName}`;
    },
    
    // 安全的文件内容替换 - 预览功能
    previewReplace: (searchPattern, replaceText, specificFile) => {
        if (!specificFile || specificFile === '.' || specificFile === '*') {
            return `echo "错误: 必须指定具体文件名"`;
        }
        
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(specificFile)) {
            return `echo "错误: 文件名包含非法字符"`;
        }
        
        // 使用Base64编码
        const fileNameB64 = Buffer.from(specificFile).toString('base64');
        const searchPatternB64 = Buffer.from(searchPattern).toString('base64');
        const replaceTextB64 = Buffer.from(replaceText).toString('base64');
        
        const pythonScript = `
import sys
import os
import base64

try:
    filename = base64.b64decode('${fileNameB64}').decode('utf-8')
    search_text = base64.b64decode('${searchPatternB64}').decode('utf-8')
    replace_text = base64.b64decode('${replaceTextB64}').decode('utf-8')
    
    if not os.path.exists(filename):
        print(f"错误: 文件 {filename} 不存在")
        sys.exit(1)
    
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 预览替换结果
    new_content = content.replace(search_text, replace_text)
    count = content.count(search_text)
    
    print(f"=== 预览替换结果 ===")
    print(f"文件: {filename}")
    print(f"查找: '{search_text}'")
    print(f"替换: '{replace_text}'")
    print(f"匹配次数: {count}")
    print(f"=== 替换后内容预览(前20行) ===")
    
    lines = new_content.split('\\n')
    for i, line in enumerate(lines[:20], 1):
        print(f"{i:3d}: {line}")
    
    if len(lines) > 20:
        print(f"... 还有 {len(lines) - 20} 行")
        
except Exception as e:
    print(f"预览失败: {e}")
`;
        
        const tempFileName = `/tmp/preview_${Date.now()}.py`;
        const scriptB64 = Buffer.from(pythonScript).toString('base64');
        
        return `echo '${scriptB64}' | base64 -d > ${tempFileName} && python3 ${tempFileName} && rm -f ${tempFileName}`;
    },
    
    // 在指定位置插入内容 - 修复转义
    insertAfter: (targetLine, newContent, specificFile) => {
        if (!specificFile || specificFile === '.' || specificFile === '*') {
            return `echo "错误: 必须指定具体文件名"`;
        }
        
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(specificFile)) {
            return `echo "错误: 文件名包含非法字符"`;
        }
        
        // Base64编码所有参数
        const fileNameB64 = Buffer.from(specificFile).toString('base64');
        const targetLineB64 = Buffer.from(targetLine).toString('base64');
        const newContentB64 = Buffer.from(newContent).toString('base64');
        
        const pythonScript = `
import sys
import shutil
import os
import base64

try:
    filename = base64.b64decode('${fileNameB64}').decode('utf-8')
    target_line = base64.b64decode('${targetLineB64}').decode('utf-8')
    new_content = base64.b64decode('${newContentB64}').decode('utf-8')
    
    if not os.path.exists(filename):
        print(f"错误: 文件 {filename} 不存在")
        sys.exit(1)
    
    # 创建备份
    shutil.copy2(filename, filename + ".bak")
    
    # 读取文件
    with open(filename, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # 查找目标行并插入内容
    inserted = False
    new_lines = []
    for line in lines:
        new_lines.append(line)
        if target_line in line.strip():
            new_lines.append(new_content + '\\n')
            inserted = True
    
    if not inserted:
        print(f"警告: 未找到目标行 '{target_line}'")
        sys.exit(1)
    
    # 写回文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    print(f"成功在 {filename} 的 '{target_line}' 后插入内容")
    print(f"备份文件: {filename}.bak")
    
except Exception as e:
    print(f"插入失败: {e}")
    sys.exit(1)
`;
        
        const tempFileName = `/tmp/insertafter_${Date.now()}.py`;
        const scriptB64 = Buffer.from(pythonScript).toString('base64');
        
        return `echo '${scriptB64}' | base64 -d > ${tempFileName} && python3 ${tempFileName} && rm -f ${tempFileName}`;
    },
    
    // 搜索指定行内容 - 简化版，避免复杂转义
    searchLines: (pattern, filePath = '.', lineNumbers = 'false') => {
        // 验证输入
        if (!/^[a-zA-Z0-9._\-\/\s]+$/.test(filePath)) {
            return `echo "错误: 路径包含非法字符"`;
        }
        
        const showLineNumbers = lineNumbers === 'true' || lineNumbers === true;
        const grepCmd = showLineNumbers ? 'grep -n' : 'grep';
        
        // 使用printf避免echo的转义问题
        const patternB64 = Buffer.from(pattern).toString('base64');
        return `echo '${patternB64}' | base64 -d | xargs -I {} ${grepCmd} -r '{}' "${filePath}" 2>/dev/null || echo "未找到匹配内容"`;
    },
    
    // 查看文件指定行
    showLines: (filePath, startLine, endLine = null) => {
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(filePath)) {
            return `echo "错误: 文件路径包含非法字符"`;
        }
        
        const start = parseInt(startLine) || 1;
        if (endLine && endLine !== 'null') {
            const end = parseInt(endLine) || start;
            return `sed -n '${start},${end}p' "${filePath}" 2>/dev/null || echo "无法读取文件或行号超出范围"`;
        } else {
            return `sed -n '${start}p' "${filePath}" 2>/dev/null || echo "无法读取文件或行号超出范围"`;
        }
    },
    
    // 创建文件 - 使用Base64避免内容转义问题
    createFile: (fileName, content = '') => {
        if (!fileName || fileName.includes('*') || fileName.includes('..')) {
            return `echo "错误: 文件名不能为空或包含危险字符"`;
        }
        
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(fileName)) {
            return `echo "错误: 文件名包含非法字符"`;
        }
        
        const fileNameB64 = Buffer.from(fileName).toString('base64');
        const contentB64 = Buffer.from(content).toString('base64');
        
        const pythonScript = `
import sys
import os
import base64

try:
    filename = base64.b64decode('${fileNameB64}').decode('utf-8')
    content = base64.b64decode('${contentB64}').decode('utf-8')
    
    # 检查文件是否已存在
    if os.path.exists(filename):
        print(f"警告: 文件 {filename} 已存在，将被覆盖")
    
    # 创建目录(如果需要)
    dirname = os.path.dirname(filename)
    if dirname and not os.path.exists(dirname):
        os.makedirs(dirname)
    
    # 写入文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"成功创建文件: {filename}")
    print(f"文件大小: {len(content)} 字符")
    
except Exception as e:
    print(f"创建文件失败: {e}")
    sys.exit(1)
`;
        
        const tempFileName = `/tmp/createfile_${Date.now()}.py`;
        const scriptB64 = Buffer.from(pythonScript).toString('base64');
        
        return `echo '${scriptB64}' | base64 -d > ${tempFileName} && python3 ${tempFileName} && rm -f ${tempFileName}`;
    },
    
    // 创建HTML模板 - 修复模板字符串转义
    createHtmlTemplate: (fileName, title = 'New Page') => {
        if (!fileName || !fileName.endsWith('.html')) {
            return `echo "错误: 必须指定.html文件名"`;
        }
        
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(fileName)) {
            return `echo "错误: 文件名包含非法字符"`;
        }
        
        const fileNameB64 = Buffer.from(fileName).toString('base64');
        const titleB64 = Buffer.from(title).toString('base64');
        
        const pythonScript = `
import sys
import os
import base64

try:
    filename = base64.b64decode('${fileNameB64}').decode('utf-8')
    title = base64.b64decode('${titleB64}').decode('utf-8')
    
    template = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>{title}</h1>
    </header>
    <main>
        <p>页面内容...</p>
    </main>
    <script src="script.js"></script>
</body>
</html>"""
    
    # 检查文件是否已存在
    if os.path.exists(filename):
        print(f"警告: 文件 {filename} 已存在，将被覆盖")
    
    # 写入文件
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(template)
    
    print(f"成功创建HTML模板: {filename}")
    print(f"页面标题: {title}")
    
except Exception as e:
    print(f"创建HTML模板失败: {e}")
    sys.exit(1)
`;
        
        const tempFileName = `/tmp/createhtml_${Date.now()}.py`;
        const scriptB64 = Buffer.from(pythonScript).toString('base64');
        
        return `echo '${scriptB64}' | base64 -d > ${tempFileName} && python3 ${tempFileName} && rm -f ${tempFileName}`;
    },
    
    // 简单的命令，直接执行，减少转义
    countLines: (filePath) => {
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(filePath)) {
            return `echo "错误: 文件路径包含非法字符"`;
        }
        return `wc -l "${filePath}" 2>/dev/null || echo "无法读取文件: ${filePath}"`;
    },
    
    diskUsage: (directory = '.') => {
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(directory)) {
            return `echo "错误: 目录路径包含非法字符"`;
        }
        return `du -sh "${directory}"/* 2>/dev/null | sort -hr | head -20`;
    },
    
    systemInfo: () => {
        // 静态命令，无需参数验证
        return `echo "=== 系统信息 ===" && uname -a && echo "" && echo "=== 内存使用 ===" && free -h && echo "" && echo "=== 磁盘使用 ===" && df -h && echo "" && echo "=== 负载情况 ===" && uptime && echo "" && echo "=== 当前用户 ===" && whoami`;
    },
    
    // npm相关命令 - 参数验证
    npmInstall: (packages, isDev = false) => {
        if (!packages) {
            return `echo "错误: 必须指定要安装的包名"`;
        }
        
        // 验证包名（允许@scope/package格式）
        if (!/^[@a-zA-Z0-9\-\/\s]+$/.test(packages)) {
            return `echo "错误: 包名包含非法字符"`;
        }
        
        const devFlag = isDev === true || isDev === 'true' ? '--save-dev' : '';
        return `npm install ${devFlag} ${packages} && echo "已安装包: ${packages}"`;
    },
    
    // Git命令 - 使用Base64处理commit message
    gitCommit: (message = 'Initial commit') => {
        const messageB64 = Buffer.from(message).toString('base64');
        return `git add . && echo '${messageB64}' | base64 -d | xargs -I {} git commit -m '{}' && echo "已提交: ${message}"`;
    },
    
    // 版本控制 - 列出快照
    listSnapshots: (filePath) => {
        if (!filePath) {
            return `echo "错误: 必须指定文件路径"`;
        }
        
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(filePath)) {
            return `echo "错误: 文件路径包含非法字符"`;
        }
        
        const filePathB64 = Buffer.from(filePath).toString('base64');
        
        const pythonScript = `
import os
import glob
import base64
from datetime import datetime

try:
    filename = base64.b64decode('${filePathB64}').decode('utf-8')
    base_name = os.path.basename(filename).replace('.', '_')
    dir_name = os.path.dirname(filename) or '.'
    vc_dir = os.path.join(dir_name, '.vc')
    
    if not os.path.exists(vc_dir):
        print(f"📁 文件 {filename} 没有版本控制记录")
        exit(0)
    
    # 查找快照文件
    pattern = os.path.join(vc_dir, f"{base_name}_*.snapshot")
    snapshots = glob.glob(pattern)
    
    if not snapshots:
        print(f"📁 文件 {filename} 没有快照记录")
        exit(0)
    
    print(f"=== 📸 {filename} 的快照历史 ===")
    snapshots.sort(reverse=True)  # 最新的在前
    
    for i, snapshot_path in enumerate(snapshots):
        snapshot_name = os.path.basename(snapshot_path)
        # 提取快照ID
        snapshot_id = snapshot_name.replace(f"{base_name}_", "").replace(".snapshot", "")
        
        # 获取文件信息
        stat = os.stat(snapshot_path)
        size = stat.st_size
        mtime = datetime.fromtimestamp(stat.st_mtime)
        
        print(f"{i+1}. 🕐 {snapshot_id}")
        print(f"   📅 时间: {mtime.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"   📏 大小: {size} 字节")
        print("")
    
    print("💡 使用 restoreFile(文件路径, 快照ID) 来恢复文件")
    
except Exception as e:
    print(f"❌ 列出快照失败: {e}")
`;
        
        const tempFileName = `/tmp/listsnapshots_${Date.now()}.py`;
        const scriptB64 = Buffer.from(pythonScript).toString('base64');
        
        return `echo '${scriptB64}' | base64 -d > ${tempFileName} && python3 ${tempFileName} && rm -f ${tempFileName}`;
    },
    
    // 其他函数保持类似的修复模式...
    checkPort: (port) => {
        if (!port || !/^\d+$/.test(port)) {
            return `echo "错误: 必须指定有效的端口号"`;
        }
        const portNum = parseInt(port);
        if (portNum < 1 || portNum > 65535) {
            return `echo "错误: 端口号必须在1-65535之间"`;
        }
        return `lsof -i :${port} 2>/dev/null || netstat -tulpn 2>/dev/null | grep :${port} || echo "端口 ${port} 未被占用"`;
    }
};

// 内置函数参数解码：处理引号与转义
function unescapeQuotedArg(arg) {
    if (!arg || arg.length < 2) return arg;
    const q = arg[0];
    if ((q !== '"' && q !== "'") || arg[arg.length - 1] !== q) return arg;
    let out = '';
    let esc = false;
    for (let i = 1; i < arg.length - 1; i++) {
        const ch = arg[i];
        if (esc) {
            switch (ch) {
                case 'n': out += '\\n'; break;
                case 'r': out += '\\r'; break;
                case 't': out += '\\t'; break;
                case '\\': out += '\\'; break;
                case '"': out += '"'; break;
                case "'": out += "'"; break;
                default: out += ch; break;
            }
            esc = false;
        } else if (ch === '\\') {
            esc = true;
        } else {
            out += ch;
        }
    }
    return out;
}

// 改进的函数解析器
function parseBuiltinFunction(command) {
    // 使用更安全的正则表达式
    const functionMatch = command.match(/^(\w+)\s*\(/);
    if (!functionMatch) {
        return null;
    }
    
    const functionName = functionMatch[1];
    
    // 使用简单的状态机解析参数
    const parseArgs = (argsString) => {
        const args = [];
        let currentArg = '';
        let inQuotes = false;
        let quoteChar = '';
        let escapeNext = false;
        
        for (let i = 0; i < argsString.length; i++) {
            const char = argsString[i];
            
            if (escapeNext) {
                currentArg += char;
                escapeNext = false;
                continue;
            }
            
            if (char === '\\') {
                escapeNext = true;
                continue;
            }
            
            if (!inQuotes && (char === '"' || char === "'")) {
                inQuotes = true;
                quoteChar = char;
                continue;
            }
            
            if (inQuotes && char === quoteChar) {
                inQuotes = false;
                quoteChar = '';
                continue;
            }
            
            if (!inQuotes && char === ',') {
                args.push(currentArg.trim());
                currentArg = '';
                continue;
            }
            
            currentArg += char;
        }
        
        if (currentArg.trim()) {
            args.push(currentArg.trim());
        }
        
        return args;
    };
    
    // 提取参数部分
    const startIdx = command.indexOf('(') + 1;
    let endIdx = -1;
    let depth = 1;
    
    for (let i = startIdx; i < command.length; i++) {
        if (command[i] === '(') depth++;
        if (command[i] === ')') {
            depth--;
            if (depth === 0) {
                endIdx = i;
                break;
            }
        }
    }
    
    if (endIdx === -1) {
        console.warn('函数调用格式错误');
        return null;
    }
    
    const argsString = command.substring(startIdx, endIdx);
    let args = parseArgs(argsString);
    // 对包裹在引号内的参数，进行转义还原
    args = args.map(a => {
        const s = (a || '').trim();
        if (!s) return s;
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            return unescapeQuotedArg(s);
        }
        return s;
    });
    
    if (builtinBashFunctions[functionName]) {
        console.log(`执行内置函数: ${functionName}，参数数量: ${args.length}`);
        return builtinBashFunctions[functionName](...args);
    }
    
    return null;
}



// 无SSH连接的AI对话处理
ipcMain.handle('ai-chat-without-term', async (event, input, isStreaming = false, tabId) => {
    try {
        const connectionInfo = getWindowConnectionInfo(event, tabId);
        const config = getAiConfig(connectionInfo);
        if (!config.apiKey) {
            return {
                success: false,
                error: '请先设置AI API密钥。点击"连接SSH"按钮进行配置。'
            };
        }

        console.log(`AI chat without SSH: streaming=${isStreaming}, inputLength=${String(input || '').length}`);

        const currentWindow = getWindow(event);

        // 使用窗口特定的对话历史
	    const conversationHistory = connectionInfo.aiConversationHistory;

        // 普通AI对话不需要压缩上下文和内置bash函数功能

        const messages = [
            { role: "system", content: getGeneralChatContext(config) },
            ...conversationHistory.slice(-10), // 保留最近10条对话
            { role: "user", content: input }
        ];

        let response;
        if (isStreaming) {
            // 流式处理
            response = await callOpenAI(messages, null, true, (content, isComplete) => {
                // 发送流式更新到对应窗口
                if (currentWindow) {
                    let streamContent = content;
                    // 如果流式完成且启用了完整对话显示，添加对话记录
                    if (isComplete && config.showFullConversation) {
                        streamContent = formatConversationHistory(conversationHistory, input, content, config);
                    }
                    sendTabEvent(currentWindow, connectionInfo, 'ai-stream-update', {
                        content: streamContent,
                        isComplete: isComplete,
                        command: input
                    });
                }
            }, 0, connectionInfo, config);
        } else {
            response = await callOpenAI(messages, null, false, null, 0, connectionInfo, config);
        }

        // 更新对话历史
	    const historyToUpdate = connectionInfo.aiConversationHistory;
        
        // 格式化完整对话记录（如果用户启用了此功能）
        const formattedResponse = formatConversationHistory(historyToUpdate, input, response, config);
        
	    connectionInfo.aiConversationHistory.push(
	        { role: "user", content: input },
	        { role: "assistant", content: response }
	    );

        return {
            success: true,
            isAiResult: true,
            response: formattedResponse,
            command: input,
            isStreaming: isStreaming
        };
    } catch (error) {
        console.error('AI chat without SSH error:', error);
        return {
            success: false,
            error: `AI对话失败: ${error.message}`
        };
    }
});

// Handler for special commands from the footer input
ipcMain.handle('ssh-execute-special', async (event, command, args, tabId) => {
    try {
        // AI命令不需要SSH连接
        const aiCommands = ['ai', 'ask', 'fix', 'analyze', 'cmd', 'test'];
        const sshRequiredCommands = ['rfe', 'myls'];

        const connectionInfo = getWindowConnectionInfo(event, tabId);

        if (sshRequiredCommands.includes(command) && (!connectionInfo || !connectionInfo.sshConnection)) {
            return { success: false, error: 'SSH connection required for this command' };
        }

        // 对于AI命令，获取当前路径（如果有SSH连接）
        let pathArg = null;
        if (connectionInfo && connectionInfo.sshConnection) {
            pathArg = args[0] || await getCurrentPath(connectionInfo.sshConnection, connectionInfo);
        }

        switch (command) {
            case 'rfe':
                return await handleRfe(pathArg, connectionInfo);
            case 'myls':
                return await handleMyls(pathArg, connectionInfo);
            case 'ai':
            case 'ask':
                // 检查是否启用流式回复（通过参数或配置）
                const isStreaming = args.includes('--stream') || args.includes('-s');
                const userInput = args.filter(arg => arg !== '--stream' && arg !== '-s').join(' ');
                return await handleAiCommand(userInput, isStreaming, connectionInfo);
            case 'fix':
                return await handleAiFixCommand(args.join(' '), false, connectionInfo);
            case 'analyze':
                return await handleAiAnalyzeCommand(args.join(' '), false, connectionInfo);
            case 'cmd':
                return await handleNaturalLanguageCommand(args.join(' '), false, connectionInfo);
            case 'test':
                return await handleAiTestCommand(connectionInfo);
            default:
                // 对于非特殊命令，如果启用了AI，则作为普通AI对话处理
                if (getAiConfig(connectionInfo).apiKey) {
                    const fullInput = [command, ...args].join(' ');
                    return await handleGeneralAiChat(fullInput,true, connectionInfo);
                } else {
                    return { success: false, error: `Unknown command: ${command}. AI chat disabled (no API key).` };
                }
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Handler for 'myls' - provides colored, ls-like text view
async function handleMyls(remotePath, connectionInfo) {
    return new Promise((resolve) => {
        const safePath = escapePath(remotePath);
        const cmdGetOutput = `ls -la --full-time --color=always ${safePath}`;
        const cmdGetFileList = `ls -p ${safePath}`;
        const command = `${cmdGetOutput} && echo "---SPLIT---" && ${cmdGetFileList}`;

        connectionInfo.sshConnection.exec(command, (err, stream) => {
            if (err) return resolve({ success: false, error: err.message });
            let output = '';
            let errorOutput = '';
            stream.on('data', (data) => output += data.toString('utf8'));
            stream.stderr.on('data', (data) => errorOutput += data.toString('utf8'));
            stream.on('close', () => {
                if (errorOutput) return resolve({ success: false, error: errorOutput });
                const parts = output.split('---SPLIT---');
                if (parts.length < 2) return resolve({ success: false, error: 'Failed to parse command output.' });

                const rawOutput = parts[0].trim();
                const fileList = parts[1].trim().split('\n').filter(f => f && !f.endsWith('/'));

                resolve({ success: true, isMylsResult: true, rawOutput, fileList, path: remotePath });
            });
        });
    });
}

// Handler for 'rfe' - provides graphical file explorer view
async function handleRfe(remotePath, connectionInfo) {
    return new Promise((resolve) => {
        const safePath = escapePath(remotePath);
        const command = `cd ${safePath} && ls -la --full-time && echo "---FILE-TYPES---" && file -bL --mime-type * 2>/dev/null`;
        connectionInfo.sshConnection.exec(command, (err, stream) => {
            if (err) return resolve({ success: false, error: err.message });
            let output = '';
            let errorOutput = '';
            stream.on('data', (data) => output += data.toString('utf8'));
            stream.stderr.on('data', (data) => errorOutput += data.toString('utf8'));
            stream.on('close', () => {
                if (errorOutput && !output.includes('---FILE-TYPES---')) return resolve({ success: false, error: errorOutput });
                const [lsOutput, typesOutput] = output.split('---FILE-TYPES---');
                if (!lsOutput) return resolve({ success: false, error: 'Failed to execute ls command.' });

                const mimeTypes = {};
                if (typesOutput) {
                    typesOutput.trim().split('\n').forEach(line => {
                        const parts = line.split(':', 2);
                        if (parts.length >= 2) mimeTypes[parts[0].trim()] = parts[1].trim().split(';')[0];
                    });
                }
                const files = lsOutput.trim().split('\n').slice(1).map(line => {
                    const parts = line.split(/\s+/);
                    if (parts.length < 9) return null;
                    const name = parts.slice(8).join(' ');
                    return {
                        name,
                        isDirectory: parts[0].startsWith('d'),
                        isImage: (mimeTypes[name] || '').startsWith('image/')
                    };
                }).filter(f => f && f.name !== '.' && f.name !== '..');

                resolve({ success: true, isRfeResult: true, files: files, path: remotePath });
            });
        });
    });
}

// AI功能相关函数 - 带重试机制
async function callOpenAI(messages, maxTokens = null, isStreaming = false, streamCallback = null, retryCount = 0, owner = null, configOverride = null) {
    if (owner && !ownsTabConnection(getWindowForConnectionInfo(owner), owner)) throw new Error('标签已关闭');
    const run = owner?.takeoverRun, localBinding = owner?.localTakeoverBinding, ssh = owner?.sshConnection, stream = owner?.sshStream;
    const requestValid = () => !owner || (ownsTabConnection(getWindowForConnectionInfo(owner), owner) && owner.takeoverRun === run && owner.localTakeoverBinding === localBinding && owner.sshConnection === ssh && owner.sshStream === stream && (!localBinding || localBinding.valid()));
    const update = (content, done) => { if (requestValid()) streamCallback?.(content, done); };
    const config = { ...validateAiConfig(configOverride || getAiConfig(owner)) };
    const instructions = owner ? getPluginManager().prompt(owner.pluginIds) + '\n' + await getPluginRuntime().prompt(owner, { mode: owner.aiTakeoverMode ? 'takeover' : 'terminal', target: owner.aiTakeoverTarget === 'local' ? 'local' : 'remote' }) : '';
    if (owner && !ownsTabConnection(getWindowForConnectionInfo(owner), owner)) throw new Error('标签已关闭');
    const prepared = messages.map((message, index) => index === 0 && message.role === 'system' && instructions
        ? { ...message, content: message.content + instructions } : { ...message });
    if (instructions && prepared[0]?.role !== 'system') prepared.unshift({ role: 'system', content: instructions });
    if (owner?.pluginModel && owner.pluginIds.has(owner.pluginModel.pluginId)) {
        const result = await getPluginRuntime().invoke(owner, owner.pluginModel.pluginId, 'model', owner.pluginModel.id, { messages: prepared, maxTokens: maxTokens || config.maxTokens, streaming: isStreaming }, { hidden: true, onOutput: text => update(text, false) });
        if (!requestValid()) throw new Error('模型请求期间终端或接管任务已变化');
        if (typeof result !== 'string') throw new Error('模型插件必须返回文本');
        if (isStreaming) update(result, true);
        return result;
    }
    const toolOptions = await pluginModelTools(owner);
    if (owner && !ownsTabConnection(getWindowForConnectionInfo(owner), owner)) throw new Error('标签已关闭');
    if (!requestValid()) throw new Error('模型请求期间终端或接管任务已变化');
    const response = await requestChat({ config, messages: prepared, maxTokens, streaming: isStreaming, onUpdate: update, owner, retries: Math.max(0, 2 - retryCount), ...toolOptions });
    if (!requestValid()) throw new Error('模型请求期间终端或接管任务已变化');
    return response;
}

async function getSystemContext(connectionInfo = null) {
    const config = getAiConfig(connectionInfo);
    const context = await refreshTerminalContext(connectionInfo);
    const currentDir = context.cwd;
    const terminalOutput = context.output.slice(-500);

    let basePrompt = `你是一个系统管理助手。当前环境信息：
- 当前目录: ${currentDir}
- 最近终端输出: ${terminalOutput}
- 操作系统与 Shell: ${context.system}

请提供准确、实用的建议和命令。如果用户询问如何执行某个操作，请提供具体的shell命令。

🔧 可用的内置bash函数（可以在回复中使用）：
- findAndReplace(搜索词, 替换词, 路径) - 查找和替换文件内容
- searchLines(模式, 路径, 显示行号) - 搜索指定内容
- showLines(文件路径, 起始行, 结束行) - 显示文件指定行
- countLines(文件路径) - 统计文件行数
- findLargeFiles(目录, 大小MB) - 查找大文件
- findRecentFiles(目录, 天数) - 查找最近修改的文件
- diskUsage(目录) - 磁盘使用情况
- processMonitor(进程名) - 进程监控
- networkConnections(端口) - 网络连接监控
- systemInfo() - 系统信息快速查看

使用方法：直接在回复中写函数调用，如 systemInfo() 或 findAndReplace("old", "new", "/path")

💡 上下文管理：
- 用户可以输入"压缩上下文"来手动压缩对话历史
- 当上下文超过100k字符时会自动压缩
- 压缩后会保留关键信息和分析结果`;

    // 如果有用户自定义要求，附加到prompt后面
    if (config.customRequirements) {
        basePrompt += `\n\n用户特殊要求: ${config.customRequirements}`;
    }

    return basePrompt;
}

function visibleTerminalContext(connectionInfo) {
    if (connectionInfo?.sshStream) return { cwd: connectionInfo.currentWorkingDirectory || '/', output: connectionInfo.lastTerminalOutput || '', system: '远程 SSH 终端（Unix Shell；具体系统请通过终端确认）' };
    const session = getLocalTerminalMap(connectionInfo)?.get(connectionInfo?.tabId);
    return { cwd: session?.cwd || '~', output: connectionInfo?.lastLocalOutput || '',
        system: session?.environment ? `${session.environment.platform} / ${session.environment.label} / ${session.environment.shellFile || '启动中'}` : '当前没有活动终端' };
}

async function refreshTerminalContext(connectionInfo) {
    if (connectionInfo && !connectionInfo.sshStream) {
        const session = getLocalTerminalMap(connectionInfo)?.get(connectionInfo.tabId);
        if (session?.active) {
            const valid = () => ownsTabConnection(getWindowForConnectionInfo(connectionInfo), connectionInfo) && !connectionInfo.sshStream && getLocalTerminalMap(connectionInfo)?.get(connectionInfo.tabId) === session && session.active;
            await terminalDirectory(session, null, valid);
        }
    }
    return visibleTerminalContext(connectionInfo);
}

function getGeneralChatContext(config = aiConfig) {
    let basePrompt = `你是一个友好的AI助手。你可以：
- 回答各种问题
- 提供技术帮助
- 进行日常对话
- 协助解决问题

请用友好、自然的语气回复用户。如果涉及技术问题，可以提供详细的解释和建议。`;

    // 如果有用户自定义要求，附加到prompt后面
    if (config.customRequirements) {
        basePrompt += `\n\n用户特殊要求: ${config.customRequirements}`;
    }

    return basePrompt;
}

// 格式化完整对话记录
function formatConversationHistory(conversationHistory, currentInput, currentResponse, config = aiConfig) {
    if (!config.showFullConversation || !conversationHistory || conversationHistory.length === 0) {
        return currentResponse;
    }

    let fullConversation = '\n\n--- 完整对话记录 ---\n\n';
    
    // 显示历史对话
    for (let i = 0; i < conversationHistory.length; i += 2) {
        const userMsg = conversationHistory[i];
        const aiMsg = conversationHistory[i + 1];
        
        if (userMsg && aiMsg) {
            fullConversation += `**用户**: ${userMsg.content}\n\n`;
            fullConversation += `**AI**: ${aiMsg.content}\n\n`;
            fullConversation += '---\n\n';
        }
    }
    
    // 显示当前对话
    fullConversation += `**用户**: ${currentInput}\n\n`;
    fullConversation += `**AI**: ${currentResponse}\n\n`;
    
    return currentResponse + fullConversation;
}

// 处理一般AI对话命令
async function handleAiCommand(userInput, isStreaming = false, connectionInfo = null) {
    try {
        const config = getAiConfig(connectionInfo);
        if (!config.apiKey) {
            return {
                success: false,
                error: '请先在SSH连接配置中设置AI API密钥。'
            };
        }

	    if (!connectionInfo) throw new Error('缺少标签会话');
	    const conversationHistory = connectionInfo.aiConversationHistory;
        const messages = [
            { role: "system", content: await getSystemContext(connectionInfo) },
            ...conversationHistory.slice(-10),
            { role: "user", content: userInput }
        ];

        const currentWindow = getWindowForConnectionInfo(connectionInfo) || mainWindow;

        const response = await callOpenAI(messages, null, isStreaming, (content, isComplete) => {
            if (isStreaming && currentWindow) {
                sendTabEvent(currentWindow, connectionInfo, 'ai-stream-update', {
                    content: content,
                    isComplete: isComplete,
                    command: userInput
                });
            }
        }, 0, connectionInfo, config);

	    const historyToUpdate = connectionInfo.aiConversationHistory;
        
        // 格式化完整对话记录（如果用户启用了此功能）
        const formattedResponse = formatConversationHistory(historyToUpdate, userInput, response, config);
        
        historyToUpdate.push({ role: "user", content: userInput }, { role: "assistant", content: response });

        return {
            success: true,
            isAiResult: true,
            response: formattedResponse,
            command: userInput,
            isStreaming: isStreaming
        };
    } catch (error) {
        return {
            success: false,
            error: `AI请求失败: ${error.message}`
        };
    }
}

// 处理错误修复命令
async function handleAiFixCommand(userInput, isStreaming = false, connectionInfo = null) {
    try {
        const config = getAiConfig(connectionInfo);
        if (!config.apiKey) {
            return {
                success: false,
                error: '请先在SSH连接配置中设置AI API密钥。'
            };
        }

        const context = await refreshTerminalContext(connectionInfo);
        const currentDir = context.cwd;
        const terminalOutput = context.output.slice(-1000);

        let systemPrompt = `你是一个系统故障诊断专家。当前系统与 Shell: ${context.system}。请分析以下信息并提供修复建议：

当前目录: ${currentDir}
最近终端输出: ${terminalOutput}

用户描述的问题: ${userInput}

请提供：
1. 问题分析
2. 可能的原因
3. 具体的修复步骤和命令
4. 预防措施`;

        // 如果有用户自定义要求，附加到prompt后面
        if (config.customRequirements) {
            systemPrompt += `\n\n用户特殊要求: ${config.customRequirements}`;
        }

        const messages = [ { role: "system", content: systemPrompt } ];
        const currentWindow = getWindowForConnectionInfo(connectionInfo) || mainWindow;

        const response = await callOpenAI(messages, 1500, isStreaming, (content, isComplete) => {
            if (isStreaming && currentWindow) {
                sendTabEvent(currentWindow, connectionInfo, 'ai-stream-update', {
                    content: content,
                    isComplete: isComplete,
                    command: `fix ${userInput}`
                });
            }
        }, 0, connectionInfo, config);

        return {
            success: true,
            isAiResult: true,
            response: response,
            command: `fix ${userInput}`,
            isStreaming: isStreaming
        };
    } catch (error) {
        return {
            success: false,
            error: `AI修复建议失败: ${error.message}`
        };
    }
}

// 处理系统分析命令
async function handleAiAnalyzeCommand(userInput, isStreaming = false, connectionInfo = null) {
    try {
        const config = getAiConfig(connectionInfo);
        if (!config.apiKey) {
            return {
                success: false,
                error: '请先在SSH连接配置中设置AI API密钥。'
            };
        }

        const systemInfo = await getSystemInfo(connectionInfo);
        const context = await refreshTerminalContext(connectionInfo);
        const currentDir = context.cwd;
        const terminalOutput = context.output.slice(-1000);

        let systemPrompt = `你是一个系统分析专家。请分析以下系统信息：

当前目录: ${currentDir}
系统信息: ${systemInfo}
最近终端输出: ${terminalOutput}

分析重点: ${userInput || '整体系统状态'}

请提供详细的分析报告，包括：
1. 系统状态评估
2. 潜在问题识别
3. 性能优化建议
4. 安全检查建议`;

        // 如果有用户自定义要求，附加到prompt后面
        if (config.customRequirements) {
            systemPrompt += `\n\n用户特殊要求: ${config.customRequirements}`;
        }

        const messages = [ { role: "system", content: systemPrompt } ];
        const currentWindow = getWindowForConnectionInfo(connectionInfo) || mainWindow;

        const response = await callOpenAI(messages, 2000, isStreaming, (content, isComplete) => {
            if (isStreaming && currentWindow) {
                sendTabEvent(currentWindow, connectionInfo, 'ai-stream-update', {
                    content: content,
                    isComplete: isComplete,
                    command: `analyze ${userInput}`
                });
            }
        }, 0, connectionInfo, config);

        return {
            success: true,
            isAiResult: true,
            response: response,
            command: `analyze ${userInput}`,
            isStreaming: isStreaming
        };
    } catch (error) {
        return {
            success: false,
            error: `AI系统分析失败: ${error.message}`
        };
    }
}

// 处理自然语言命令转换
async function handleNaturalLanguageCommand(userInput, isStreaming = false, connectionInfo = null) {
    try {
        const config = getAiConfig(connectionInfo);
        if (!config.apiKey) {
            return {
                success: false,
                error: '请先在SSH连接配置中设置AI API密钥。'
            };
        }

        const context = await refreshTerminalContext(connectionInfo);
        const currentDir = context.cwd;

        let systemPrompt = `你是一个命令转换专家。当前系统与 Shell: ${context.system}。用户会用自然语言描述他们想要执行的操作，你需要将其转换为准确的shell命令。

当前目录: ${currentDir}
用户请求: ${userInput}

请提供：
1. 对应的shell命令
2. 命令的简要说明
3. 注意事项（如果有的话）

格式示例：
命令: ls -la
说明: 列出当前目录下的所有文件（包括隐藏文件）的详细信息
注意: 无

只提供最直接、最安全的命令。如果操作有风险，请明确警告。`;

        // 如果有用户自定义要求，附加到prompt后面
        if (config.customRequirements) {
            systemPrompt += `\n\n用户特殊要求: ${config.customRequirements}`;
        }

        const messages = [ { role: "system", content: systemPrompt } ];
        const currentWindow = getWindowForConnectionInfo(connectionInfo) || mainWindow;

        const response = await callOpenAI(messages, 800, isStreaming, (content, isComplete) => {
            if (isStreaming && currentWindow) {
                sendTabEvent(currentWindow, connectionInfo, 'ai-stream-update', {
                    content: content,
                    isComplete: isComplete,
                    command: `cmd ${userInput}`
                });
            }
        }, 0, connectionInfo, config);

        return {
            success: true,
            isAiResult: true,
            response: response,
            command: `cmd ${userInput}`,
            isCommandSuggestion: true,
            isStreaming: isStreaming
        };
    } catch (error) {
        return {
            success: false,
            error: `自然语言命令转换失败: ${error.message}`
        };
    }
}

// 获取系统信息
async function getSystemInfo(connectionInfo = null) {
    if (connectionInfo && !connectionInfo.sshConnection) {
        const binding = capturePluginBinding(connectionInfo);
        if (!binding.valid()) return '当前没有活动终端';
        try {
            const cwd = await binding.resolveCwd();
            return (await executeInEnvironment(binding.environment, 'uname -a; df -h; ps aux | head -10', cwd, { valid: binding.valid, timeoutMs: 10000 })).output;
        } catch (error) { return `获取终端系统信息失败: ${error.message}`; }
    }
    return new Promise((resolve) => {
        if (!connectionInfo || !connectionInfo.sshConnection) {
            return resolve('无SSH连接，无法获取系统信息');
        }

        const commands = [
            'uname -a',
            'df -h',
            'free -h',
            'ps aux | head -10'
        ].join(' && echo "---SPLIT---" && ');

        connectionInfo.sshConnection.exec(commands, (err, stream) => {
            if (err) return resolve('无法获取系统信息');

            let output = '';
            stream.on('data', (data) => output += data.toString());
            stream.on('close', () => resolve(output));
        });
    });
}

// 处理普通AI对话
async function handleGeneralAiChat(userInput, isStreaming = false, connectionInfo=null) {
	try {
	    if (!connectionInfo) throw new Error('缺少标签会话');
	    const config = getAiConfig(connectionInfo);
        if (!config.apiKey) {
            return {
                success: false,
                error: '请先在SSH连接配置中设置AI API密钥。'
            };
        }

        const messages = [
            { role: "system", content: getGeneralChatContext(config) },
	        ...connectionInfo.aiConversationHistory.slice(-10),
            { role: "user", content: userInput }
        ];

        //const currentWindow = mainWindow; // Assume general chat goes to main window
        const currentWindow = getWindowForConnectionInfo(connectionInfo) || mainWindow;

        const response = await callOpenAI(messages, null, isStreaming, (content, isComplete) => {
            if (isStreaming && currentWindow) {
                sendTabEvent(currentWindow, connectionInfo, 'ai-stream-update', {
                    content: content,
                    isComplete: isComplete,
                    command: userInput
                });
            }
        }, 0, connectionInfo, config);

        // 格式化完整对话记录（如果用户启用了此功能）
	    const history = connectionInfo.aiConversationHistory;
        const formattedResponse = formatConversationHistory(history, userInput, response, config);
        
        history.push({ role: "user", content: userInput }, { role: "assistant", content: response });

        return {
            success: true,
            isAiResult: true,
            response: formattedResponse,
            command: userInput,
            isStreaming: isStreaming
        };
    } catch (error) {
        return {
            success: false,
            error: `AI请求失败: ${error.message}`
        };
    }
}

// 处理AI连接测试命令
async function handleAiTestCommand(connectionInfo = null, configOverride = null) {
    try {
        const config = validateAiConfig(configOverride || getAiConfig(connectionInfo));
        if (!config.apiKey) {
            return {
                success: false,
                error: '请先在SSH连接配置中设置AI API密钥。'
            };
        }

        const testMessages = [
            { role: "system", content: "你是一个测试助手。请简短回复确认连接正常。" },
            { role: "user", content: "测试连接" }
        ];

        const response = await callOpenAI(testMessages, 50, false, null, 0, connectionInfo, config);

        return {
            success: true,
            isAiResult: true,
            response: `✅ AI连接测试成功！\n\n模型: ${config.model}\nAPI地址: ${config.baseUrl}\n\nAI回复: ${response}`,
            command: 'test'
        };
    } catch (error) {
        return {
            success: true,
            isAiResult: true,
            response: `❌ AI连接测试失败\n\n错误信息: ${error.message}\n\n请检查:\n1. API密钥是否正确\n2. 网络连接是否正常\n3. API基础URL是否有效\n4. 模型名称是否支持`,
            command: 'test'
        };
    }
}

// Download and open file
ipcMain.handle('ssh-download-and-open', async (event, remotePath, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo || !connectionInfo.sshConnection) {
        return { success: false, error: 'No SSH connection' };
    }

    try {
        const expandedPath = await expandTildePath(remotePath, connectionInfo.sshConnection);
        const filename = path.basename(expandedPath);
        const extension = path.extname(filename).toLowerCase();
        const dangerousExtensions = new Set([
            '.exe', '.msi', '.com', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse',
            '.wsf', '.wsh', '.scr', '.hta', '.reg', '.lnk', '.url', '.desktop', '.app', '.pkg',
            '.dmg', '.sh', '.bash', '.zsh', '.fish', '.py', '.pl', '.rb', '.jar'
        ]);
        if (dangerousExtensions.has(extension)) {
            const currentWindow = getWindow(event);
            const options = {
                type: 'warning',
                title: '确认打开可执行文件',
                message: `远程文件 ${filename} 可能执行本地代码。`,
                detail: '仅在你信任该服务器和文件内容时继续。建议先下载后检查，不要直接打开。',
                buttons: ['取消', '仍然下载并打开'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            };
            const decision = currentWindow
                ? await dialog.showMessageBox(currentWindow, options)
                : await dialog.showMessageBox(options);
            if (decision.response !== 1) return { success: false, error: '用户取消打开危险文件' };
        }
        const localPath = path.join(os.tmpdir(), `AITerminal-${Date.now()}-${filename}`);

        return new Promise((resolve) => {
            connectionInfo.sshConnection.sftp((err, sftp) => {
                if (err) return resolve({ success: false, error: `SFTP Error: ${err.message}` });
                sftp.fastGet(expandedPath, localPath, async (getErr) => {
                    sftp.end();
                    if (getErr) return resolve({ success: false, error: `Download Error: ${getErr.message}` });
                    try {
                        await shell.openPath(localPath);
                        resolve({ success: true, message: `文件已打开: ${filename}` });
                    } catch (openErr) {
                        resolve({ success: false, error: `Failed to open file: ${openErr.message}` });
                    }
                });
            });
        });
    } catch (error) {
        return { success: false, error: `Path expansion error: ${error.message}` };
    }
});

// Download file with save dialog
ipcMain.handle('ssh-download-file', async (event, remotePath, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo || !connectionInfo.sshConnection) {
        return { success: false, error: 'No SSH connection' };
    }

    try {
        const expandedPath = await expandTildePath(remotePath, connectionInfo.sshConnection);
        const filename = path.basename(expandedPath);

        const currentWindow = getWindow(event);
        const options = {
            title: '保存文件',
            defaultPath: filename,
            filters: [
                { name: 'All Files', extensions: ['*'] }
            ]
        };
        const result = currentWindow
            ? await dialog.showSaveDialog(currentWindow, options)
            : await dialog.showSaveDialog(options);

        if (result.canceled) {
            return { success: false, error: '用户取消了保存操作' };
        }

        const localPath = result.filePath;

        return new Promise((resolve) => {
            connectionInfo.sshConnection.sftp((err, sftp) => {
                if (err) return resolve({ success: false, error: `SFTP Error: ${err.message}` });
                sftp.fastGet(expandedPath, localPath, (getErr) => {
                    sftp.end();
                    if (getErr) return resolve({ success: false, error: `Download Error: ${getErr.message}` });
                    resolve({ success: true, message: `文件已保存到: ${localPath}` });
                });
            });
        });
    } catch (error) {
        return { success: false, error: `Path expansion error: ${error.message}` };
    }
});

// Handle drag-and-drop upload - always upload to current terminal directory
ipcMain.handle('ssh-drag-upload', async (event, localPaths, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    if (!connectionInfo || !connectionInfo.sshConnection) {
        return { success: false, message: 'No SSH connection' };
    }
    try {
        const remotePath = await getCurrentPath(connectionInfo.sshConnection, connectionInfo);

        const uploadPromises = localPaths.map(async (localPath) => {
            const filename = path.basename(localPath);
            let remoteFilePath;
            if (remotePath === '~') {
                remoteFilePath = `~/${filename}`;
            } else if (remotePath.startsWith('~/')) {
                remoteFilePath = `${remotePath}/${filename}`;
            } else if (remotePath === '/') {
                remoteFilePath = `/${filename}`;
            } else {
                remoteFilePath = `${remotePath}/${filename}`;
            }
            remoteFilePath = remoteFilePath.replace(/\/\//g, '/');

            const expandedRemotePath = await expandTildePath(remoteFilePath, connectionInfo.sshConnection);

            return new Promise((resolve, reject) => {
                connectionInfo.sshConnection.sftp((err, sftp) => {
                    if (err) return reject(`SFTP Error: ${err.message}`);
                    sftp.fastPut(localPath, expandedRemotePath, (putErr) => {
                        sftp.end();
                        if (putErr) return reject(`Upload failed for ${filename}: ${putErr.message}`);
                        resolve(`已上传 ${filename} 到 ${remotePath}`);
                    });
                });
            });
        });

        const results = await Promise.all(uploadPromises);
        return { success: true, message: results.join('\n') };
    } catch (error) {
        return { success: false, message: error.toString() };
    }
});

// 选择私钥文件
ipcMain.handle('select-private-key-file', async (event) => {
    try {
        const currentWindow = getWindow(event);
        const options = {
            title: '选择SSH私钥文件',
            properties: ['openFile'],
            filters: [
                { name: 'SSH私钥文件', extensions: ['*'] },
                { name: '常见私钥格式', extensions: ['pem', 'key', 'rsa', 'ed25519', 'ecdsa'] },
                { name: '所有文件', extensions: ['*'] }
            ],
            defaultPath: path.join(os.homedir(), '.ssh')
        };
        const result = currentWindow
            ? await dialog.showOpenDialog(currentWindow, options)
            : await dialog.showOpenDialog(options);

        if (result.canceled || !result.filePaths.length) {
            return { success: false, message: '用户取消选择' };
        }

        const filePath = result.filePaths[0];
        
        // 验证文件是否存在且可读
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
            return { success: true, filePath: filePath };
        } catch (error) {
            return { success: false, message: `无法读取文件: ${error.message}` };
        }
    } catch (error) {
        return { success: false, message: `选择文件失败: ${error.message}` };
    }
});

// AI接管模式处理函数
ipcMain.handle('ai-takeover-start', async (event, payload) => {
    const connectionInfo = getWindowConnectionInfo(event, payload?.tabId);
    const currentWindow = getWindow(event);

    if (!connectionInfo) {
        return { success: false, error: '窗口连接信息缺失' };
    }

    let task = '';
    let target = 'remote';
    let localRootDir = null;

    if (typeof payload === 'string') {
        task = payload;
    } else if (payload && typeof payload === 'object') {
        task = String(payload.task || payload.aiTakeoverTask || payload.input || '');
        target = String(payload.target || payload.mode || 'remote');
        localRootDir = payload.localRootDir || null;
    }

    task = (task || '').trim();
    target = (target || 'remote').toLowerCase();
    if (!['remote', 'local', 'hybrid'].includes(target)) target = 'remote';

    if (!task) {
        return { success: false, error: '任务不能为空' };
    }

    if (!getAiConfig(connectionInfo).apiKey) {
        return { success: false, error: '请先配置AI API密钥' };
    }

    // Remote/hybrid requires SSH
    if ((target === 'remote' || target === 'hybrid') && !connectionInfo.sshConnection) {
        return { success: false, error: '需要SSH连接才能启动远程/混合AI接管模式' };
    }

    // Bind the same terminal system and its cwd before asking for consent.
    let localBinding = null;
    const remoteConnection = connectionInfo.sshConnection, remoteStream = connectionInfo.sshStream;
    if (target === 'local' || target === 'hybrid') {
        try {
            localBinding = await bindLocalTakeover(connectionInfo, currentWindow, localRootDir, target === 'hybrid');
            const consent = await dialog.showMessageBox(currentWindow, {
                type: 'warning', title: '启用本地AI接管',
                message: `AI 将在当前终端环境 ${localBinding.environment.label} 中执行命令。`,
                detail: `工作目录: ${localBinding.cwd}\n与当前终端使用相同系统和用户权限。高危命令仍需单独确认。`,
                buttons: ['取消', '继续'], defaultId: 1, cancelId: 0
            });
            if (consent.response !== 1) return { success: false, error: '用户取消启用本地AI接管' };
            if (!localBinding.valid()) throw new Error('确认期间终端已关闭或变化，请重新启动接管');
        } catch (error) { return { success: false, error: error.message }; }
    }
    if (!ownsTabConnection(currentWindow, connectionInfo) || connectionInfo.sshConnection !== remoteConnection || connectionInfo.sshStream !== remoteStream) return { success: false, error: '启动期间终端会话已变化' };
    for (const controller of connectionInfo.localCommandControllers || []) controller.abort();
    connectionInfo.localTakeoverBinding = localBinding;
    const takeoverRun = Symbol('takeover-run');
    connectionInfo.takeoverRun = takeoverRun;
    connectionInfo.localTakeoverInitialDir = localBinding?.cwd || null;
    connectionInfo.localWorkingDirectory = localBinding?.cwd || null;
    connectionInfo.lastLocalOutput = '';

    // 初始化接管模式
    connectionInfo.aiTakeoverMode = true;
    connectionInfo.aiTakeoverTarget = target;
    connectionInfo.aiTakeoverTask = task;
    connectionInfo.aiTakeoverHistory = [];
    // Reset interactive session state (remote/local)
    try { stopLocalInteractiveSession(connectionInfo); } catch {}
    try { clearReplContinueTimers(connectionInfo); } catch {}
    try { clearReplWaiter(connectionInfo); } catch {}
    connectionInfo.replMode = null;
    connectionInfo.replTarget = null;
    connectionInfo.replBuffer = '';
    connectionInfo.contextGraph = createEmptyContextGraph();
    connectionInfo.contextCompressed = false;
    connectionInfo.lastCompressionTime = null;
    buildOrUpdateContextIndex(connectionInfo);

    // Remote initial dir (if available)
    connectionInfo.aiTakeoverInitialDir = connectionInfo.currentWorkingDirectory || '/';
    connectionInfo.aiTakeoverInterrupted = false; // 重置打断标志

    // 发送开始通知
    let startMsg = `🤖 AI接管模式已启动\n目标: ${target}\n任务: ${task}`;
    if (target === 'remote' || target === 'hybrid') {
        startMsg += `\n远程初始目录: ${connectionInfo.aiTakeoverInitialDir}`;
    }
    if (target === 'local' || target === 'hybrid') {
	        startMsg += `\n本地初始工作目录: ${connectionInfo.localTakeoverInitialDir}`;
    }

    currentWindow.webContents.send('ai-takeover-update', {
        type: 'start',
        message: startMsg
    });

    // 开始AI规划和执行
    setTimeout(() => {
        if (connectionInfo.takeoverRun !== takeoverRun || !ownsTabConnection(currentWindow, connectionInfo)) return;
        executeAiTakeoverStep(connectionInfo, currentWindow);
    }, 1000);

    return { success: true, target };
});

ipcMain.handle('ai-takeover-stop', async (event, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    const currentWindow = getWindow(event);
    for (const controller of connectionInfo?.localCommandControllers || []) controller.abort();
    
    if (connectionInfo && connectionInfo.aiTakeoverMode) {
        // 设置打断标志，而不是完全停止
        connectionInfo.aiTakeoverInterrupted = true;
        // 取消当前AI请求（如有）
        try {
            cancelAiRequests(connectionInfo);
            connectionInfo.currentAiReq = null;
        } catch {}
        
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'interrupted',
            message: '⚡ 当前步骤已打断，AI接管模式继续运行。请输入新的指示或说"退出"来结束。'
        });
    } else {
        // 如果不在接管模式，则完全停止
        if (connectionInfo) {
            cancelAiRequests(connectionInfo);
            connectionInfo.aiTakeoverMode = false;
            connectionInfo.aiTakeoverTask = '';
            connectionInfo.aiTakeoverHistory = [];
        }
        
        if (currentWindow) {
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'stop',
                message: '🛑 AI接管模式已停止'
            });
        }
    }
    
    return { success: true };
});

// 处理压缩上下文请求
ipcMain.handle('ai-takeover-compress-context', async (event, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    const currentWindow = getWindow(event);
    
    if (!connectionInfo || !connectionInfo.aiTakeoverMode) {
        return { success: false, error: '当前不在AI接管模式' };
    }
    
    if (!getAiConfig(connectionInfo).apiKey) {
        return { success: false, error: '需要AI API密钥来压缩上下文' };
    }
    
    try {
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'thinking',
            message: '🔄 正在手动压缩上下文...'
        });

        const res = await compressTakeoverContext(connectionInfo);
        connectionInfo.contextCompressed = true;
        connectionInfo.lastCompressionTime = new Date();

        currentWindow.webContents.send('ai-takeover-update', {
            type: 'analysis',
            message: `✅ 上下文手动压缩完成\n压缩时间: ${new Date().toLocaleString()}\n可以继续执行任务或输入新指示。`
        });
        
        return { success: true };
    } catch (error) {
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'error',
            message: `❌ 上下文压缩失败: ${error.message}`
        });
        
        return { success: false, error: error.message };
    }
});

ipcMain.handle('ai-takeover-continue', async (event, userResponse, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    const currentWindow = getWindow(event);
    
    if (!connectionInfo) {
        return { success: false, error: '窗口连接信息缺失' };
    }
    const takeoverTarget = connectionInfo.aiTakeoverTarget || 'remote';
    if ((takeoverTarget === 'remote' || takeoverTarget === 'hybrid') && !connectionInfo.sshConnection) {
        return { success: false, error: '需要SSH连接才能继续远程/混合AI接管模式' };
    }
    if ((takeoverTarget === 'local' || takeoverTarget === 'hybrid') && !connectionInfo.localTakeoverBinding?.valid()) {
	    return { success: false, error: '本地终端已关闭或变化，请重新打开本地终端并启动接管' };
    }
    
    if (!getAiConfig(connectionInfo).apiKey) {
        return { success: false, error: '请先配置AI API密钥' };
    }
    
    // 检查特殊命令
    if (userResponse.trim() === '退出') {
        // Stop any local interactive session to avoid orphan processes.
        try { stopLocalInteractiveSession(connectionInfo); } catch {}
        try { clearReplContinueTimers(connectionInfo); } catch {}
        try { clearReplWaiter(connectionInfo); } catch {}
        connectionInfo.replMode = null;
        connectionInfo.replTarget = null;
        connectionInfo.replBuffer = '';
        // 退出AI接管模式
        connectionInfo.aiTakeoverMode = false;
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'complete',
            message: '👋 用户主动退出AI接管模式'
        });
        return { success: true };
    }
    
    // 检查测试命令格式：测试：命令
    if (userResponse.includes('测试：') || userResponse.includes('test:')) {
        const raw = userResponse.trim();
        let execTarget = (connectionInfo.aiTakeoverTarget || 'remote').toLowerCase();
        // In hybrid, default to remote unless user explicitly asks for local.
        if (execTarget === 'hybrid') execTarget = 'remote';

        const localPrefix = /^(本地测试[:：]|local\s*test[:：]|localtest[:：])/i;
        const remotePrefix = /^(远程测试[:：]|remote\s*test[:：]|remotetest[:：])/i;

        let testCommand = raw;
        if (localPrefix.test(raw)) {
            execTarget = 'local';
            testCommand = raw.replace(localPrefix, '').trim();
        } else if (remotePrefix.test(raw)) {
            execTarget = 'remote';
            testCommand = raw.replace(remotePrefix, '').trim();
        } else {
            // Backward compatible: 默认“测试:”在当前接管目标下执行（remote/local）
            if (execTarget !== 'local') execTarget = 'remote';
            testCommand = raw.replace(/^(测试[:：]|test[:：])\s*/i, '').trim();
        }

        if (testCommand.trim()) {
            try {
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'executing',
                    message: `🧪 执行${execTarget === 'local' ? '本地' : '远程'}测试命令: ${testCommand}`
                });
                
                // 执行测试命令
                let result = '';
                if (execTarget === 'local') {
                    const r = await executeLocalShellCommand(connectionInfo, testCommand);
                    result = r.output;
                    connectionInfo.lastLocalOutput = r.output;
                } else {
                    result = await executeSSHCommand(connectionInfo, testCommand);
                    connectionInfo.lastTerminalOutput = result;
                }
                
                // 记录测试命令
                const recordCwd = execTarget === 'local'
                    ? (connectionInfo.localWorkingDirectory || connectionInfo.localTakeoverInitialDir || '')
                    : (connectionInfo.currentWorkingDirectory || '');
                changeTracker.recordCommand(`[测试:${execTarget}] ${testCommand}`, recordCwd, result);
                
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'waiting',
                    message: `📋 测试结果:\n${result}\n\n💡 测试完成，请继续输入指示或输入"退出"结束。`
                });
                
                // 测试完成后保持等待用户输入状态，不交回AI控制
                return { success: true, keepWaiting: true };
            } catch (error) {
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'waiting',
                    message: `❌ 测试命令执行失败: ${error.message}\n\n💡 请继续输入指示或输入"退出"结束。`
                });
                return { success: true, keepWaiting: true };
            }
        }
    }
    
    // 检查是否要退出
    if (userResponse.trim() === '退出' || 
        userResponse.trim() === '结束') {
        connectionInfo.aiTakeoverMode = false;
        connectionInfo.aiTakeoverTask = '';
        connectionInfo.aiTakeoverHistory = [];
        connectionInfo.aiTakeoverInterrupted = false;
        
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'stop',
            message: '🛑 AI接管模式已停止'
        });
        return { success: true };
    }
    
    // 重新启动接管模式，并将用户回复添加到历史中
    connectionInfo.aiTakeoverMode = true;
    
    // 添加打断说明，告诉AI之前的操作被用户打断了
    connectionInfo.aiTakeoverHistory.push(
        { role: "user", content: `${userResponse}` }
    );
    buildOrUpdateContextIndex(connectionInfo);
    
    // 发送继续通知
    currentWindow.webContents.send('ai-takeover-update', {
        type: 'start',
        message: `🤖 AI接管模式继续执行\n用户回复: ${userResponse}`
    });
    
    // 继续AI规划和执行
    setTimeout(() => {
        executeAiTakeoverStep(connectionInfo, currentWindow);
    }, 1000);
    
    return { success: true };
});

ipcMain.handle('ai-takeover-resume', async (event, newInstruction, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    const currentWindow = getWindow(event);
    
    if (!connectionInfo) {
        return { success: false, error: '窗口连接信息缺失' };
    }
    const takeoverTarget = connectionInfo.aiTakeoverTarget || 'remote';
    if ((takeoverTarget === 'remote' || takeoverTarget === 'hybrid') && !connectionInfo.sshConnection) {
        return { success: false, error: '需要SSH连接才能继续远程/混合AI接管模式' };
    }
    if ((takeoverTarget === 'local' || takeoverTarget === 'hybrid') && !connectionInfo.localTakeoverBinding?.valid()) {
	    return { success: false, error: '本地终端已关闭或变化，请重新打开本地终端并启动接管' };
    }
    
    if (!getAiConfig(connectionInfo).apiKey) {
        return { success: false, error: '请先配置AI API密钥' };
    }
    
    // 重新启动接管模式，并将新指示添加到历史中
    connectionInfo.aiTakeoverMode = true;
    connectionInfo.aiTakeoverInterrupted = false;
    
    // 如果用户说要退出，则完全停止
    if (newInstruction.trim() === '退出' || 
        newInstruction.trim() === '结束') {
        connectionInfo.aiTakeoverMode = false;
        connectionInfo.aiTakeoverTask = '';
        connectionInfo.aiTakeoverHistory = [];
        connectionInfo.aiTakeoverInterrupted = false;
        
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'stop',
            message: '🛑 AI接管模式已停止'
        });
        return { success: true };
    }
    
    // 添加新指示到历史
    connectionInfo.aiTakeoverHistory.push(
        { role: "assistant", content: `分析：...` },
        { role: "user", content: `我已打断你的操作，这是我的新指示: ${newInstruction}` }
    );
    buildOrUpdateContextIndex(connectionInfo);
    
    // 发送继续通知
    currentWindow.webContents.send('ai-takeover-update', {
        type: 'start',
        message: `🔄 AI接管模式继续执行\n新指示: ${newInstruction}`
    });
    
    // 继续AI规划和执行
    setTimeout(() => {
        executeAiTakeoverStep(connectionInfo, currentWindow);
    }, 1000);
    
    return { success: true };
});

// 手动重试当前接管步骤
ipcMain.handle('ai-takeover-retry', async (event, tabId) => {
    const connectionInfo = getWindowConnectionInfo(event, tabId);
    const currentWindow = getWindow(event);
    if (!connectionInfo) {
        return { success: false, error: '窗口连接信息缺失' };
    }
    const takeoverTarget = connectionInfo.aiTakeoverTarget || 'remote';
    if ((takeoverTarget === 'remote' || takeoverTarget === 'hybrid') && !connectionInfo.sshConnection) {
        return { success: false, error: '需要SSH连接才能重试远程/混合接管' };
    }
    if ((takeoverTarget === 'local' || takeoverTarget === 'hybrid') && !connectionInfo.localTakeoverBinding?.valid()) {
	    return { success: false, error: '本地终端已关闭或变化，请重新打开本地终端并启动接管' };
    }
    connectionInfo.aiTakeoverMode = true;
    connectionInfo.aiTakeoverInterrupted = false;
    // 清理上一次请求
    try {
        cancelAiRequests(connectionInfo);
        connectionInfo.currentAiReq = null;
    } catch {}
    try {
        currentWindow.webContents.send('ai-takeover-update', { type: 'thinking', message: '🔁 正在重试上一步...' });
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 200);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// AI接管模式核心执行函数
async function executeAiTakeoverStep(connectionInfo, currentWindow, retryCount = 0) {
    if (tabExecutionContext.getStore() !== connectionInfo) {
        return tabExecutionContext.run(
            connectionInfo,
            () => executeAiTakeoverStep(connectionInfo, currentWindow, retryCount)
        );
    }
    // Fallback: derive window if not provided
    if (!currentWindow) {
        try {
            const derivedId = getWindowIdForConnectionInfo(connectionInfo);
            if (derivedId) {
                currentWindow = windows.get(derivedId);
            }
        } catch {}
    }
    if (!ownsTabConnection(currentWindow, connectionInfo)) return;
    if (!connectionInfo.aiTakeoverMode) {
        return;
    }
    if (['local', 'hybrid'].includes(connectionInfo.aiTakeoverTarget) && !connectionInfo.localTakeoverBinding?.valid()) {
        connectionInfo.aiTakeoverMode = false;
        sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'error', message: '本地终端已关闭或变化，请重新启动接管。' });
        return;
    }
    // 同步上下文索引
    buildOrUpdateContextIndex(connectionInfo);
    
    // 检查是否被打断
    if (connectionInfo.aiTakeoverInterrupted) {
        connectionInfo.aiTakeoverInterrupted = false;
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'waiting',
            message: '⏸️ AI已停止当前操作，等待您的新指示...'
        });
        return;
    }

    // 检查是否需要自动压缩上下文
    if (shouldCompressTakeoverContext(connectionInfo)) {
        try {
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'thinking',
                message: '🔄 检测到上下文过长，正在自动压缩...'
            });

        const res = await compressTakeoverContext(connectionInfo);
        connectionInfo.contextCompressed = true;
        connectionInfo.lastCompressionTime = new Date();

            currentWindow.webContents.send('ai-takeover-update', {
                type: 'analysis',
                message: `✅ 上下文已自动压缩完成\n压缩时间: ${new Date().toLocaleString()}\n继续执行任务...`
            });
        } catch (error) {
            console.warn('自动压缩上下文失败:', error.message);
        }
    }
    
    const maxRetries = 3;
    
    try {
        // 构建AI提示词
        const systemPrompt = buildTakeoverSystemPrompt(connectionInfo);

        // 选择用于LLM的有效历史（保留最新摘要与最近若干条消息），并清理内容
        const selectedHistory = selectHistoryForLLM(connectionInfo);
        const validHistory = selectedHistory.filter(msg => {
            return msg && 
                   typeof msg === 'object' && 
                   typeof msg.role === 'string' && 
                   typeof msg.content === 'string' &&
                   msg.content.trim().length > 0 &&
                   ['system', 'user', 'assistant'].includes(msg.role);
        }).map(msg => {
            // 清理消息内容，确保格式正确
            let cleanContent = msg.content;
            
            // 如果内容包含转义的换行符，将其转换为真正的换行符
            if (typeof cleanContent === 'string') {
                cleanContent = cleanContent
                    .replace(/\\n/g, '\n')           // 转义的换行符转为真实换行符
                    .replace(/\\t/g, '\t')           // 转义的制表符转为真实制表符
                    .replace(/\\"/g, '"')            // 转义的引号转为真实引号
                    .replace(/\\\\/g, '\\');         // 转义的反斜杠转为真实反斜杠
            }
            
    return {
        role: msg.role,
        content: cleanContent
    };
    });
        // 在系统提示后追加一个精简版的 MCP-Index，供模型参考
        const mcp = buildMcpIndex(connectionInfo);
        const mcpIndexText = JSON.stringify(mcp);

        console.log(`AI接管历史消息验证: 原始${connectionInfo.aiTakeoverHistory.length}条，发送${validHistory.length}条(含摘要)`);
        
        const messages = [
            { role: "system", content: systemPrompt },
            { role: "system", content: `MCP-Index: ${mcpIndexText}` },
            ...validHistory,
        ];
        
        // 发送思考状态
        const thinkingMessage = retryCount > 0 
            ? `🤔 AI正在分析当前状态并规划下一步... (重试 ${retryCount}/${maxRetries})`
            : '🤔 AI正在分析当前状态并规划下一步...';
            
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'thinking',
            message: thinkingMessage
        });
        
        // 调用AI获取下一步行动（使用流式输出）
        const planStart = Date.now();
        let streamedResponse = '';
        const response = await callOpenAI(messages, 1500, true, (content, isComplete) => {
            streamedResponse = content;
            // 发送流式更新，直接显示AI的回复内容
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'streaming',
                message: content,
                isComplete: isComplete
            });
        }, 0, connectionInfo);
        
        // 解析AI响应
        const actionPlan = parseAiResponse(response);
        const planElapsed = Math.round((Date.now() - planStart) / 1000);
        
        // 检测分析中是否包含自动MCP展开指令，如: MCP_EXPAND s12 关键字
        const expandMatch = /MCP_EXPAND\s+([sS]\d+)\s*(.*)$/m.exec(actionPlan.analysis || '');
        if (expandMatch) {
            const sid = expandMatch[1];
            const kw = (expandMatch[2] || '').trim();
            try {
                mcpExpandInject(connectionInfo, sid, kw, currentWindow);
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 自动MCP展开失败: ${e.message}` });
            }
            // 展开后重新进入下一轮规划
            setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow, retryCount), 800);
            return;
        }

        // 发送AI的分析和计划
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'analysis',
            message: `📋 AI分析和计划:\n${actionPlan.analysis}${actionPlan.plan ? `\n\n🗂️ 方案(PLAN):\n${actionPlan.plan}` : ''}\n\n⏱️ 规划用时: ${planElapsed}s${actionPlan.requiresConfirmation ? '\n⚠️ 该任务判定为复杂任务, 需要确认' : ''}`
        });

        // 不再强制拦截“复杂任务”以等待确认。
        // 模型若给出 PLAN，用户可直接在输入框反馈（确认/修改），我们原样传回模型。
        
        if (actionPlan.isComplete) {
            // 任务完成
            connectionInfo.aiTakeoverMode = false;
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'complete',
                message: `✅ 任务完成!\n${actionPlan.summary}`
            });
            return;
        }

        if (actionPlan.needsCompression) {
            // 手动压缩上下文
            try {
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'thinking',
                    message: '🔄 正在压缩上下文...'
                });

                const res = await compressTakeoverContext(connectionInfo);
                connectionInfo.contextCompressed = true;
                connectionInfo.lastCompressionTime = new Date();

                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'analysis',
                    message: `✅ 上下文压缩完成\n压缩时间: ${new Date().toLocaleString()}\n${actionPlan.analysis}`
                });

                // 继续执行下一步
                setTimeout(() => {
                    executeAiTakeoverStep(connectionInfo, currentWindow, retryCount);
                }, 1500);
                return;
            } catch (error) {
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'error',
                    message: `❌ 上下文压缩失败: ${error.message}`
                });
                
                // 继续执行，忽略压缩失败
                setTimeout(() => {
                    executeAiTakeoverStep(connectionInfo, currentWindow, retryCount);
                }, 2000);
                return;
            }
        }
        
        if (actionPlan.needsUserInput) {
            // 检查是否是解析错误
            if (actionPlan.parseError) {
                // 解析失败，要求AI重新回复
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'error',
                    message: `❌ AI响应格式错误，无法解析。\n${actionPlan.analysis}\n\n正在要求AI使用正确的格式重新回复...`
                });
                
                // 添加错误信息到历史，让AI重新回复
                //connectionInfo.aiTakeoverHistory.push(
                //    { role: "assistant", content: `错误的回复` },
                //    { role: "user", content: "你的回复格式不正确，请使用新的混合格式回复：\n分析: [分析内容]\n目的: [目的]\n预期: [预期]\n\n\\`\\`\\`bash\n[命令]\n\\`\\`\\`\n\n或者使用JSON格式也可以。" }
                //);
               const lastMessageIndex = connectionInfo.aiTakeoverHistory.length - 1;
if (lastMessageIndex >= 0 && connectionInfo.aiTakeoverHistory[lastMessageIndex].role === "user") {
  connectionInfo.aiTakeoverHistory[lastMessageIndex].content += 
    "\n\n请注意使用如下格式回复：\n分析: [分析内容]\n目的: [目的]\n预期: [预期]\n\n\\`\\`\\`bash\n[命令]\n\\`\\`\\`";
} 
                // 继续执行，让AI重新回复
                setTimeout(() => {
                    executeAiTakeoverStep(connectionInfo, currentWindow, retryCount);
                }, 2000);
                return;
            }
            
            // 正常的用户输入需求 - 先保存AI的问题到历史记录
            connectionInfo.aiTakeoverHistory.push(
                { role: "assistant", content: `${actionPlan.analysis}\n\n需要用户回答的问题: ${actionPlan.userQuestion}` }
            );
            
            connectionInfo.aiTakeoverMode = false;
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'user_input',
                message: `❓ AI需要您的指导:\n${actionPlan.userQuestion}\n\n请在输入框中回复，然后点击"输入并继续"。`
            });
            return;
        }
        
        if (actionPlan.command && actionPlan.command.trim()) {
            console.log(`准备执行 AI 命令，长度: ${actionPlan.command.length}`);
            
            // 检查是否是内置bash函数
            if (actionPlan.isBuiltinFunction && actionPlan.builtinCommand) {
                // 发送内置函数解析信息
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'executing',
                    message: `🔧 解析内置函数: ${actionPlan.command}\n生成的bash命令: ${actionPlan.builtinCommand}\n目的: ${actionPlan.purpose}`
                });
                
                // 执行解析后的bash命令
                const modifiedActionPlan = {
                    ...actionPlan,
                    command: actionPlan.builtinCommand
                };
                await executeAiCommand(connectionInfo, currentWindow, modifiedActionPlan);
            } else {
                // 执行普通命令
                await executeAiCommand(connectionInfo, currentWindow, actionPlan);
            }
        } else {
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'error',
                    message: `❌ AI响应格式错误，无法解析。正在要求AI使用正确的格式重新回复...`
                });
                
                // 添加错误信息到历史，让AI重新回复
                //connectionInfo.aiTakeoverHistory.push(
                //    { role: "assistant", content: `错误的回复` },
                //    { role: "user", content: "你的回复格式不正确，请使用新的混合格式回复：\n分析: [分析内容]\n目的: [目的]\n预期: [预期]\n\n\\`\\`\\`bash\n[命令]\n\\`\\`\\`\n\n或者使用JSON格式也可以。" }
                //);
               const lastMessageIndex = connectionInfo.aiTakeoverHistory.length - 1;
if (lastMessageIndex >= 0 && connectionInfo.aiTakeoverHistory[lastMessageIndex].role === "user") {
  connectionInfo.aiTakeoverHistory[lastMessageIndex].content += 
    "\n\n请注意使用如下格式回复：\n分析: [分析内容]\n目的: [目的]\n预期: [预期]\n\n\\`\\`\\`bash\n[命令]\n\\`\\`\\`";
} 
                
                // 继续执行，让AI重新回复
                setTimeout(() => {
                    executeAiTakeoverStep(connectionInfo, currentWindow, retryCount);
                }, 2000);
                return;
            // 没有命令，可能AI响应格式有问题
            //console.log('未找到有效命令，actionPlan:', actionPlan);
            //currentWindow.webContents.send('ai-takeover-update', {
            //    type: 'error',
            //    message: `⚠️ AI响应格式错误，未找到有效命令。\n解析结果: 命令="${actionPlan.command}"\n原始响应:\n${response.substring(0, 500)}...`
            //});
            //
            //// 继续下一步，让AI重新规划
            //setTimeout(() => {
            //    executeAiTakeoverStep(connectionInfo, currentWindow, retryCount);
            //}, 3000);
        }
        
    } catch (error) {
        if (error.code === 'AI_ABORTED' || !ownsTabConnection(currentWindow, connectionInfo)) return;
        console.error('AI接管执行错误:', error);
        
        // 如果是超时错误且还有重试次数，则重试
        if ((error.message.includes('超时') || error.message.includes('timeout')) && retryCount < maxRetries) {
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'error',
                message: `⚠️ 请求超时，正在重试... (${retryCount + 1}/${maxRetries})`
            });
            
            // 等待2秒后重试
            setTimeout(() => {
                executeAiTakeoverStep(connectionInfo, currentWindow, retryCount + 1);
            }, 2000);
            return;
        }
        
        // 最终失败
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'error',
            message: `❌ AI接管模式出错: ${error.message}${retryCount > 0 ? ` (已重试${retryCount}次)` : ''}`
        });
        
        connectionInfo.aiTakeoverMode = false;
    }
}

// AI接管模式压缩上下文功能
async function compressTakeoverContext(connectionInfo) {
    const config = getAiConfig(connectionInfo);
    if (!config.apiKey) {
        throw new Error('需要AI API密钥来压缩上下文');
    }

    // 如果历史记录为空或很少，不需要压缩（但保持存档不丢失）
    if (!connectionInfo.aiTakeoverHistory || connectionInfo.aiTakeoverHistory.length <= 2) {
        return { success: true, summaryId: null };
    }

    const historyText = connectionInfo.aiTakeoverHistory.map(msg => {
        const roleLabel = msg.role === 'user' ? '用户' : (msg.role === 'system' ? '系统' : 'AI');
        return `${roleLabel}: ${msg.content}`;
    }).join('\n\n');

    const compressionPrompt = `请将以下AI接管模式的执行历史压缩为简洁的摘要，保留关键信息：

${historyText}

请提供一个结构化的摘要，包括：
1. 任务目标和背景
2. 已完成的主要步骤和命令
3. 当前的执行状态和进度
4. 遇到的问题和解决方案
5. 下一步需要执行的任务

摘要应该简洁但包含足够信息以便AI继续执行任务。`;

    const messages = [
        { role: "system", content: "你是一个专业的任务执行历史摘要助手，能够提取和保留执行过程中的关键信息。请用中文回复。" },
        { role: "user", content: compressionPrompt }
    ];

    try {
        const summary = await callOpenAI(messages, 1000, false, null, 0, connectionInfo, config);

        // 将摘要作为一条新的assistant消息附加，而不是替换历史
        const summaryContent = `[执行历史摘要 - ${new Date().toLocaleString()}]\n\n${summary}\n\n--- 以上为压缩的历史记录，保留了检索索引(MCP)用于回溯 ---`;
        connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: summaryContent });

        // 维护分层上下文：将自上次压缩以来的消息归并到一个summary节点
        buildOrUpdateContextIndex(connectionInfo);
        const start = connectionInfo.contextGraph.lastCompressedIndex + 1;
        const end = connectionInfo.aiTakeoverHistory.length - 2; // 摘要前一条为最近一条真实消息
        if (end >= start && start >= 0) {
            const summaryId = addSummaryLayer(connectionInfo, start, end, summaryContent);
            return { success: true, summaryId };
        }
        return { success: true, summaryId: null };
    } catch (error) {
        throw new Error(`接管模式上下文压缩失败: ${error.message}`);
    }
}

// 检查AI接管模式是否需要压缩上下文
function shouldCompressTakeoverContext(connectionInfo) {
    const historySize = JSON.stringify(connectionInfo.aiTakeoverHistory).length;
    return historySize > getAiConfig(connectionInfo).contextCompressionThreshold;
}

// 构建/更新上下文索引（将 aiTakeoverHistory 同步到 contextGraph）
function buildOrUpdateContextIndex(connectionInfo) {
    const g = connectionInfo.contextGraph;
    if (!g) return;
    if (!Array.isArray(g.historyNodeIds)) g.historyNodeIds = [];
    for (let i = g.lastHistoryIndexed + 1; i < connectionInfo.aiTakeoverHistory.length; i++) {
        const msg = connectionInfo.aiTakeoverHistory[i];
        const id = `h${++g.nodeSeq}`;
        g.nodes[id] = { id, type: 'msg', role: msg.role, content: msg.content, ts: new Date(), children: [], level: 0 };
        g.historyNodeIds[i] = id;
        g.lastHistoryIndexed = i;
    }
}

// 新增一层摘要，将 [start..end] 的消息合并到一个summary节点
function addSummaryLayer(connectionInfo, start, end, summaryContent) {
    const g = connectionInfo.contextGraph;
    buildOrUpdateContextIndex(connectionInfo);
    const childIds = [];
    for (let i = Math.max(0, start); i <= Math.min(end, g.historyNodeIds.length - 1); i++) {
        const id = g.historyNodeIds[i];
        if (id) childIds.push(id);
    }
    const sid = `s${++g.nodeSeq}`;
    g.nodes[sid] = { id: sid, type: 'summary', role: 'assistant', content: summaryContent, ts: new Date(), children: childIds, level: (g.layers.length + 1) };
    g.layers.push({ id: `L${g.layers.length + 1}`, start, end, summaryId: sid, ts: new Date() });
    g.lastCompressedIndex = end;
    return sid;
}

// 构建提供给LLM的MCP索引（仅包含层级和摘要关系，避免过长）
function buildMcpIndex(connectionInfo) {
    const g = connectionInfo.contextGraph || { layers: [], nodes: {} };
    const layers = g.layers.map(l => ({ id: l.id, range: [l.start, l.end], summaryId: l.summaryId }));
    const summaries = layers.map(l => {
        const n = g.nodes[l.summaryId];
        return {
            id: l.summaryId,
            title: (n?.content || '').split('\n')[0].slice(0, 80),
            children: (n?.children || []).length
        };
    });
    return { layers, summaries, latestSummaryId: layers.length ? layers[layers.length - 1].summaryId : null };
}

// 为LLM挑选更短的历史：保留最新摘要和最近N条消息
function selectHistoryForLLM(connectionInfo, N = 24, maxSummaries = 2) {
    const hist = connectionInfo.aiTakeoverHistory || [];
    const selected = [];
    // 最近N条
    const start = Math.max(0, hist.length - N);
    for (let i = start; i < hist.length; i++) selected.push(hist[i]);
    // 保留最近的摘要消息（通过标识前缀判断）
    const summaries = hist.filter(m => m.role === 'assistant' && /^\[执行历史摘要\s*-/.test(m.content)).slice(-maxSummaries);
    // 去重添加
    summaries.forEach(s => { if (!selected.includes(s)) selected.unshift(s); });
    return selected;
}

// 将摘要ID展开并注入历史，供模型下轮使用
function mcpExpandInject(connectionInfo, summaryId, keywords, currentWindow) {
    const g = connectionInfo.contextGraph;
    const node = g?.nodes?.[summaryId];
    if (!node || node.type !== 'summary') {
        throw new Error(`invalid summary id ${summaryId}`);
    }
    const children = node.children || [];
    const lines = [];
    for (const childId of children) {
        const idx = (g.historyNodeIds || []).findIndex(id => id === childId);
        if (idx >= 0) {
            const m = connectionInfo.aiTakeoverHistory[idx];
            if (!m) continue;
            const text = m.content || '';
            if (keywords && !text.includes(keywords)) continue;
            lines.push(`[#${idx} ${m.role}] ${text}`);
        }
    }
    const pack = lines.length ? lines.join('\n\n') : '(无匹配内容)';
    const injected = `MCP展开详情(${summaryId}${keywords?`, 关键字: ${keywords}`:''})\n\n${pack}`;
    connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: injected });
    buildOrUpdateContextIndex(connectionInfo);
    if (currentWindow) {
        currentWindow.webContents.send('ai-takeover-update', { type: 'analysis', message: `📂 已展开摘要 ${summaryId}，获得 ${lines.length} 条相关详情` });
    }
    return lines.length;
}

// 构建AI接管模式的系统提示词
function buildTakeoverSystemPrompt(connectionInfo) {
    // 检查是否有压缩的上下文信息
    const contextInfo = connectionInfo.contextCompressed 
        ? `\n\n注意: 上下文已于 ${connectionInfo.lastCompressionTime?.toLocaleString()} 压缩，请参考历史摘要信息。`
        : '';

    const mcpIndex = buildMcpIndex(connectionInfo);
    const mcpGuide = `\n\nMCP(可回溯上下文) 使用说明:\n- 参考 MCP-Index 来理解历史的分层压缩结构\n- 如需引用早期细节，请在分析中明确引用对应的节点ID与摘要要点\n- 如需让用户展开某个摘要，可在分析中给出提示并使用 USER_INPUT_NEEDED 请求，如: USER_INPUT_NEEDED: MCP_EXPAND ${mcpIndex.latestSummaryId || 'S?'} <可选关键字>\n- 用户也可通过 /search 关键字 搜索历史`;

    // 动态提示当前REPL状态，强制指令用法
    let replGuide = '';
    if (connectionInfo.replMode) {
        const replTarget = (connectionInfo.replTarget || 'remote').toLowerCase();
        replGuide = `\n\n当前处于交互式会话: ${connectionInfo.replMode} (target: ${replTarget})\n` +
            `在交互会话中，普通 shell 命令会被当作“输入”发送给该会话；如需执行普通命令，必须先退出交互会话。\n` +
            `推荐使用以下内置函数控制交互：\n` +
            `- interactive_send(\"文本\") / interactive_line(\"一行并回车\")\n` +
            `- interactive_key(\"UP|DOWN|LEFT|RIGHT|ENTER|TAB|ESC|BACKSPACE|DELETE|HOME|END|PAGEUP|PAGEDOWN\", 1)\n` +
            `- interactive_ctrl(\"C\") (Ctrl+C)\n` +
            `- interactive_wait(800) / interactive_wait_for(\"关键字\", 8000)\n` +
            `- interactive_exit() / interactive_stop()\n` +
            `专用函数(可选)：py_send/py_exit, node_send/node_exit, mysql_send/mysql_exit。\n` +
            `本地交互要求 node-pty；若安装包缺少原生PTY模块，交互式CLI(如 codex 的选择菜单)会拒绝启动。`;
    }

    const takeoverTarget = (connectionInfo.aiTakeoverTarget || 'remote').toLowerCase();
    const remoteEnabled = takeoverTarget === 'remote' || takeoverTarget === 'hybrid';
    const localEnabled = takeoverTarget === 'local' || takeoverTarget === 'hybrid';
    const localEnvironment = connectionInfo.localTakeoverBinding?.environment;
    const localShell = localEnvironment?.shellFile || '未绑定';

    const remoteEnvInfo = remoteEnabled
        ? `远程(SSH)环境信息:\n- 远程初始目录: ${connectionInfo.aiTakeoverInitialDir}\n- 远程当前目录: ${connectionInfo.currentWorkingDirectory}\n- 远程最近输出: ${(connectionInfo.lastTerminalOutput || '').slice(-800)}\n`
        : `远程(SSH)环境信息:\n- 未启用远程执行\n`;

	    const localEnvInfo = localEnabled
	        ? `\n本地环境信息:\n- 平台: ${localEnvironment?.platform} (${localEnvironment?.label})\n- Shell: ${localShell}\n- 本地初始工作目录: ${connectionInfo.localTakeoverInitialDir}\n- 本地当前目录: ${connectionInfo.localWorkingDirectory}\n- 本地最近输出: ${(connectionInfo.lastLocalOutput || '').slice(-800)}\n- 命令在此终端系统中运行，使用此系统路径；独立命令不继承可见 Shell 的临时变量和别名。\n`
        : '';

    return `你是一个系统管理AI助手，现在处于接管模式。接管目标: ${takeoverTarget}。\n你的任务是: ${connectionInfo.aiTakeoverTask}${contextInfo}${mcpGuide}${replGuide}

当前环境信息:
${remoteEnvInfo}${localEnvInfo}

重要约束:
	1. 本地与远程 Shell 均具有当前登录用户的完整权限；初始目录只是起始 cwd，不是安全沙箱
	2. 执行前必须评估风险。删除、提权、关机、服务/防火墙修改、强制 Git 操作、数据库破坏等高危动作必须输出 CONFIRM_REQUIRED: yes 并等待用户确认；应用还会独立审计
3. 每次执行前必须说明原因和目的
4. 任务完成后不要退出，而是询问用户是否需要进一步修改或优化
5. 开始任务前先用ls命令查看当前目录，检查是否有未完成的项目
6. 有任何疑问可以询问用户意见
7. 只有当用户明确表示要退出时才使用"TASK_COMPLETE"
8. 当用户输入"压缩上下文"时，使用"COMPRESS_CONTEXT"命令
9. 可以使用内置bash函数来简化常用操作
10. 判断任务复杂度：simple 或 complex。complex 时必须先给出方案(PLAN)并等待用户确认再执行。

输出格式规范(必须包含这些标记，便于解析):
分析:
目的:
预期:
TARGET: remote|local (混合模式必须提供；未提供时默认 remote)
CONFIRM_REQUIRED: yes|no
PLAN: (当复杂时，列出分步方案)
\`\`\`bash / builtin / local / local-builtin
...命令或内置函数...
\`\`\`

用户特殊命令:
- "退出" - 用户主动退出AI接管模式
- "测试：命令" 或 "test:命令" - 按当前接管目标执行测试命令
- "本地测试：命令" 或 "local test:命令" - 强制在本机执行测试命令
- "远程测试：命令" 或 "remote test:命令" - 强制在SSH远程执行测试命令

可用的内置bash函数(全栈开发专用):

=== 交互会话 ===
- interactive_start("codex", "local|remote|auto") - 启动交互式CLI（例如 codex/claude）
- interactive_send("text") - 发送文本（不自动回车）
- interactive_line("text") - 发送一行并回车
- interactive_key("DOWN", 3) - 发送按键（支持 UP/DOWN/LEFT/RIGHT/ENTER/TAB/ESC/BACKSPACE/DELETE/HOME/END/PAGEUP/PAGEDOWN）
- interactive_ctrl("C") - 发送 Ctrl+C
- interactive_wait(800) - 等待一段时间后继续（毫秒）
- interactive_wait_for("keyword", 8000) - 等待输出包含关键字（毫秒超时）
- interactive_exit() - 尝试退出当前交互会话（如 codex 用 /quit）
- interactive_stop() - 强制停止当前交互会话

=== 文件操作 ===
- findAndReplace("old", "new", "index.html") - 替换指定文件内容(必须指定文件名)
- previewReplace("old", "new", "index.html") - 预览替换结果
- insertAfter("</head>", "<link rel='stylesheet' href='new.css'>", "index.html") - 在指定行后插入
- insertBefore("</body>", "<script src='app.js'></script>", "index.html") - 在指定行前插入
- createFile("newfile.txt", "内容") - 创建新文件
- appendToFile("log.txt", "新日志") - 追加内容到文件
- safeDelete("oldfile.txt") - 安全删除(移动到.trash/)
- backupFile("important.html") - 备份文件
- showDiff("old.html", "new.html") - 比较文件差异

=== Node.js 开发 ===
- npmInit("project-name", "项目描述") - 初始化npm项目
- npmInstall("express cors", false) - 安装npm包(第二个参数true为开发依赖)
- npmRun("dev") - 运行npm脚本
- npmScripts() - 查看所有可用脚本
- createNodeEntry("server.js") - 创建Express服务器入口文件
- showDependencies() - 查看项目依赖
- cleanProject() - 清理node_modules
- reinstallDeps() - 重新安装所有依赖

=== Vite 开发 ===
- createViteProject("my-app", "react") - 创建Vite项目(支持vanilla/react/vue等)
- viteServe() - 启动Vite开发服务器
- viteBuild() - Vite构建生产版本
- createViteConfig() - 创建Vite配置文件

=== Electron 开发 ===
- electronInit("my-electron-app") - 初始化Electron项目
- createElectronMain() - 创建Electron主进程文件
- electronBuild() - Electron应用打包

=== Git 版本控制 ===
- gitInit() - 初始化Git仓库
- gitCommit("提交信息") - 添加并提交所有更改
- createGitignore("node") - 创建.gitignore文件(node/web类型)

=== 项目管理 ===
- createProjectStructure("myproject") - 创建标准项目目录
- createHtmlTemplate("page.html", "页面标题") - 创建HTML模板
- createCssTemplate("styles.css") - 创建CSS模板
- createReadme("项目名", "项目描述") - 创建README.md文件
- showTree(".", 3) - 显示目录结构

=== 开发工具 ===
- checkPort(3000) - 查看端口占用情况
- killPort(3000) - 杀死占用端口的进程
- searchLines("error", "app.js", true) - 搜索内容(显示行号)
- showLines("config.txt", 10, 20) - 显示指定行(当文件特别大时请用此命令)
- checkPermissions("script.sh") - 检查文件权限
- systemInfo() - 系统信息

=== 交互式会话(内置指令) ===
- 使用内置函数与交互式程序配合，例如 Python REPL：
\`\`\`builtin
enter_python_repl()
\`\`\`
进入Python交互模式；随后可以：
\`\`\`builtin
py_send("print('hi')")
\`\`\`
发送一行到REPL；退出：
\`\`\`builtin
py_exit()
\`\`\`
Node REPL:
\`\`\`builtin
enter_node_repl()
\`\`\`
\`\`\`builtin
node_send("console.log('hi')")
\`\`\`
\`\`\`builtin
node_exit()
\`\`\`
MySQL 客户端（远端需安装 mysql 客户端）：
\`\`\`builtin
enter_mysql_repl("-u user -p'pass' -h 127.0.0.1 db")
\`\`\`
\`\`\`builtin
mysql_send("show databases;")
\`\`\`
\`\`\`builtin
mysql_exit()
\`\`\`

=== MCP 检索(内置指令) ===
- 展开某个摘要以获取其指向的原始细节：
\`\`\`builtin
mcp_expand("s12", "可选关键字")
\`\`\`
- 抓取历史区间：
\`\`\`builtin
mcp_fetch(10, 25)
\`\`\`
- 在完整历史中搜索并注入匹配片段：
\`\`\`builtin
mcp_search("关键字", 20)
\`\`\`

注意: 
1. 所有文件操作必须指定具体文件名，不能使用通配符
2. 支持Node.js、Vite、Electron等现代开发工具链
3. 自动创建版本控制快照，确保项目安全

=== 版本控制系统 ===
- listSnapshots(文件路径) - 查看文件的快照历史
- restoreFile(文件路径, 快照ID) - 恢复文件到指定快照
- cleanSnapshots(文件路径, 保留数量) - 清理旧快照

=== 全局修改记录 ===
- listAllChanges(小时数) - 按时间列出所有修改(默认24小时)
- scanProjectFiles(目录) - 扫描项目文件变化

重要: 
1. 所有文件修改操作都会自动创建快照，操作错误时可以随时回退
2. 所有命令执行都会被记录，可以追踪项目变化历史
3. 快照文件名包含文件名和时间戳，便于识别

响应格式要求(推荐使用新的混合格式，也支持JSON格式)，注意每次回答必需返回且仅返回一个命令（可执行命令或特殊命令）:

新的混合格式(推荐):
分析: 详细分析当前状态和需求
目的: 执行此操作的目的
预期: 预期的执行结果

\`\`\`bash
要执行的bash命令
\`\`\`

本地命令格式(执行在本机):
TARGET: local
\`\`\`local
要执行的本地命令
\`\`\`

内置函数格式:
分析: 需要使用内置函数处理文件
目的: 修改或创建文件
预期: 文件被正确处理

\`\`\`builtin
find_and_replace_code("文件名", "查找内容", "替换内容")
\`\`\`

特殊命令:
- 任务完成: 在分析中包含"任务完成"或使用命令 TASK_COMPLETE
- 需要用户输入: 在分析中包含"USER_INPUT_NEEDED"或使用命令 USER_INPUT_NEEDED:问题描述
- 压缩上下文: 在分析中包含"COMPRESS_CONTEXT"或使用命令 COMPRESS_CONTEXT
\`\`\`bash
USER_INPUT_NEEDED:请选择您想让我进行的下一步骤：（1）继续优化x功能（2）开发新功能？
\`\`\`

旧JSON格式(仍然支持):
如果你更习惯JSON格式，也可以继续使用，但复杂代码建议用新格式避免转义问题。

示例:
{
  "analysis": "用户要求创建一个简单的网站，我需要先查看当前目录是否有现有文件",
  "command": "ls -la",
  "purpose": "查看当前目录内容，检查是否有未完成的项目",
  "expectation": "显示当前目录的所有文件和文件夹"
}

如果任务的主要部分完成，询问用户进一步需求:
{
  "analysis": "网站已经创建完成，包含了HTML、CSS和基本功能。现在可以询问用户是否需要进一步的修改或优化",
  "command": "USER_INPUT_NEEDED: 网站已创建完成！您是否需要进一步的修改？比如添加样式、修改内容、添加功能等？如果满意可以说'完成'退出",
  "purpose": "询问用户是否需要进一步优化",
  "expectation": "用户提供进一步的指示或确认完成"
}

只有用户明确要退出时才使用:
{
  "analysis": "用户确认任务完成，准备退出接管模式",
  "command": "TASK_COMPLETE", 
  "purpose": "用户确认退出",
  "expectation": "退出AI接管模式"
}

如果需要用户输入:
{
  "analysis": "发现目录中已有index.html文件，不确定是否要覆盖",
  "command": "USER_INPUT_NEEDED: 发现已存在index.html文件，是否要覆盖现有文件？",
  "purpose": "征求用户意见",
  "expectation": "用户提供指导"
}`;
}

// 获取上下文输入
function getContextualInput(connectionInfo) {
    if (connectionInfo.aiTakeoverHistory.length === 0) {
        return `请开始执行任务: ${connectionInfo.aiTakeoverTask}`;
    } else {
        return `请根据上一步的执行结果继续任务。最近的终端输出: ${connectionInfo.lastTerminalOutput.slice(-500)}`;
    }
}

// 解析AI响应 - 支持新的混合格式
function parseAiResponse(response) {
    console.log(`解析AI响应，长度: ${String(response || '').length}`);
    
    try {
        // 新的混合格式解析器
        const result = parseNewFormat(response);
        if (result) {
            console.log('新格式解析成功');
            return result;
        }
        
        // 如果新格式解析失败，尝试旧的JSON格式（向后兼容）
        console.log('尝试旧JSON格式解析...');
        return parseOldJsonFormat(response);
        
    } catch (error) {
        console.error('所有格式解析都失败:', error);
        console.log('AI响应格式错误，需要重新请求...');
        
        // 解析失败时返回特殊标记，要求AI重新回复
        return {
            analysis: `AI响应格式错误，无法解析。原始响应: ${response.substring(0, 300)}...`,
            command: null,
            purpose: '解析失败',
            expectation: '需要重新回复',
            isComplete: false,
            needsUserInput: false,
            needsCompression: false,
            isBuiltinFunction: false,
            builtinCommand: null,
            userQuestion: '',
            summary: '',
            parseError: true
        };
    }
}

// 新的混合格式解析器
function parseNewFormat(response) {
    const lines = response.split('\n');
    let analysis = '';
    let purpose = '';
    let expectation = '';
    let plan = '';
    let command = '';
    let commandType = '';
    let target = '';
    let requiresConfirmation = false;
    
    let currentSection = '';
    let inCodeBlock = false;
    let codeBlockType = '';
    let codeBlockKind = '';
    let codeBlockTarget = '';

    const fieldValue = (raw) => {
        const idx1 = raw.indexOf(':');
        const idx2 = raw.indexOf('：');
        let idx = -1;
        if (idx1 !== -1 && idx2 !== -1) idx = Math.min(idx1, idx2);
        else idx = idx1 !== -1 ? idx1 : idx2;
        return idx === -1 ? '' : raw.substring(idx + 1).trim();
    };
    
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = rawLine.trim();
        
        // 检测代码块开始
        if (line.startsWith('```')) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeBlockType = line.substring(3).trim().toLowerCase();
                codeBlockKind = '';
                codeBlockTarget = '';

                // Support: bash/builtin + local/local-builtin + remote-bash/remote-builtin
                const t = codeBlockType;
                if (t === 'bash' || t === 'sh' || t === 'shell') {
                    commandType = 'bash';
                    codeBlockKind = 'bash';
                } else if (t === 'builtin') {
                    commandType = 'builtin';
                    codeBlockKind = 'builtin';
                } else if (t === 'local' || t === 'local-bash' || t === 'bash-local' || t === 'powershell' || t === 'pwsh' || t === 'cmd') {
                    commandType = 'local';
                    codeBlockKind = 'bash';
                    codeBlockTarget = 'local';
                    target = target || 'local';
                } else if (t === 'local-builtin' || t === 'builtin-local') {
                    commandType = 'local-builtin';
                    codeBlockKind = 'builtin';
                    codeBlockTarget = 'local';
                    target = target || 'local';
                } else if (t === 'remote' || t === 'remote-bash' || t === 'bash-remote') {
                    commandType = 'bash';
                    codeBlockKind = 'bash';
                    codeBlockTarget = 'remote';
                    target = target || 'remote';
                } else if (t === 'remote-builtin' || t === 'builtin-remote') {
                    commandType = 'builtin';
                    codeBlockKind = 'builtin';
                    codeBlockTarget = 'remote';
                    target = target || 'remote';
                } else if (t.includes('local') && t.includes('builtin')) {
                    commandType = 'local-builtin';
                    codeBlockKind = 'builtin';
                    codeBlockTarget = 'local';
                    target = target || 'local';
                } else if (t.includes('local')) {
                    commandType = 'local';
                    codeBlockKind = 'bash';
                    codeBlockTarget = 'local';
                    target = target || 'local';
                } else if (t.includes('builtin')) {
                    commandType = 'builtin';
                    codeBlockKind = 'builtin';
                } else {
                    // 默认按 bash 处理，避免解析失败
                    commandType = 'bash';
                    codeBlockKind = 'bash';
                }
                continue;
            } else {
                // 代码块结束
                inCodeBlock = false;
                codeBlockType = '';
                codeBlockKind = '';
                codeBlockTarget = '';
                continue;
            }
        }
        
        // 在代码块内，收集命令
        if (inCodeBlock && (codeBlockKind === 'bash' || codeBlockKind === 'builtin')) {
            // Preserve command/script bytes inside fenced code blocks.  The AI
            // often creates files via heredocs (`cat <<'EOF' ... EOF`); trimming
            // indentation or dropping comment/blank lines corrupts generated
            // Python/YAML/shell content and makes local/remote automation flaky.
            command += (command ? '\n' : '') + rawLine;
            continue;
        }
        
        // 解析分析、目的、预期、确认、计划部分
        if (line.startsWith('分析:') || line.startsWith('分析：')) {
            currentSection = 'analysis';
            analysis = fieldValue(line);
            continue;
        } else if (line.startsWith('目的:') || line.startsWith('目的：')) {
            currentSection = 'purpose';
            purpose = fieldValue(line);
            continue;
        } else if (line.startsWith('预期:') || line.startsWith('预期：')) {
            currentSection = 'expectation';
            expectation = fieldValue(line);
            continue;
        } else if (/^TARGET\s*[:：]/i.test(line)) {
            const idx = line.indexOf(':') !== -1 ? line.indexOf(':') : line.indexOf('：');
            const v = (idx !== -1 ? line.substring(idx + 1) : '').trim().toLowerCase();
            if (v === 'local' || v === 'remote') target = v;
            currentSection = '';
            continue;
        } else if (/^CONFIRM_REQUIRED\s*[:：]/i.test(line)) {
            const idx = line.indexOf(':') !== -1 ? line.indexOf(':') : line.indexOf('：');
            const v = (idx !== -1 ? line.substring(idx + 1) : '').trim().toLowerCase();
            requiresConfirmation = v === 'yes' || v === 'true' || v === '需要' || v === '是';
            currentSection = '';
            continue;
        } else if (/^PLAN\s*[:：]/i.test(line)) {
            currentSection = 'plan';
            const rest = fieldValue(line);
            if (rest) plan += rest;
            continue;
        } else if (line && currentSection) {
            // 继续当前部分的内容
            if (currentSection === 'analysis') {
                analysis += (analysis ? ' ' : '') + line;
            } else if (currentSection === 'purpose') {
                purpose += (purpose ? ' ' : '') + line;
            } else if (currentSection === 'expectation') {
                expectation += (expectation ? ' ' : '') + line;
            } else if (currentSection === 'plan') {
                plan += (plan ? '\n' : '') + line;
            }
        }
    }
    
    // 如果没有找到有效的命令和分析，返回null让旧格式处理
    if (!command && !analysis) {
        return null;
    }
    
    // 检查特殊命令
    const isComplete = command === 'TASK_COMPLETE' || analysis.includes('TASK_COMPLETE');
    const needsUserInput = command.startsWith('USER_INPUT_NEEDED:') || analysis.includes('USER_INPUT_NEEDED');
    const needsCompression = command === 'COMPRESS_CONTEXT' || analysis.includes('COMPRESS_CONTEXT');
    
    // 处理内置函数：允许模型在 bash/local 代码块里直接写函数调用（更鲁棒）
    let isBuiltinFunction = false;
    let builtinCommand = null;
    if (command) {
        command = command.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
        const parsed = parseBuiltinFunction(command);
        if (parsed) {
            isBuiltinFunction = true;
            builtinCommand = parsed;
        }
    }
    
    console.log('新格式解析结果:', {
        commandLength: command.length,
        hasPlan: !!plan,
        requiresConfirmation,
        commandType,
        isComplete,
        needsUserInput,
        needsCompression,
        isBuiltinFunction
    });
    
    return {
        analysis: analysis || '无分析内容',
        command: isComplete || needsCompression ? null : command,
        ori_command: isComplete || needsCompression ? null : command,
	ori_answer:response,
        purpose: purpose || '无目的说明',
        expectation: expectation || '无预期说明',
        isComplete: isComplete,
        needsUserInput: needsUserInput,
        needsCompression: needsCompression,
        isBuiltinFunction: isBuiltinFunction,
        builtinCommand: builtinCommand,
        requiresConfirmation: requiresConfirmation,
        plan: plan,
        userQuestion: needsUserInput ? (command.startsWith('USER_INPUT_NEEDED:') ? command.substring('USER_INPUT_NEEDED:'.length).trim() : analysis) : '',
        summary: isComplete ? analysis : '',
        commandType: commandType,
        target: target || null
    };
}

// 旧的JSON格式解析器（向后兼容）
function parseOldJsonFormat(response) {
    let jsonData;
    
    // 查找JSON部分
    const jsonStart = response.indexOf('{');
    const jsonEnd = response.lastIndexOf('}');
    
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        const jsonStr = response.substring(jsonStart, jsonEnd + 1);
        jsonData = JSON.parse(jsonStr);
    } else {
        throw new Error('未找到有效的JSON格式');
    }
    
    const { analysis, command, purpose, expectation, target } = jsonData;
    
    const isComplete = command === 'TASK_COMPLETE';
    const needsUserInput = command && command.startsWith('USER_INPUT_NEEDED:');
    const needsCompression = command === 'COMPRESS_CONTEXT';
    const isBuiltinFunction = command && parseBuiltinFunction(command);
    
    console.log('JSON解析结果:', { isComplete, needsUserInput, needsCompression, isBuiltinFunction: !!isBuiltinFunction });
    
    return {
        analysis: analysis || '无分析内容',
        command: isComplete || needsCompression ? null : (isBuiltinFunction || command),
        purpose: purpose || '无目的说明',
        expectation: expectation || '无预期说明',
        isComplete: isComplete,
        needsUserInput: needsUserInput,
        needsCompression: needsCompression,
        isBuiltinFunction: !!isBuiltinFunction,
        builtinCommand: isBuiltinFunction,
        userQuestion: needsUserInput ? command.substring('USER_INPUT_NEEDED:'.length).trim() : '',
        summary: isComplete ? analysis : '',
        commandType: 'bash',
        target: target || null
    };
}

// 执行SSH命令 - 简单版本，用于测试和危险命令确认
async function executeSSHCommand(connectionInfo, command) {
    return new Promise((resolve, reject) => {
        if (!connectionInfo || !connectionInfo.sshStream) {
            reject(new Error('No active SSH stream'));
            return;
        }

        let output = '';
        let errorOutput = '';
        
        // 监听数据输出
        const dataHandler = (data) => {
            output += data.toString();
        };
        
        const errorHandler = (data) => {
            errorOutput += data.toString();
        };
        
        // 添加临时监听器
        connectionInfo.sshStream.on('data', dataHandler);
        connectionInfo.sshStream.stderr?.on('data', errorHandler);
        
        // 执行命令
        connectionInfo.sshStream.write(command + '\n');
        
        // 设置超时，避免无限等待
        const timeout = setTimeout(() => {
            // 清理监听器
            connectionInfo.sshStream.removeListener('data', dataHandler);
            connectionInfo.sshStream.stderr?.removeListener('data', errorHandler);
            
            const result = output || errorOutput || '命令执行完成（无输出）';
            resolve(result);
        }, 5000); // 5秒超时
        
        // 如果有错误输出，也算作完成
        if (errorOutput) {
            clearTimeout(timeout);
            connectionInfo.sshStream.removeListener('data', dataHandler);
            connectionInfo.sshStream.stderr?.removeListener('data', errorHandler);
            resolve(output + errorOutput);
        }
    });
}

function expandLocalTilde(p) {
    if (!p || typeof p !== 'string') return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

function prepareLocalCommand(connectionInfo, command) {
    // Generated POSIX helpers already use /tmp in the target terminal system.
    // Do not rewrite WSL paths or create directories through Windows fs.
    return String(command || '');
}

async function executeLocalShellCommand(connectionInfo, command) {
    const binding = connectionInfo.localTakeoverBinding;
    if (!binding?.valid()) throw new Error('本地终端已关闭或变化，请重新启动接管');
    const valid = () => connectionInfo.localTakeoverBinding === binding && binding.valid();
    const controller = new AbortController();
    connectionInfo.localCommandControllers ||= new Set();
    connectionInfo.localCommandControllers.add(controller);
    const observer = observeProgram(connectionInfo, 'local', 'ai-command', command);
    try {
        const result = await executeInEnvironment(binding.environment, command, connectionInfo.localWorkingDirectory || binding.cwd, {
            valid, signal: controller.signal, onOutput: text => observer.output(text)
        });
        if (!valid()) throw new Error('执行期间本地终端已关闭或变化');
        observer.stop({ exitCode: result.exitCode, signal: result.signal });
        connectionInfo.localWorkingDirectory = result.cwd;
        connectionInfo.lastLocalOutput = result.output;
        return result;
    } catch (error) {
        observer.stop({ error: error.message, reason: controller.signal.aborted ? 'cancelled' : '' });
        throw error;
    } finally { connectionInfo.localCommandControllers.delete(controller); }
}

function decodeActionAuditSubject(actionPlan, command) {
    const tag = actionPlan?.builtinCommand || command || '';
    if (typeof tag !== 'string') return String(command || '');
    try {
        if (tag.startsWith('__INTERACTIVE__')) {
            const parts = tag.split(':');
            const action = (parts[1] || '').toUpperCase();
            if (action === 'START') return Buffer.from(parts[3] || '', 'base64').toString('utf8');
            if (action === 'SEND' || action === 'LINE') return Buffer.from(parts[2] || '', 'base64').toString('utf8');
            return '';
        }
        if (tag.startsWith('__REPL__:')) {
            if (/_SEND:/.test(tag)) return Buffer.from(tag.split(':').pop() || '', 'base64').toString('utf8');
            if (tag.startsWith('__REPL__:REPL_MYSQL_START:')) {
                return `mysql ${Buffer.from(tag.split(':').pop() || '', 'base64').toString('utf8')}`;
            }
            return '';
        }
    } catch {}
    return String(command || '');
}

// 执行AI命令
async function executeAiCommand(connectionInfo, currentWindow, actionPlan) {
    if (tabExecutionContext.getStore() !== connectionInfo) {
        return tabExecutionContext.run(
            connectionInfo,
            () => executeAiCommand(connectionInfo, currentWindow, actionPlan)
        );
    }
    // Fallback: derive window if not provided
    if (!currentWindow) {
        try {
            const derivedId = getWindowIdForConnectionInfo(connectionInfo);
            if (derivedId) {
                currentWindow = windows.get(derivedId);
            }
        } catch {}
    }
	if (!ownsTabConnection(currentWindow, connectionInfo)) return;
    const executingSshConnection = connectionInfo.sshConnection;
    const executingSshStream = connectionInfo.sshStream;
    const { command: rawCommand, purpose, expectation, ori_command, commandType, analysis } = actionPlan;
    let command = normalizeShellCommand(rawCommand);
    
    console.log('命令长度:', command.length);

    const sessionTarget = (connectionInfo.aiTakeoverTarget || 'remote').toLowerCase();
    let execTarget = (actionPlan.target || '').toLowerCase();
    if (execTarget !== 'local' && execTarget !== 'remote') {
        // Per-session default: local -> local, hybrid -> remote, remote -> remote
        execTarget = sessionTarget === 'local' ? 'local' : 'remote';
        if (sessionTarget === 'hybrid') execTarget = 'remote';
    }

    // Enforce session capability boundaries
    if (execTarget === 'local' && sessionTarget === 'remote') {
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'error',
            message: '🚫 当前接管模式未启用本地执行。请用 "local:任务" 或 "hybrid:任务" 重新启动接管模式。'
        });
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
        return;
    }
    if (execTarget === 'remote' && sessionTarget === 'local') {
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'error',
            message: '🚫 当前接管模式为本地执行，不能执行远程命令。请连接SSH并用 "remote:任务" 或 "hybrid:任务" 重新启动。'
        });
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
        return;
    }
    let pluginLease = null;
    try {
        const toolCall = parsePluginToolCall(command);
        if (toolCall) {
            try {
                const result = await getPluginRuntime().invoke(connectionInfo, toolCall.pluginId, 'tool', toolCall.toolId, toolCall.params, { mode: 'takeover', target: execTarget });
                if (!ownsTabConnection(currentWindow, connectionInfo) || !connectionInfo.aiTakeoverMode) return;
                const output = JSON.stringify(result).slice(0, 32000);
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: command }, { role: 'user', content: `插件工具结果：${output}` });
                sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'result', message: output });
            } catch (error) {
                if (!ownsTabConnection(currentWindow, connectionInfo)) return;
                connectionInfo.aiTakeoverHistory.push({ role: 'user', content: `插件工具失败：${error.message}` });
                sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'error', message: error.message });
            }
            if (connectionInfo.aiTakeoverMode) setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 300);
            return;
        }
        const pluginCall = parsePluginCall(command);
        if (pluginCall) {
            if (connectionInfo.replMode) throw new Error('请先退出当前交互程序，再运行插件动作');
            const resolved = getPluginManager().resolveAction(connectionInfo.pluginIds, pluginCall.pluginId, pluginCall.actionId, {
                target: execTarget, shell: execTarget === 'local' ? connectionInfo.localTakeoverBinding?.environment.shell || 'posix' : 'posix'
            });
            pluginLease = { ...pluginCall, ...resolved };
            command = resolved.command;
        }
    } catch (error) {
        sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'error', message: error.message });
        connectionInfo.aiTakeoverHistory.push({ role: 'user', content: `插件动作未执行：${error.message}` });
        return;
    }
    if (execTarget === 'remote' && !connectionInfo.sshConnection) {
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'error',
            message: '🚫 未检测到SSH连接，无法执行远程命令。'
        });
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
        return;
    }
	if (execTarget === 'local' && !connectionInfo.localTakeoverBinding?.valid()) {
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'error',
	        message: '🚫 本地终端已关闭或变化，请重新打开本地终端并启动接管。'
        });
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
	    return;
	}

	// Normalize platform-specific helper paths before auditing. The command
	// that is audited must be byte-for-byte equivalent to the command dispatched.
	if (execTarget === 'local') {
	    try {
	        command = prepareLocalCommand(connectionInfo, command, { ensureScratchDir: false });
	    } catch (e) {
	        currentWindow.webContents.send('ai-takeover-update', {
	            type: 'error',
	            message: `🚫 本地命令预处理失败: ${e.message}`
	        });
	        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
	        return;
	    }
	}

	// Audit every execution branch in the main process, including decoded
	// interactive/REPL payloads. Renderer/model fields can never approve it.
	const auditSubject = decodeActionAuditSubject(actionPlan, command);
	const audit = auditCommand(auditSubject, { requiresConfirmation: actionPlan.requiresConfirmation === true });
	const auditedBackend = execTarget === 'remote'
	    ? connectionInfo.sshStream
	    : connectionInfo.localTakeoverBinding;
	const priorApproval = actionPlan[INTERNAL_SECURITY_APPROVAL];
	const approvalStillValid = audit.requiresConfirmation &&
	    priorApproval?.command === command &&
	    priorApproval?.auditSubject === auditSubject &&
	    priorApproval?.target === execTarget &&
	    priorApproval?.backend === auditedBackend &&
	    ownsTabConnection(currentWindow, connectionInfo);
        if (!approvalStillValid && !await confirmAuditedCommand(currentWindow, connectionInfo, auditSubject, audit, {
            target: execTarget,
            backend: auditedBackend
        })) {
	    sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', {
	        type: 'analysis',
	        message: '🚫 用户取消执行高危命令，AI 将重新规划下一步操作。'
	    });
	    try {
	        connectionInfo.aiTakeoverHistory.push({ role: 'user', content: '用户取消执行上一条高危命令，请重新规划下一步。' });
	        buildOrUpdateContextIndex(connectionInfo);
	    } catch {}
	    setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1000);
	    return;
	}
	if (!ownsTabConnection(currentWindow, connectionInfo)) return;
    const backendUnchanged = execTarget === 'remote'
        ? connectionInfo.sshConnection === executingSshConnection && connectionInfo.sshStream === auditedBackend
        : connectionInfo.localTakeoverBinding === auditedBackend && auditedBackend?.valid();
    if (!backendUnchanged) {
        sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'error', message: '执行目标已关闭或变化，请重新规划。' });
        return;
    }
	if (pluginLease && !getPluginManager().isCurrent(connectionInfo.pluginIds, pluginLease.pluginId, pluginLease.digest, pluginLease.activation)) {
        sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', { type: 'error', message: '插件已停用或更新，本次动作已取消' });
        return;
    }
	if (audit.requiresConfirmation && !approvalStillValid) {
	    Object.defineProperty(actionPlan, INTERNAL_SECURITY_APPROVAL, {
	        value: { command, auditSubject, target: execTarget, backend: auditedBackend },
	        configurable: true,
	        writable: true
	    });
	}
	if (execTarget === 'local') {
	    try {
	        command = prepareLocalCommand(connectionInfo, command, { ensureScratchDir: true });
	    } catch (e) {
	        sendTabEvent(currentWindow, connectionInfo, 'ai-takeover-update', {
	            type: 'error',
	            message: `🚫 本地命令预处理失败: ${e.message}`
	        });
	        return;
	    }
	}

	// 通用交互式会话内置指令（remote/local）
    const interactiveTag = (() => {
        if (actionPlan?.isBuiltinFunction && typeof actionPlan.builtinCommand === 'string' && actionPlan.builtinCommand.startsWith('__INTERACTIVE__')) {
            return actionPlan.builtinCommand;
        }
        if (typeof command === 'string' && command.startsWith('__INTERACTIVE__')) return command;
        return null;
    })();
    if (interactiveTag) {
        try {
            const parts = interactiveTag.split(':');
            const action = (parts[1] || '').toUpperCase();

            const getActiveTarget = () => {
                const t = (connectionInfo.replTarget || '').toLowerCase();
                if (t === 'local' || t === 'remote') return t;
                return execTarget === 'local' ? 'local' : 'remote';
            };

            const writeInteractive = (target, payload) => {
                if (target === 'local') {
                    writeToLocalInteractive(connectionInfo, payload);
                    return;
                }
                if (!connectionInfo.sshStream) throw new Error('未检测到SSH交互流');
                connectionInfo.sshStream.write(payload);
            };

            if (action === 'START') {
                const reqTarget = (parts[2] || 'auto').toLowerCase();
                const target = (reqTarget === 'local' || reqTarget === 'remote')
                    ? reqTarget
                    : (execTarget === 'local' ? 'local' : 'remote');
                const cmd = Buffer.from(parts[3] || '', 'base64').toString('utf-8').trim();
                if (!cmd) throw new Error('interactive_start 需要非空命令');
                const mode = inferReplModeFromCommandLine(cmd);

                // Enforce session boundaries even if the tag explicitly requests a target.
                if (target === 'local' && sessionTarget === 'remote') {
                    throw new Error('当前接管模式未启用本地执行（请用 local:/hybrid: 重新启动）');
                }
                if (target === 'remote' && sessionTarget === 'local') {
                    throw new Error('当前接管模式为本地执行，不能启动远程交互会话');
                }
                if (target === 'local' && !connectionInfo.localTakeoverInitialDir) {
	                throw new Error('未配置本地初始工作目录，无法启动本地交互会话');
                }

                if (target === 'remote') {
                    if (!connectionInfo.sshStream) throw new Error('未检测到SSH交互流');
                    clearReplContinueTimers(connectionInfo);
                    clearReplWaiter(connectionInfo);
                    connectionInfo.replMode = mode;
                    connectionInfo.replTarget = 'remote';
                    connectionInfo.replBuffer = '';
                    currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: `🧩 启动远程交互会话: ${cmd}` });
                    writeRemoteProgram(connectionInfo, cmd);
                    beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
                    return;
                }

                currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: `🧩 启动本地交互会话: ${cmd}` });
                const res = startLocalInteractiveSession(connectionInfo, currentWindow, cmd, mode);
                if (!res.success) throw new Error(res.error || '启动本地交互失败');
                beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
                return;
            }

            // Actions below require an active interactive session.
            if (!connectionInfo.replMode) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: '🚫 当前没有活动的交互会话，请先 interactive_start(...)' });
                setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
                return;
            }

            const target = getActiveTarget();

            if (action === 'SEND' || action === 'LINE') {
                const payload = Buffer.from(parts[2] || '', 'base64').toString('utf-8');
                connectionInfo.replBuffer = '';
                writeInteractive(target, payload + (action === 'LINE' ? '\n' : ''));
                beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 15000 });
                return;
            }

            if (action === 'KEY') {
                const key = (parts[2] || '').toString();
                const n = Math.max(1, Math.min(50, parseInt(parts[3], 10) || 1));
                const seq = getInteractiveKeySequence(key);
                if (!seq) throw new Error(`不支持的按键: ${key}`);
                connectionInfo.replBuffer = '';
                writeInteractive(target, seq.repeat(n));
                beginReplAutoContinue(connectionInfo, currentWindow, { idleMs: 250, timeoutMs: 8000 });
                return;
            }

            if (action === 'CTRL') {
                const key = (parts[2] || '').toString();
                const seq = getInteractiveCtrlSequence(key);
                if (!seq) throw new Error(`不支持的 Ctrl 键: ${key}`);
                connectionInfo.replBuffer = '';
                writeInteractive(target, seq);
                beginReplAutoContinue(connectionInfo, currentWindow, { idleMs: 250, timeoutMs: 8000 });
                return;
            }

            if (action === 'WAIT') {
                const ms = Math.max(0, Math.min(60000, parseInt(parts[2], 10) || 0));
                clearReplContinueTimers(connectionInfo);
                if (!connectionInfo.replPendingContinue) connectionInfo.replPendingContinue = true;
                currentWindow.webContents.send('ai-takeover-update', { type: 'waiting', message: `⏳ 等待 ${ms}ms...` });
                setTimeout(() => {
                    try {
                        if (!connectionInfo.replPendingContinue) connectionInfo.replPendingContinue = true;
                        flushReplAndContinue(connectionInfo, currentWindow, 'wait');
                    } catch {}
                }, ms);
                return;
            }

            if (action === 'WAIT_FOR') {
                const needle = Buffer.from(parts[2] || '', 'base64').toString('utf-8');
                const ms = Math.max(200, Math.min(60000, parseInt(parts[3], 10) || 8000));
                startReplWaitForText(connectionInfo, currentWindow, needle, ms);
                return;
            }

            if (action === 'EXIT') {
                const mode = connectionInfo.replMode || '';
                let exitLine = 'exit';
                if (mode === 'python') exitLine = 'quit()';
                else if (mode === 'node') exitLine = '.exit';
                else if (mode === 'mysql') exitLine = 'exit';
                else if (mode === 'cli:codex' || mode === 'cli:claude' || mode === 'cli:code') exitLine = '/quit';

                connectionInfo.replBuffer = '';
                writeInteractive(target, exitLine + '\n');

                if (target === 'remote') {
                    // Remote: clear state optimistically and continue.
                    connectionInfo.replMode = null;
                    connectionInfo.replTarget = null;
                    connectionInfo.replBuffer = '';
                    clearReplContinueTimers(connectionInfo);
                    clearReplWaiter(connectionInfo);
                    setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
                } else {
                    // Local: rely on process exit handler, but also set a safety continue.
                    beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 15000 });
                }
                return;
            }

            if (action === 'STOP') {
                if (target === 'local') {
                    stopLocalInteractiveSession(connectionInfo);
                    currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '🛑 已停止本地交互会话' });
                    setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 800);
                    return;
                }
                // Remote: send Ctrl+C
                connectionInfo.replBuffer = '';
                writeInteractive('remote', '\x03');
                beginReplAutoContinue(connectionInfo, currentWindow, { idleMs: 250, timeoutMs: 8000 });
                return;
            }

            throw new Error(`未知交互指令: ${action}`);
        } catch (e) {
            currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 交互指令执行失败: ${e.message}` });
            setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
            return;
        }
    }
    
    // 内置REPL控制指令处理
    if (execTarget !== 'remote' && actionPlan.isBuiltinFunction && typeof actionPlan.builtinCommand === 'string' && actionPlan.builtinCommand.startsWith('__REPL__')) {
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'error',
            message: '🚫 REPL 只支持SSH远程交互会话，当前为本地执行。请改用本地命令或切换为远程/混合接管。'
        });
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
        return;
    }
    if (actionPlan.isBuiltinFunction && typeof actionPlan.builtinCommand === 'string' && actionPlan.builtinCommand.startsWith('__REPL__')) {
        const tag = actionPlan.builtinCommand;
        if (tag === '__REPL__:REPL_PY_START') {
            currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 进入 Python 交互模式 (REPL)...' });
            try {
                writeRemoteProgram(connectionInfo, 'python');
                connectionInfo.replMode = 'python';
                connectionInfo.replTarget = 'remote';
                connectionInfo.replBuffer = '';
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '✅ 已进入 Python REPL（请等待提示符 >>>）' });
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: '[REPL] 已进入 Python REPL。请使用 py_send(...) 与 py_exit()。' });
                buildOrUpdateContextIndex(connectionInfo);
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 进入 REPL 失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
        }
        if (tag.startsWith('__REPL__:REPL_PY_SEND:')) {
            const b64 = tag.split(':').pop();
            const line = Buffer.from(b64, 'base64').toString('utf-8');
            try {
                connectionInfo.replBuffer = '';
                connectionInfo.sshStream.write(line + '\n');
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `➡️ 已发送到REPL: ${line}` });
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 发送到REPL失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow);
            return;
        }
        if (tag === '__REPL__:REPL_PY_EXIT') {
            try {
                connectionInfo.sshStream.write('quit()\n');
                connectionInfo.replMode = null;
                connectionInfo.replTarget = null;
                connectionInfo.replBuffer = '';
                clearReplContinueTimers(connectionInfo);
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '👋 已退出 Python REPL' });
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 退出REPL失败: ${e.message}` });
            }
            setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
            return;
        }
        if (tag === '__REPL__:REPL_NODE_START') {
            currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 进入 Node 交互模式 (REPL)...' });
            try {
                writeRemoteProgram(connectionInfo, 'node');
                connectionInfo.replMode = 'node';
                connectionInfo.replTarget = 'remote';
                connectionInfo.replBuffer = '';
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '✅ 已进入 Node REPL（请等待 > 提示符）' });
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: '[REPL] 已进入 Node REPL。请使用 node_send(...) 与 node_exit()。' });
                buildOrUpdateContextIndex(connectionInfo);
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 进入 Node REPL 失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
        }
        if (tag.startsWith('__REPL__:REPL_NODE_SEND:')) {
            const b64 = tag.split(':').pop();
            const line = Buffer.from(b64, 'base64').toString('utf-8');
            try {
                connectionInfo.replBuffer = '';
                connectionInfo.sshStream.write(line + '\n');
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `➡️ 已发送到Node REPL: ${line}` });
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 发送到Node REPL失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow);
            return;
        }
        if (tag === '__REPL__:REPL_NODE_EXIT') {
            try {
                connectionInfo.sshStream.write('.exit\n');
                connectionInfo.replMode = null;
                connectionInfo.replTarget = null;
                connectionInfo.replBuffer = '';
                clearReplContinueTimers(connectionInfo);
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '👋 已退出 Node REPL' });
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 退出 Node REPL失败: ${e.message}` });
            }
            setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
            return;
        }
        if (tag.startsWith('__REPL__:REPL_MYSQL_START:')) {
            currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 进入 MySQL 客户端 (REPL)...' });
            try {
                const b64 = tag.split(':').pop();
                const conn = Buffer.from(b64, 'base64').toString('utf-8');
                writeRemoteProgram(connectionInfo, `mysql ${conn}`);
                connectionInfo.replMode = 'mysql';
                connectionInfo.replTarget = 'remote';
                connectionInfo.replBuffer = '';
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '✅ 已进入 MySQL 客户端（请等待 mysql> 提示符）' });
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: '[REPL] 已进入 MySQL 客户端。请使用 mysql_send(...) 与 mysql_exit()。' });
                buildOrUpdateContextIndex(connectionInfo);
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 进入 MySQL REPL 失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
        }
        if (tag.startsWith('__REPL__:REPL_MYSQL_SEND:')) {
            const b64 = tag.split(':').pop();
            const line = Buffer.from(b64, 'base64').toString('utf-8');
            try {
                connectionInfo.replBuffer = '';
                connectionInfo.sshStream.write(line + '\n');
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `➡️ 已发送到MySQL: ${line}` });
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 发送到MySQL失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow);
            return;
        }
        if (tag === '__REPL__:REPL_MYSQL_EXIT') {
            try {
                connectionInfo.sshStream.write('exit\n');
                connectionInfo.replMode = null;
                connectionInfo.replTarget = null;
                connectionInfo.replBuffer = '';
                clearReplContinueTimers(connectionInfo);
                currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '👋 已退出 MySQL 客户端' });
            } catch (e) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 退出 MySQL 失败: ${e.message}` });
            }
            setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
            return;
        }
    }

    // 如果当前存在交互会话，则不允许跨 target 执行普通命令（避免把本地命令误发到远端/反之）。
    if (connectionInfo.replMode) {
        const activeTarget = connectionInfo.replTarget === 'local' ? 'local' : 'remote';
        if (activeTarget !== execTarget) {
            const msg = `🚫 当前处于${activeTarget === 'local' ? '本地' : '远程'}交互会话(${connectionInfo.replMode})，不能执行${execTarget === 'local' ? '本地' : '远程'}命令。请先使用 interactive_exit()/interactive_stop()（或该程序的退出命令）退出交互会话，再继续。`;
            try {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: msg });
                connectionInfo.aiTakeoverHistory.push({ role: 'user', content: msg });
                buildOrUpdateContextIndex(connectionInfo);
            } catch {}
            setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1500);
            return;
        }
    }

    // 透明桥接：若处于 REPL 模式，当前命令被视为 REPL 输入
    try {
        if (connectionInfo.replMode && typeof command === 'string') {
            const line = command.trim();
            const replTarget = connectionInfo.replTarget === 'local' ? 'local' : 'remote';
            const writeRepl = (payload) => {
                if (replTarget === 'local') return writeToLocalInteractive(connectionInfo, payload);
                if (!connectionInfo.sshStream) throw new Error('未检测到SSH交互流');
                return connectionInfo.sshStream.write(payload);
            };
            if (connectionInfo.replMode === 'python') {
                if (/^(quit\(\)|exit\(\)|quit|exit)$/i.test(line)) {
                    writeRepl('quit()\n');
                    if (replTarget === 'remote') {
                        connectionInfo.replMode = null;
                        connectionInfo.replTarget = null;
                        connectionInfo.replBuffer = '';
                        clearReplContinueTimers(connectionInfo);
                        clearReplWaiter(connectionInfo);
                    }
                    if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '👋 已退出 Python REPL' });
                } else {
                    connectionInfo.replBuffer = '';
                    writeRepl(line + '\n');
                    if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `➡️ Python REPL: ${line}` });
                }
                if (connectionInfo.replMode) beginReplAutoContinue(connectionInfo, currentWindow);
                else setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1000);
                return;
            } else if (connectionInfo.replMode === 'node') {
                if (/^(\.exit|exit)$/i.test(line)) {
                    writeRepl('.exit\n');
                    if (replTarget === 'remote') {
                        connectionInfo.replMode = null;
                        connectionInfo.replTarget = null;
                        connectionInfo.replBuffer = '';
                        clearReplContinueTimers(connectionInfo);
                        clearReplWaiter(connectionInfo);
                    }
                    if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '👋 已退出 Node REPL' });
                } else {
                    connectionInfo.replBuffer = '';
                    writeRepl(line + '\n');
                    if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `➡️ Node REPL: ${line}` });
                }
                if (connectionInfo.replMode) beginReplAutoContinue(connectionInfo, currentWindow);
                else setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1000);
                return;
            } else if (connectionInfo.replMode === 'mysql') {
                if (/^(exit|quit|\\q)$/i.test(line)) {
                    writeRepl('exit\n');
                    if (replTarget === 'remote') {
                        connectionInfo.replMode = null;
                        connectionInfo.replTarget = null;
                        connectionInfo.replBuffer = '';
                        clearReplContinueTimers(connectionInfo);
                        clearReplWaiter(connectionInfo);
                    }
                    if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '👋 已退出 MySQL 客户端' });
                } else {
                    connectionInfo.replBuffer = '';
                    writeRepl(line + '\n');
                    if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `➡️ MySQL: ${line}` });
                }
                if (connectionInfo.replMode) beginReplAutoContinue(connectionInfo, currentWindow);
                else setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1000);
                return;
            } else if (connectionInfo.replMode && connectionInfo.replMode.startsWith('cli:')) {
                const cliName = connectionInfo.replMode.split(':')[1] || 'cli';
                if (/^\s*\/quit\s*$/i.test(line)) {
                    writeRepl('/quit\n');
                    if (replTarget === 'remote') {
                        connectionInfo.replMode = null;
                        connectionInfo.replTarget = null;
                        connectionInfo.replBuffer = '';
                        clearReplContinueTimers(connectionInfo);
                        clearReplWaiter(connectionInfo);
                    }
                    currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `👋 已退出 ${cliName} 会话` });
                } else {
                    connectionInfo.replBuffer = '';
                    writeRepl(line + '\n');
                    currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `➡️ ${cliName}: ${line}` });
                }
                if (connectionInfo.replMode) beginReplAutoContinue(connectionInfo, currentWindow);
                else setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1000);
                return;
            }
        }
    } catch (e) {
        if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ REPL发送失败: ${e.message}` });
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
        return;
    }

    // 透明桥接：若未处于 REPL，但命令是进入 REPL 的人类式写法，则自动切换为 REPL
    if (execTarget === 'remote' && connectionInfo.sshStream && typeof command === 'string') {
        const line = command.trim();
        // python3 / python: 仅在无参数或仅 -i 时进入 REPL；带脚本/参数时不拦截
        const pyMatch = /^python3?(\s*)(.*)$/i.exec(line);
        if (pyMatch) {
            const tail = (pyMatch[2] || '').trim();
            const onlyFlags = /^(-i\b)?\s*$/.test(tail);
            if (!tail || onlyFlags) {
            if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 检测到进入 Python 交互，自动切换至 REPL...' });
            try {
                writeRemoteProgram(connectionInfo, 'python');
                connectionInfo.replMode = 'python';
                connectionInfo.replTarget = 'remote';
                connectionInfo.replBuffer = '';
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: '[REPL] 已进入 Python REPL（透明桥接）。请使用 py_send(...) 与 py_exit()。' });
                buildOrUpdateContextIndex(connectionInfo);
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '✅ 已进入 Python REPL（请等待 >>> 提示符）' });
            } catch (e) {
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 进入 Python REPL 失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
            }
        }
        // node
        const nodeMatch = /^node(\s*)(.*)$/i.exec(line);
        if (nodeMatch) {
            const tail = (nodeMatch[2] || '').trim();
            const onlyFlags = /^(-i\b)?\s*$/.test(tail);
            if (!tail || onlyFlags) {
            if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 检测到进入 Node 交互，自动切换至 REPL...' });
            try {
                writeRemoteProgram(connectionInfo, 'node');
                connectionInfo.replMode = 'node';
                connectionInfo.replTarget = 'remote';
                connectionInfo.replBuffer = '';
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: '[REPL] 已进入 Node REPL（透明桥接）。请使用 node_send(...) 与 node_exit()。' });
                buildOrUpdateContextIndex(connectionInfo);
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '✅ 已进入 Node REPL（请等待 > 提示符）' });
            } catch (e) {
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 进入 Node REPL 失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
            }
        }
        // mysql ...
        if (/^mysql(\s|$)/i.test(line)) {
            if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 检测到进入 MySQL 交互，自动切换至 REPL...' });
            try {
                writeRemoteProgram(connectionInfo, line);
                connectionInfo.replMode = 'mysql';
                connectionInfo.replTarget = 'remote';
                connectionInfo.replBuffer = '';
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: '[REPL] 已进入 MySQL 客户端（透明桥接）。请使用 mysql_send(...) 与 mysql_exit()。' });
                buildOrUpdateContextIndex(connectionInfo);
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: '✅ 已进入 MySQL 客户端（请等待 mysql> 提示符）' });
            } catch (e) {
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 进入 MySQL 客户端失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
        }
        // codex / claude / code（NPM交互式工具，退出命令 /quit）
        const cliMatch = /^(codex|claude|code)(\s|$)/i.exec(line);
        if (cliMatch) {
            const cliName = cliMatch[1].toLowerCase();
            if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: `💡 检测到进入 ${cliName} 交互，自动切换至 REPL...` });
            try {
                writeRemoteProgram(connectionInfo, line);
                connectionInfo.replMode = `cli:${cliName}`;
                connectionInfo.replTarget = 'remote';
                connectionInfo.replBuffer = '';
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: `[REPL] 已进入 ${cliName}（透明桥接）。使用 '/quit' 退出；后续命令将直接写入会话。` });
                buildOrUpdateContextIndex(connectionInfo);
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'result', message: `✅ 已进入 ${cliName} 交互（请按需使用 /quit 退出）` });
            } catch (e) {
                if (currentWindow) currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 进入 ${cliName} 交互失败: ${e.message}` });
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
        }
    }

    // 本地透明桥接：避免本地执行进入交互式程序后卡死（例如 codex / python REPL）
    if (execTarget === 'local' && !connectionInfo.replMode && typeof command === 'string') {
        const line = command.trim();

        // python3 / python: 仅在无参数或仅 -i 时进入 REPL；带脚本/参数时不拦截
        const pyMatch = /^python3?(\s*)(.*)$/i.exec(line);
        if (pyMatch) {
            const tail = (pyMatch[2] || '').trim();
            const onlyFlags = /^(-i\b)?\s*$/.test(tail);
            if (!tail || onlyFlags) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 检测到本地进入 Python 交互，自动切换至本地交互会话...' });
                const res = startLocalInteractiveSession(connectionInfo, currentWindow, line, 'python');
                if (!res.success) {
                    currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 启动本地 Python 交互失败: ${res.error}` });
                    setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1500);
                    return;
                }
                beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
                return;
            }
        }

        // node
        const nodeMatch = /^node(\s*)(.*)$/i.exec(line);
        if (nodeMatch) {
            const tail = (nodeMatch[2] || '').trim();
            const onlyFlags = /^(-i\b)?\s*$/.test(tail);
            if (!tail || onlyFlags) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 检测到本地进入 Node 交互，自动切换至本地交互会话...' });
                const res = startLocalInteractiveSession(connectionInfo, currentWindow, line, 'node');
                if (!res.success) {
                    currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 启动本地 Node 交互失败: ${res.error}` });
                    setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1500);
                    return;
                }
                beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
                return;
            }
        }

        // mysql
        if (/^mysql(\s|$)/i.test(line)) {
            currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: '💡 检测到本地进入 MySQL 交互，自动切换至本地交互会话...' });
            const res = startLocalInteractiveSession(connectionInfo, currentWindow, line, 'mysql');
            if (!res.success) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 启动本地 MySQL 交互失败: ${res.error}` });
                setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1500);
                return;
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
        }

        // codex / claude / code（本地交互式CLI，退出命令 /quit）
        const cliMatch = /^(codex|claude|code)(\s|$)/i.exec(line);
        if (cliMatch) {
            const cliName = cliMatch[1].toLowerCase();
            currentWindow.webContents.send('ai-takeover-update', { type: 'executing', message: `💡 检测到本地进入 ${cliName} 交互，自动切换至本地交互会话...` });
            const res = startLocalInteractiveSession(connectionInfo, currentWindow, line, `cli:${cliName}`);
            if (!res.success) {
                currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ 启动本地 ${cliName} 交互失败: ${res.error}` });
                setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1500);
                return;
            }
            beginReplAutoContinue(connectionInfo, currentWindow, { timeoutMs: 20000 });
            return;
        }
    }
    // MCP 内置指令处理（自动检索细节）
    if (actionPlan.isBuiltinFunction && typeof actionPlan.builtinCommand === 'string' && actionPlan.builtinCommand.startsWith('__MCP__')) {
        try {
            const tag = actionPlan.builtinCommand;
            if (tag.startsWith('__MCP__:EXPAND:')) {
                const parts = tag.split(':');
                const sid = parts[2] || '';
                const keywords = Buffer.from(parts[3] || '', 'base64').toString('utf-8');
                const g = connectionInfo.contextGraph;
                const node = g?.nodes?.[sid];
                if (!node || node.type !== 'summary') {
                    currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ MCP展开失败：无效的摘要ID ${sid}` });
                } else {
                    // 找到子消息内容
                    const children = node.children || [];
                    const lines = [];
                    for (const childId of children) {
                        // 映射回原始历史索引
                        const idx = (g.historyNodeIds || []).findIndex(id => id === childId);
                        if (idx >= 0) {
                            const m = connectionInfo.aiTakeoverHistory[idx];
                            if (!m) continue;
                            const text = m.content || '';
                            if (keywords && !text.includes(keywords)) continue;
                            lines.push(`[#${idx} ${m.role}] ${text}`);
                        }
                    }
                    const pack = lines.length ? lines.join('\n\n') : '(无匹配内容)';
                    const injected = `MCP展开详情(${sid}${keywords?`, 关键字: ${keywords}`:''})\n\n${pack}`;
                    // 注入到历史，便于下一次调用直接可见
                    connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: injected });
                    buildOrUpdateContextIndex(connectionInfo);
                    currentWindow.webContents.send('ai-takeover-update', { type: 'analysis', message: `📂 已展开摘要 ${sid}，获得 ${lines.length} 条相关详情` });
                }
            } else if (tag.startsWith('__MCP__:FETCH:')) {
                const parts = tag.split(':');
                const s = parseInt(parts[2], 10), e = parseInt(parts[3], 10);
                const hist = connectionInfo.aiTakeoverHistory || [];
                const start = Math.max(0, Math.min(s, e));
                const end = Math.min(hist.length - 1, Math.max(s, e));
                const lines = [];
                for (let i = start; i <= end; i++) {
                    const m = hist[i];
                    lines.push(`[#${i} ${m.role}] ${m.content}`);
                }
                const injected = `MCP区间抓取 [#${start}..#${end}]\n\n${lines.join('\n\n')}`;
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: injected });
                buildOrUpdateContextIndex(connectionInfo);
                currentWindow.webContents.send('ai-takeover-update', { type: 'analysis', message: `📂 已抓取区间 [#${start}..#${end}]，共 ${lines.length} 条` });
            } else if (tag.startsWith('__MCP__:SEARCH:')) {
                const parts = tag.split(':');
                const query = Buffer.from(parts[2] || '', 'base64').toString('utf-8');
                const lim = parseInt(parts[3], 10) || 20;
                const hist = connectionInfo.aiTakeoverHistory || [];
                const results = [];
                const q = (query || '').toLowerCase();
                for (let i = hist.length - 1; i >= 0 && results.length < lim; i--) {
                    const m = hist[i];
                    const text = (m.content || '').toLowerCase();
                    const pos = text.indexOf(q);
                    if (pos !== -1) {
                        const raw = m.content || '';
                        const st = Math.max(0, pos - 60);
                        const ed = Math.min(raw.length, pos + query.length + 60);
                        const snippet = raw.slice(st, ed).replace(/\n/g, ' ');
                        results.push({ index: i, role: m.role, snippet });
                    }
                }
                const injected = `MCP搜索: "${query}" 结果${results.length}条\n\n` + results.map(r => `[#${r.index} ${r.role}] ${r.snippet}`).join('\n');
                connectionInfo.aiTakeoverHistory.push({ role: 'assistant', content: injected });
                buildOrUpdateContextIndex(connectionInfo);
                currentWindow.webContents.send('ai-takeover-update', { type: 'analysis', message: `🔎 已自动检索历史（${results.length}条）并注入上下文` });
            }
        } catch (e) {
            currentWindow.webContents.send('ai-takeover-update', { type: 'error', message: `❌ MCP处理失败: ${e.message}` });
        }
        setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 1200);
        return;
    }

    // 发送执行信息
    connectionInfo.currentExecStart = Date.now();
    currentWindow.webContents.send('ai-takeover-update', {
        type: 'executing',
        message: `⚡ 执行${execTarget === 'local' ? '本地' : '远程'}命令: ${command.length > 100 ? command.substring(0, 100) + '...' : command}\n目的: ${purpose}\n预期结果: ${expectation}`
    });

    // 本地执行路径
    if (execTarget === 'local') {
        try {
            const res = await executeLocalShellCommand(connectionInfo, command);
            const elapsed = connectionInfo.currentExecStart ? Math.round((Date.now() - connectionInfo.currentExecStart) / 1000) : null;

            const resultMessage = (res.output || '').trim() || '命令执行完成（无输出）';
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'result',
                message: `📤 执行结果:\n${resultMessage}${elapsed != null ? `\n⏱️ 执行用时: ${elapsed}s` : ''}`
            });

            // 记录到历史（让模型看到输出）
            const shownType = actionPlan.isBuiltinFunction ? 'local-builtin' : 'local';
            connectionInfo.aiTakeoverHistory.push(
                { role: 'assistant', content: `${analysis}\n\`\`\`${shownType}\n${ori_command || command}\n\`\`\`\n${purpose}`.trim() },
                { role: 'user', content: `你的命令执行结果: ${res.output || '无输出'}` }
            );
            buildOrUpdateContextIndex(connectionInfo);

            setTimeout(() => {
                executeAiTakeoverStep(connectionInfo, currentWindow);
            }, 1500);
        } catch (e) {
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'result',
                message: `❌ 本地命令执行失败: ${e.message}`
            });
            connectionInfo.aiTakeoverHistory.push(
                { role: 'assistant', content: `\`\`\`local\n${ori_command || command}\n\`\`\`` },
                { role: 'user', content: `你的命令执行失败: ${e.message}` }
            );
            buildOrUpdateContextIndex(connectionInfo);
            setTimeout(() => executeAiTakeoverStep(connectionInfo, currentWindow), 2000);
        }
        return;
    }

    // 直传优先：通过交互会话执行，并用标记采集输出
    if (connectionInfo.executeMode === 'direct' && connectionInfo.sshStream) {
        // 忙碌保护：避免并发直传导致采集错乱
        if (connectionInfo.directCapture && !connectionInfo.directCapture.done) {
            currentWindow.webContents.send('ai-takeover-update', {
                type: 'error',
                message: '⏳ 正在等待上一条命令完成...' 
            });
            setTimeout(() => executeAiCommand(connectionInfo, currentWindow, actionPlan), 800);
            return;
        }
        try {
            const id = Date.now().toString(36);
            const cap = {
                id,
                beginToken: `__AITERM_BEGIN__${id}__`,
                endToken: `__AITERM_END__${id}__`,
                buffer: '',
                collected: '',
                gotBegin: false,
                done: false,
                exitCode: undefined,
            };
            connectionInfo.directCapture = cap;
            // 使用非交互子shell避免提示符与括号粘贴控制序列污染
            // 同时预先展开 ~，避免因双引号抑制 ~ 扩展而失败
            let expandedDirect = command;
            try {
                if (typeof expandedDirect === 'string' && expandedDirect.includes('~')) {
                    expandedDirect = await expandTildeInCommand(expandedDirect, connectionInfo.sshConnection);
                }
            } catch {}
            if (!ownsTabConnection(currentWindow, connectionInfo) || connectionInfo.sshStream !== executingSshStream ||
                connectionInfo.sshConnection !== executingSshConnection ||
                (pluginLease && !getPluginManager().isCurrent(connectionInfo.pluginIds, pluginLease.pluginId, pluginLease.digest, pluginLease.activation))) {
                if (connectionInfo.directCapture === cap) connectionInfo.directCapture = null;
                return;
            }
            const notifyConfig = getWindowStateForConnectionInfo(connectionInfo)?.webhookConfig;
            if (notifyConfig?.enabled && notifyConfig.events.includes('program_stopped')) {
                const observer = observeProgram(connectionInfo, 'remote', 'ai-command', command);
                executingSshStream.programMonitor?.close('connection_lost');
                executingSshStream.programMonitor = new ProgramMarkers(observer.id, observer);
                expandedDirect = monitoredCommand(expandedDirect, observer.id);
            }
            const wrapped = wrapDirectCommand(expandedDirect, cap.beginToken, cap.endToken);
            executingSshStream.write(wrapped + '\n');
            return;
        } catch (e) {
            console.warn('Direct execute failed, fallback to exec:', e.message);
        }
    }

    // exec 模式回退：在 tracked 目录中执行（先展开 ~，避免 "~" 被引号阻止展开）
    const expanded = await expandTildeInCommand(command, connectionInfo.sshConnection);
    const cwdRaw = connectionInfo.currentWorkingDirectory || "~";
    let cwdExpanded = cwdRaw;
    try {
        if (cwdRaw.startsWith('~')) {
            cwdExpanded = await expandTildePath(cwdRaw, connectionInfo.sshConnection);
        }
    } catch {}
    if (!ownsTabConnection(currentWindow, connectionInfo) || connectionInfo.sshConnection !== executingSshConnection ||
        (pluginLease && !getPluginManager().isCurrent(connectionInfo.pluginIds, pluginLease.pluginId, pluginLease.digest, pluginLease.activation))) return;
    const fullCommand = `cd ${quotePosix(cwdExpanded)} && ${expanded}`;
    const observer = observeProgram(connectionInfo, 'remote', 'ai-command', command);
    console.log(`在远程目录执行命令，目录长度: ${cwdExpanded.length}，命令长度: ${expanded.length}`);

    return new Promise((resolve) => {
        connectionInfo.currentExecStart = Date.now();
        connectionInfo.sshConnection.exec(fullCommand, (err, stream) => {
            if (err) {
                observer.stop({ error: err.message });
                const errorMsg = `命令执行失败: ${err.message}`;
                currentWindow.webContents.send('ai-takeover-update', {
                    type: 'result',
                    message: `❌ ${errorMsg}`
                });
                
                // 记录到历史
                connectionInfo.aiTakeoverHistory.push(
                    { role: "assistant", content: `\`\`\`${commandType}\\n${ori_command}\\n\`\`\`` },
                    { role: "user", content: `你的命令执行失败: ${err.message}` }
                );
                
                // 继续下一步
                setTimeout(() => {
                    executeAiTakeoverStep(connectionInfo, currentWindow);
                }, 2000);
                
                resolve();
                return;
            }
            
            let output = '';
            let errorOutput = '';
            
            stream.on('data', (data) => {
                observer.output(data);
                output += data.toString();
            });
            
            stream.stderr.on('data', (data) => {
                observer.output(data);
                errorOutput += data.toString();
            });
            
            stream.on('error', error => observer.stop({ error: error.message, reason: 'connection_lost' }));
            stream.on('close', (code, signal) => {
                observer.stop({ exitCode: code, signal, reason: code == null && !signal ? 'connection_lost' : '' });
                const fullOutput = output + errorOutput;
                connectionInfo.lastTerminalOutput = fullOutput;
                
                // 更新当前目录（如果命令可能改变目录）
                if (command.includes('cd ')) {
                    trackDirectoryChanges(fullOutput, connectionInfo);
                }
                
        // 发送执行结果
        const resultMessage = fullOutput.trim() || '命令执行完成（无输出）';
        currentWindow.webContents.send('ai-takeover-update', {
            type: 'result',
            message: `📤 执行结果:\n${resultMessage}${connectionInfo.currentExecStart ? `\n⏱️ 执行用时: ${Math.round((Date.now()-connectionInfo.currentExecStart)/1000)}s` : ''}`
        });
        
        // 记录到历史
        connectionInfo.aiTakeoverHistory.push(
            { role: "assistant", content: `${analysis}\n\`\`\`${commandType}\n${ori_command}\n\`\`\`\n${purpose}` },
            { role: "user", content: `你的命令执行结果: ${fullOutput || '无输出'}` }
        );
        buildOrUpdateContextIndex(connectionInfo);
                
                // 继续下一步
                setTimeout(() => {
                    executeAiTakeoverStep(connectionInfo, currentWindow);
                }, 1500);
                
                resolve();
            });
        });
    });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let webhookQuitReady = false, webhookQuitPending = false;
app.on('before-quit', event => {
    if (webhookQuitReady) return;
    for (const state of windowConnections.values()) for (const owner of state.tabs.values()) disposeTabConnectionInfo(owner);
    pluginRuntime?.close();
    if (!pendingWebhookDeliveries.size) return;
    event.preventDefault();
    if (webhookQuitPending) return;
    webhookQuitPending = true;
    const deadline = setTimeout(finish, 3000);
    function finish() { if (webhookQuitReady) return; webhookQuitReady = true; clearTimeout(deadline); app.quit(); }
    Promise.allSettled([...pendingWebhookDeliveries]).then(finish);
});
app.whenReady().then(async () => {
    if (process.env.AITERMINAL_PLUGIN_RUNTIME_SMOKE !== '1') return;
    try { await require('./lib/pluginDiagnostics').verifyPackagedPluginHost(); console.log('AITERM_PLUGIN_HOST_READY'); }
    catch (error) { console.error('AITERM_PLUGIN_HOST_FAILED:', error.message); }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
