const { contextBridge, ipcRenderer, webUtils } = require('electron');

let activeTabId = 'tab-1';
const aiStreamListeners = new Map();
const aiTakeoverListeners = new Map();

function getActiveTabId() {
    return activeTabId;
}

function resolveTabId(tabId) {
    const value = typeof tabId === 'string' ? tabId.trim() : '';
    if (!value && (tabId === undefined || tabId === null)) return getActiveTabId();
    if (!value || value.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(value)) return '';
    return value;
}

function boundedText(value, maxLength = 200000) {
    if (typeof value !== 'string') return '';
    return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function boundedConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
    return { ...config };
}

function setActiveTabId(tabId) {
    const value = typeof tabId === 'string' ? tabId.trim() : '';
    if (!value || value.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(value)) return false;
    activeTabId = value;
    ipcRenderer.send('tab-active', value);
    return true;
}

contextBridge.exposeInMainWorld('electronAPI', {
    setActiveTab: (tabId) => setActiveTabId(tabId),
    openTabSession: (tabId) => ipcRenderer.invoke('tab-open', { tabId: resolveTabId(tabId) }),
    closeTabSession: (tabId) => ipcRenderer.invoke('tab-close', { tabId: resolveTabId(tabId) }),

    // SSH Connection and data flow
    sshResize: (cols, rows, tabId) => ipcRenderer.invoke('ssh:resize', { cols, rows, tabId: resolveTabId(tabId) }),
    sshConnect: (config, tabId) => ipcRenderer.invoke('ssh-connect', { ...boundedConfig(config), tabId: resolveTabId(tabId) }),
    sshDisconnect: (tabId) => ipcRenderer.invoke('ssh-disconnect', resolveTabId(tabId)),
    sshSendRaw: (command, tabId, encoding) => ipcRenderer.invoke('ssh-send-raw', { command: boundedText(command, 200000), tabId: resolveTabId(tabId), encoding }),
    onSshOutput: (callback) => ipcRenderer.on('ssh-output', (_event, value) => callback(value)),
    onSshDisconnected: (callback) => ipcRenderer.on('ssh-disconnected', (_event, value) => callback(value)),

    // Local terminal data flow (real local shell/PTY per tab)
    terminalLocalStart: (options) => {
        const payload = boundedConfig(options);
        payload.tabId = resolveTabId(payload.tabId);
        return ipcRenderer.invoke('terminal-local-start', payload);
    },
    terminalLocalSend: (tabId, data, encoding) => ipcRenderer.invoke('terminal-local-send', { tabId: resolveTabId(tabId), data: boundedText(data, 200000), encoding }),
    terminalLocalResize: (tabId, cols, rows) => ipcRenderer.invoke('terminal-local-resize', { tabId: resolveTabId(tabId), cols, rows }),
    terminalLocalStop: (tabId) => ipcRenderer.invoke('terminal-local-stop', { tabId: resolveTabId(tabId) }),
    terminalExecuteAudited: (command, tabId) => ipcRenderer.invoke('terminal-execute-audited', { tabId: resolveTabId(tabId), command: boundedText(command, 200000) }),
    terminalRunNotified: (command, tabId) => typeof command !== 'string' || command.length > 16000
        ? Promise.resolve({ success: false, error: '监控命令必须为文本且不超过 16000 字符' })
        : ipcRenderer.invoke('terminal-execute-audited', { tabId: resolveTabId(tabId), command, notifyOnExit: true }),
    onTerminalLocalOutput: (callback) => ipcRenderer.on('terminal-local-output', (_event, value) => callback(value)),
    onTerminalLocalExit: (callback) => ipcRenderer.on('terminal-local-exit', (_event, value) => callback(value)),
    onTerminalScreenRequest: (callback) => ipcRenderer.on('terminal-screen-request', (_event, value) => callback(value)),
    terminalScreenReply: (payload) => ipcRenderer.send('terminal-screen-reply', boundedConfig(payload)),
    removeTerminalLocalListeners: () => {
        ipcRenderer.removeAllListeners('terminal-local-output');
        ipcRenderer.removeAllListeners('terminal-local-exit');
    },

    clipboardWriteText: (text, tabId) => ipcRenderer.invoke('clipboard-write-text', {
        tabId: resolveTabId(tabId),
        text: boundedText(text, 2 * 1024 * 1024)
    }),
    clipboardReadText: (tabId) => ipcRenderer.invoke('clipboard-read-text', { tabId: resolveTabId(tabId) }),

    // Special Commands and File Operations
    getPathForFile: (file) => webUtils.getPathForFile(file),
    sshExecuteSpecial: (command, args, tabId) => ipcRenderer.invoke('ssh-execute-special', boundedText(command, 200), Array.isArray(args) ? args.slice(0, 100).map((arg) => boundedText(arg, 20000)) : [], resolveTabId(tabId)),
    sshExecuteSpecialStreaming: (command, args, tabId) => ipcRenderer.invoke('ssh-execute-special-streaming', boundedText(command, 200), Array.isArray(args) ? args.slice(0, 100).map((arg) => boundedText(arg, 20000)) : [], resolveTabId(tabId)),
    sshGetCurrentPath: (tabId) => ipcRenderer.invoke('ssh-get-current-path', resolveTabId(tabId)),
    sshDownloadAndOpen: (remotePath, tabId) => ipcRenderer.invoke('ssh-download-and-open', remotePath, resolveTabId(tabId)),
    sshListTerminalFiles: (tabId) => ipcRenderer.invoke('ssh-terminal-files', resolveTabId(tabId)),
    sshDownloadFile: (remotePath, tabId, linkToken) => ipcRenderer.invoke('ssh-download-file', remotePath, resolveTabId(tabId), linkToken),
    sshDragUpload: (localPaths, tabId) => ipcRenderer.invoke('ssh-drag-upload', localPaths, resolveTabId(tabId)),

    // AI Testing and Streaming
    aiConfigure: (config, tabId) => ipcRenderer.invoke('ai-configure', boundedConfig(config), resolveTabId(tabId)),
    aiTestConnection: (config, tabId) => ipcRenderer.invoke('ai-test-connection', boundedConfig(config), resolveTabId(tabId)),
    aiChatWithoutTerm: (input, isStreaming, tabId) => ipcRenderer.invoke('ai-chat-without-term', boundedText(input), isStreaming === true, resolveTabId(tabId)),
    onAiStreamUpdate: (callback) => {
        const wrapped = (_event, value) => callback(value);
        aiStreamListeners.set(callback, wrapped);
        ipcRenderer.on('ai-stream-update', wrapped);
    },
    removeAiStreamListener: (callback) => {
        if (callback && aiStreamListeners.has(callback)) {
            ipcRenderer.removeListener('ai-stream-update', aiStreamListeners.get(callback));
            aiStreamListeners.delete(callback);
            return;
        }
        for (const wrapped of aiStreamListeners.values()) ipcRenderer.removeListener('ai-stream-update', wrapped);
        aiStreamListeners.clear();
    },

    // AI Takeover Mode
    aiTakeoverStart: (task, tabId) => ipcRenderer.invoke('ai-takeover-start', { ...(typeof task === 'object' ? task : { task }), tabId: resolveTabId(tabId) }),
    aiTakeoverStop: (tabId) => ipcRenderer.invoke('ai-takeover-stop', resolveTabId(tabId)),
    aiTakeoverContinue: (userResponse, tabId) => ipcRenderer.invoke('ai-takeover-continue', userResponse, resolveTabId(tabId)),
    aiTakeoverResume: (newInstruction, tabId) => ipcRenderer.invoke('ai-takeover-resume', newInstruction, resolveTabId(tabId)),
    aiTakeoverRetry: (tabId) => ipcRenderer.invoke('ai-takeover-retry', resolveTabId(tabId)),
    aiTakeoverCompressContext: (tabId) => ipcRenderer.invoke('ai-takeover-compress-context', resolveTabId(tabId)),
    onAiTakeoverUpdate: (callback) => {
        const wrapped = (_event, value) => callback(value);
        aiTakeoverListeners.set(callback, wrapped);
        ipcRenderer.on('ai-takeover-update', wrapped);
    },
    removeAiTakeoverListener: (callback) => {
        if (callback && aiTakeoverListeners.has(callback)) {
            ipcRenderer.removeListener('ai-takeover-update', aiTakeoverListeners.get(callback));
            aiTakeoverListeners.delete(callback);
            return;
        }
        for (const wrapped of aiTakeoverListeners.values()) ipcRenderer.removeListener('ai-takeover-update', wrapped);
        aiTakeoverListeners.clear();
    },

    // Model direct interaction with terminal
    aiDirectSend: (command, options = {}, tabId) => ipcRenderer.invoke('ai-direct-send', { ...boundedConfig(options), command: boundedText(command), tabId: resolveTabId(tabId) }),
	secureMigrateConfigs: (configs) => ipcRenderer.invoke('secure-migrate-configs', { configs: Array.isArray(configs) ? configs.slice(0, 100).map(boundedConfig) : [] }),
	secureSecretStatus: (config) => ipcRenderer.invoke('secure-secret-status', boundedConfig(config)),
    // Switch takeover execution mode: 'direct' or 'exec'
    aiSetExecuteMode: (mode, tabId) => ipcRenderer.invoke('ai-set-execute-mode', mode, resolveTabId(tabId)),

    // AI上下文/搜索/MCP
    aiContextSearch: (query, limit = 20, tabId) => ipcRenderer.invoke('ai-context-search', { query, limit, tabId: resolveTabId(tabId) }),
    aiContextGetIndex: (tabId) => ipcRenderer.invoke('ai-context-index', resolveTabId(tabId)),
    aiContextExpand: (summaryId, keywords, tabId) => ipcRenderer.invoke('ai-context-expand', { summaryId, keywords, tabId: resolveTabId(tabId) }),
    aiContextSummaryDetails: (summaryId, offset = 0, limit = 50, tabId) => ipcRenderer.invoke('ai-context-summary-details', { summaryId, offset, limit, tabId: resolveTabId(tabId) }),
    aiContextGetMessage: (index, tabId) => ipcRenderer.invoke('ai-context-get-message', { index, tabId: resolveTabId(tabId) }),
	    aiClearHistory: (tabId) => ipcRenderer.invoke('ai-clear-history', resolveTabId(tabId)),

    webhookConfigure: (config) => ipcRenderer.invoke('webhook-configure', { config, tabId: getActiveTabId() }),
    webhookTest: (config) => ipcRenderer.invoke('webhook-test', { config, tabId: getActiveTabId() }),
    webhookGetConfig: () => ipcRenderer.invoke('webhook-get-config', { tabId: getActiveTabId() }),

    pluginsList: (tabId) => ipcRenderer.invoke('plugins-list', { tabId: resolveTabId(tabId) }),
    pluginsPreview: (source, tabId) => ipcRenderer.invoke('plugins-preview', { ...boundedConfig(source), tabId: resolveTabId(tabId) }),
    pluginsInstall: (token, tabId) => ipcRenderer.invoke('plugins-install', { token, tabId: resolveTabId(tabId) }),
    pluginsEnable: (id, enabled, tabId) => ipcRenderer.invoke('plugins-enable', { id, enabled, tabId: resolveTabId(tabId) }),
    pluginsDefault: (id, enabled, tabId) => ipcRenderer.invoke('plugins-default', { id, enabled, tabId: resolveTabId(tabId) }),
    pluginsUninstall: (id, tabId) => ipcRenderer.invoke('plugins-uninstall', { id, tabId: resolveTabId(tabId) }),
    pluginsRun: (id, actionId, tabId) => ipcRenderer.invoke('plugins-run', { id, actionId, tabId: resolveTabId(tabId) }),
    pluginsTool: (id, toolId, params, tabId) => ipcRenderer.invoke('plugins-tool', { id, toolId, params: boundedConfig(params), tabId: resolveTabId(tabId) }),
    pluginsCancel: (taskId, tabId) => ipcRenderer.invoke('plugins-cancel', { taskId, tabId: resolveTabId(tabId) }),
    pluginsConfig: (id, scope, config, tabId) => ipcRenderer.invoke('plugins-config', { id, scope, config: boundedConfig(config), tabId: resolveTabId(tabId) }),
    pluginsModel: (id, modelId, tabId) => ipcRenderer.invoke('plugins-model', { id, modelId, tabId: resolveTabId(tabId) }),
    pluginsSources: (sources, tabId) => ipcRenderer.invoke('plugins-sources', { sources, tabId: resolveTabId(tabId) }),
    pluginsCatalog: (tabId) => ipcRenderer.invoke('plugins-catalog', { tabId: resolveTabId(tabId) }),
    onPluginsChanged: (callback) => { const listener = () => callback(); ipcRenderer.on('plugins-changed', listener); return () => ipcRenderer.removeListener('plugins-changed', listener); },
    onMenuPluginCenter: (callback) => ipcRenderer.on('menu-plugin-center', () => callback()),

    // Menu Events
    onMenuNewConnection: (callback) => ipcRenderer.on('menu-new-connection', () => callback()),
    onMenuNewTab: (callback) => ipcRenderer.on('menu-new-tab', () => callback()),
    onMenuDisconnect: (callback) => ipcRenderer.on('menu-disconnect', () => callback()),
    onMenuClearTerminal: (callback) => ipcRenderer.on('menu-clear-terminal', () => callback()),
    onMenuResetTerminal: (callback) => ipcRenderer.on('menu-reset-terminal', () => callback()),
    onMenuAiConfig: (callback) => ipcRenderer.on('menu-ai-config', () => callback()),
    onMenuTestAi: (callback) => ipcRenderer.on('menu-test-ai', () => callback()),
    onMenuClearAiHistory: (callback) => ipcRenderer.on('menu-clear-ai-history', () => callback()),
    onMenuUploadFiles: (callback) => ipcRenderer.on('menu-upload-files', (_event, payload) => callback(payload)),
    onMenuDownloadFile: (callback) => ipcRenderer.on('menu-download-file', (_event, payload) => callback(payload)),
    onMenuSaveSession: (callback) => ipcRenderer.on('menu-save-session', () => callback()),
    onMenuLoadSession: (callback) => ipcRenderer.on('menu-load-session', () => callback()),
    onMenuSystemMonitor: (callback) => ipcRenderer.on('menu-system-monitor', () => callback()),
    onMenuPortScan: (callback) => ipcRenderer.on('menu-port-scan', () => callback()),
    onMenuHelpGuide: (callback) => ipcRenderer.on('menu-help-guide', () => callback()),
    onMenuAiHelp: (callback) => ipcRenderer.on('menu-ai-help', () => callback()),
    
    // SSH私钥文件选择
    selectPrivateKeyFile: () => ipcRenderer.invoke('select-private-key-file'),
});
