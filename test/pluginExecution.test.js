'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { PluginManager } = require('../lib/pluginManager');
const { parsePluginCall, parsePluginToolCall } = require('../lib/pluginManifest');
const { auditCommand } = require('../lib/securityAudit');
const { createProgramObserver, ProgramMarkers, monitoredCommand } = require('../lib/terminalNotifications');
const { normalizeWebhookConfig } = require('../lib/webhook');

test('text-only plugin model requests cannot acquire takeover tools', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const begin = source.indexOf('function getPluginRuntime() {'), end = source.indexOf('\nasync function pluginModelTools(', begin);
    let toolRequests = 0;
    const context = vm.createContext({
        pluginRuntime: null, PluginRuntime: class { constructor(options) { Object.assign(this, options); } },
        createPluginServices: options => options, capturePluginBinding() {}, getNodePty() {}, getPluginManager: () => ({}),
        validateAiConfig: value => value, getAiConfig: () => ({ model: 'fixture' }),
        requestChat: async options => options,
        pluginModelTools: async () => { toolRequests++; return { tools: ['must not appear in a story'], onToolCall() {} }; }
    });
    const runtime = vm.runInContext(source.slice(begin, end) + '\ngetPluginRuntime();', context);
    const owner = { aiTakeoverMode: true }, task = { signal: new AbortController().signal };
    const plain = await runtime.service.model(owner, { messages: [], allowTools: false }, task);
    assert.equal(toolRequests, 0); assert.equal(plain.tools, undefined); assert.equal(plain.onToolCall, undefined);
    await runtime.service.model(owner, { messages: [] }, task);
    assert.equal(toolRequests, 1, 'existing adapters retain their default behavior');
});

// Run the actual main-process dispatch function with an in-memory terminal.
// No shell is started and destructive command text is never executed.
function setup(t, confirm) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-plugin-execute-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manager = new PluginManager({ filePath: path.join(root, 'plugins.json') });
    manager.install({ schemaVersion: 1, id: 'test.execution', name: 'Test', version: '1.0.0', description: 'Test execution', author: 'Test', license: 'Apache-2.0', actions: [
        { id: 'read', title: 'Read', commands: { posix: 'uname -a' } },
        { id: 'danger', title: 'Danger', commands: { posix: 'rm -rf /tmp/plugin-fixture' } }
    ] }, 'file:test');
    const writes = [], audits = [], notifications = [], tab = { tabId: 'tab-1', pluginIds: new Set(['test.execution']) };
    const settings = normalizeWebhookConfig({ enabled: true, events: ['program_stopped'] });
    const backend = { active: true, pty: { write: data => writes.push(data) } };
    const sessions = new Map([['tab-1', backend]]);
    let owned = true;
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const begin = source.indexOf('async function executeAuditedTerminal(');
    const end = source.indexOf("\nipcMain.handle('terminal-execute-audited'", begin);
    assert.ok(begin >= 0 && end > begin);
    const context = vm.createContext({
        parsePluginCall, parsePluginToolCall, auditCommand, normalizeTabId: id => /^tab-\d+$/.test(id) ? id : null,
        getWindowConnectionInfo: () => tab, getWindow: () => ({}), ownsTabConnection: () => owned,
        getLocalTerminalMap: () => sessions, getPluginManager: () => manager,
        getWindowStateForConnectionInfo: () => ({ webhookConfig: settings }), ProgramMarkers, monitoredCommand,
        observeProgram: (_owner, target, source, command) => createProgramObserver({ config: () => settings, emit: (event, data) => notifications.push({ event, ...data }), target, source, command }),
        confirmAuditedCommand: async (_win, _tab, command, audit) => { audits.push({ command, audit }); return confirm ? confirm(tab, sessions) : true; }
    });
    const execute = vm.runInContext(source.slice(begin, end) + '\nexecuteAuditedTerminal;', context);
    return { execute, tab, manager, writes, audits, notifications, settings, close: () => { owned = false; }, sessions };
}
test('monitored command dispatch audits the original text, binds its backend and rejects overlapping runs', async t => {
    const { execute, tab, writes, audits, sessions, notifications } = setup(t);
    assert.equal((await execute({}, { tabId: 'tab-1', command: 'x'.repeat(16001), notifyOnExit: true })).success, false);
    assert.equal(writes.length, 0, 'oversized commands must be rejected, never truncated and executed');
    assert.equal((await execute({}, { tabId: 'tab-1', command: 'exit 7', notifyOnExit: true })).success, true);
    assert.equal(audits[0].command, 'exit 7'); assert.match(writes[0], /ait-notify/);
    const parser = sessions.get('tab-1').programMonitor;
    assert.equal((await execute({}, { tabId: 'tab-1', command: 'exit 0', notifyOnExit: true })).success, false);
    parser.feed(`\x1b]777;aiterm;${parser.id};start\x07\x1b]777;aiterm;${parser.id};end;7\x07`);
    assert.equal(notifications.length, 1); assert.equal(notifications[0].exitCode, 7); assert.equal(notifications[0].target, 'local');
    const remoteWrites = []; tab.sshStream = { write: value => remoteWrites.push(value) };
    assert.equal((await execute({}, { tabId: 'tab-1', command: 'codex', notifyOnExit: true })).success, true);
    tab.sshStream.programMonitor.close('connection_lost');
    assert.equal(notifications.at(-1).status, 'unknown'); assert.equal(notifications.at(-1).target, 'remote');
    assert.match(remoteWrites[0], /codex/);
});
test('monitored dispatch cannot bypass denied risk confirmation or a backend change', async t => {
    const refused = setup(t, () => false);
    assert.equal((await refused.execute({}, { tabId: 'tab-1', command: 'kill -9 123', notifyOnExit: true })).success, false);
    assert.equal(refused.audits[0].audit.requiresConfirmation, true); assert.equal(refused.writes.length, 0); assert.equal(refused.notifications.length, 0);
    const changed = setup(t, (_owner, sessions) => { sessions.set('tab-1', { active: true }); return true; });
    assert.equal((await changed.execute({}, { tabId: 'tab-1', command: 'echo ok', notifyOnExit: true })).success, false);
    assert.equal(changed.writes.length, 0); assert.equal(changed.notifications.length, 0);
});
test('AI plugin call resolves in the main process and audits the real command before writing', async t => {
    const { execute, writes, audits } = setup(t);
    const result = await execute({}, { tabId: 'tab-1', command: 'plugin_run("test.execution", "danger")' });
    assert.equal(result.success, true);
    assert.deepEqual(writes, ['rm -rf /tmp/plugin-fixture\r']);
    assert.equal(audits[0].command, 'rm -rf /tmp/plugin-fixture');
    assert.equal(audits[0].audit.requiresConfirmation, true);
});
test('unloading a plugin while confirmation is open revokes the pending action', async t => {
    const { execute, writes } = setup(t, tab => { tab.pluginIds.clear(); return true; });
    const result = await execute({}, { tabId: 'tab-1' }, { pluginId: 'test.execution', actionId: 'danger' });
    assert.equal(result.success, false); assert.match(result.error, /停用/); assert.equal(writes.length, 0);
});
test('backend replacement and rejected confirmation cannot write into another session', async t => {
    const replaced = setup(t, (_tab, sessions) => { sessions.set('tab-1', { active: true }); return true; });
    assert.equal((await replaced.execute({}, { tabId: 'tab-1', command: 'plugin_run("test.execution", "danger")' })).success, false);
    assert.equal(replaced.writes.length, 0);
    const rejected = setup(t, () => false);
    assert.equal((await rejected.execute({}, { tabId: 'tab-1', command: 'plugin_run("test.execution", "danger")' })).success, false);
    assert.equal(rejected.writes.length, 0);
});

