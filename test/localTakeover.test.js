'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function declaration(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function fixture(options = {}) {
    const handlers = new Map(), window = { webContents: { send() {} } }, owner = { tabId: 'tab-1', localCommandControllers: new Set(), aiTakeoverHistory: [] };
    const environment = { platform: 'linux', label: 'WSL Ubuntu', shell: 'posix', shellFile: '/bin/bash', wsl: { file: 'wsl.exe', distro: 'Ubuntu' } };
    const terminal = { active: true, environment, cwd: '/home/user/project' };
    owner.localTerminalContext = terminal;
    const sessions = new Map([['tab-1', terminal]]), dialogs = [];
    const context = vm.createContext({
        console, Symbol, process: { platform: 'win32' }, os: { homedir: () => 'C:\\Users\\wrong' },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getWindow: () => window, getWindowConnectionInfo: () => owner,
        getWindowForConnectionInfo: () => window, ownsTabConnection: () => !owner.closed,
        getLocalTerminalMap: () => sessions, getAiConfig: () => ({ apiKey: 'fixture-only' }),
        terminalDirectory: async (session, requested, valid) => { assert.equal(session, terminal); assert.equal(valid(), true); assert.equal(requested, null); return '/home/user/project'; },
        dialog: { showMessageBox: async (_window, params) => { dialogs.push(params); options.onConsent?.(owner, sessions); return { response: 1 }; } },
        stopLocalInteractiveSession() {}, clearReplContinueTimers() {}, clearReplWaiter() {}, createEmptyContextGraph: () => ({}), buildOrUpdateContextIndex() {},
        setTimeout() {}, cancelAiRequests() {}
    });
    vm.runInContext(declaration('function revokeLocalTakeover(', 'function stopAllLocalTerminalSessions(') +
        declaration('function capturePluginBinding(', 'function getPluginRuntime(') +
        declaration("ipcMain.handle('ai-takeover-start'", "ipcMain.handle('ai-takeover-stop'"), context);
    return { owner, terminal, sessions, environment, dialogs, context, start: () => handlers.get('ai-takeover-start')({}, { task: 'inspect', target: 'local' }) };
}
test('real takeover IPC binds the visible Windows WSL shell and Linux cwd, including plugin services', async () => {
    const f = fixture(); assert.equal((await f.start()).success, true);
    assert.equal(f.owner.localTakeoverBinding.environment, f.environment);
    assert.equal(f.owner.localWorkingDirectory, '/home/user/project');
    assert.match(f.dialogs[0].message, /WSL Ubuntu/); assert.match(f.dialogs[0].detail, /\/home\/user\/project/);
    const plugin = f.context.capturePluginBinding(f.owner, { mode: 'takeover', target: 'local' });
    assert.equal(plugin.environment, f.environment); assert.equal(plugin.shell, 'posix'); assert.equal(plugin.cwd, '/home/user/project'); assert.equal(plugin.valid(), true);
    f.sessions.set('tab-1', { active: true, environment: f.environment });
    assert.equal(f.owner.localTakeoverBinding.valid(), false); assert.equal(plugin.valid(), false);
});
test('takeover confirmation cannot bind a replaced terminal or fall back to host directories', async () => {
    const f = fixture({ onConsent: (_owner, sessions) => sessions.set('tab-1', { active: true }) });
    const result = await f.start(); assert.equal(result.success, false); assert.match(result.error, /变化/); assert.equal(f.owner.localTakeoverBinding, undefined);
    const closed = fixture(); closed.terminal.active = false;
    assert.equal((await closed.start()).success, false); assert.equal(closed.dialogs.length, 0);
});
test('closing the owning local terminal invalidates takeover and aborts its running commands', async () => {
    const f = fixture(); await f.start();
    const controller = new AbortController(); f.owner.localCommandControllers.add(controller);
    f.context.revokeLocalTakeover(f.owner, {}); assert.equal(controller.signal.aborted, false);
    f.context.revokeLocalTakeover(f.owner, f.terminal);
    assert.equal(controller.signal.aborted, true); assert.equal(f.owner.localTakeoverBinding, null); assert.equal(f.owner.aiTakeoverMode, false);
});

test('switching provider endpoints never reuses the previous API key', () => {
    const config = { baseUrl: 'https://old.example/v1', apiKey: 'previous-provider-fixture' };
    const context = vm.createContext({
        getAiConfig: () => config, apiSecretScope: value => value, loadStoredSecrets: () => ({}),
        normalizeApiFormat: require('../lib/aiProtocol').normalizeApiFormat, validateAiConfig: value => value
    });
    vm.runInContext(declaration('function applyAiConfig(', '// 获取窗口状态的辅助函数'), context);
    context.applyAiConfig({}, { aiBaseUrl: 'https://new.example/v1/messages', aiApiFormat: 'messages' });
    assert.equal(config.apiKey, null); assert.equal(config.apiFormat, 'messages');
    context.applyAiConfig({}, { aiApiKey: 'new-provider-fixture', aiBaseUrl: config.baseUrl, aiApiFormat: 'messages' });
    assert.equal(config.apiKey, 'new-provider-fixture');
});