test('the takeover dispatcher resolves and audits plugin commands before the local execution branch', async t => {
    const fixture = setup(t);
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const begin = source.indexOf('async function executeAiCommand(');
    const end = source.indexOf('\n// 初始化应用', begin);
    // This is the last function before application boot; compile only its declaration.
    const body = source.slice(begin, end === -1 ? source.indexOf('\napp.whenReady()', begin) : end);
    const tab = Object.assign(fixture.tab, { aiTakeoverTarget: 'local', localTakeoverInitialDir: '/tmp', localTakeoverBinding: { environment: { shell: 'posix' }, valid: () => true }, aiTakeoverHistory: [] });
    const auditSubjects = [], dispatched = [];
    const window = { webContents: { send() {} } };
    const context = vm.createContext({
        process: { platform: 'linux' }, console: { log() {} }, setTimeout() {}, Date,
        tabExecutionContext: { getStore: () => tab }, ownsTabConnection: () => true,
        normalizeShellCommand: c => c, parsePluginCall, parsePluginToolCall, getPluginManager: () => fixture.manager,
        prepareLocalCommand: (_t, c) => c, decodeActionAuditSubject: (_p, c) => c, auditCommand,
        INTERNAL_SECURITY_APPROVAL: Symbol('test'), sendTabEvent() {}, buildOrUpdateContextIndex() {},
        confirmAuditedCommand: async (_w, _t, c) => { auditSubjects.push(c); return true; },
        executeLocalShellCommand: async (_t, c) => { dispatched.push(c); return { output: 'fixture output' }; }
    });
    const run = vm.runInContext(body + '\nexecuteAiCommand;', context);
    await run(tab, window, { command: 'plugin_run("test.execution", "read")', purpose: 'test', commandType: 'local' });
    assert.deepEqual(dispatched, ['uname -a']); assert.deepEqual(auditSubjects, ['uname -a']);
});
test('native tools bind the backend and activation before the model responds', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const begin = source.indexOf('async function pluginModelTools('), end = source.indexOf('\nlet mainWindow;', begin);
    let backend = {}, activation = true, invoked = 0;
    const owner = { aiTakeoverMode: true, aiTakeoverTarget: 'remote', pluginIds: new Set(['example.plugin']) };
    const entry = { pluginId: 'example.plugin', toolId: 'tool', digest: 'digest', activation: 0, definition: {} };
    const context = vm.createContext({
        capturePluginBinding: () => { const original = backend; return { valid: () => backend === original }; },
        getPluginManager: () => ({ isCurrent: () => activation }),
        getPluginRuntime: () => ({ toolDefinitions: async () => new Map([['tool', entry]]), invoke: async () => { invoked++; return 'result'; } })
    });
    const prepare = vm.runInContext(source.slice(begin, end) + '\npluginModelTools;', context);
    const first = await prepare(owner); backend = {};
    await assert.rejects(first.onToolCall('tool', { arguments: {} }), /目标已变化/);
    const second = await prepare(owner); activation = false;
    await assert.rejects(second.onToolCall('tool', { arguments: {} }), /停用或更新/);
    assert.equal(invoked, 0);
    activation = true; const third = await prepare(owner); assert.equal(await third.onToolCall('tool', { arguments: {} }), 'result');
});
