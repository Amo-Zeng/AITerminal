'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    activateTabSession,
    closeTabSession,
    createTabRegistry,
    ensureTabSession,
    getTabSession,
    formatTabEvent,
    openTabSession
} = require('../lib/tabRegistry');

function createSession(tabId) {
    return {
        tabId,
        sshConnection: null,
        sshStream: null,
        aiConfig: { apiKey: null, model: 'default' },
        aiConversationHistory: [],
        resize: null
    };
}

test('two tabs own independent SSH, AI, history and resize state', () => {
    const registry = createTabRegistry(createSession);
    const first = ensureTabSession(registry, 'tab-1');
    const second = ensureTabSession(registry, 'tab-2');
    first.sshConnection = { id: 'ssh-a' };
    second.sshConnection = { id: 'ssh-b' };
    first.aiConfig.model = 'model-a';
    second.aiConversationHistory.push({ role: 'user', content: 'tab-b' });
    first.resize = { cols: 80, rows: 24 };
    second.resize = { cols: 120, rows: 40 };

    assert.notEqual(first, second);
    assert.notEqual(first.aiConfig, second.aiConfig);
    assert.deepEqual(first.aiConversationHistory, []);
    assert.equal(second.aiConfig.model, 'default');
    assert.deepEqual(first.resize, { cols: 80, rows: 24 });
    assert.deepEqual(second.resize, { cols: 120, rows: 40 });
});

test('activating a tab never changes another session', () => {
    const registry = createTabRegistry(createSession);
    const first = ensureTabSession(registry, 'tab-1');
	ensureTabSession(registry, 'tab-2');
    first.aiConversationHistory.push({ role: 'user', content: 'keep' });
    activateTabSession(registry, 'tab-2');
    assert.equal(registry.activeTabId, 'tab-2');
    assert.equal(ensureTabSession(registry, 'tab-1'), first);
    assert.equal(first.aiConversationHistory[0].content, 'keep');
});

test('activating or looking up a closed tab never recreates its session', () => {
    const registry = createTabRegistry(createSession);
    ensureTabSession(registry, 'tab-2');
    closeTabSession(registry, 'tab-2');

    assert.equal(getTabSession(registry, 'tab-2'), null);
    assert.equal(activateTabSession(registry, 'tab-2'), null);
    assert.equal(registry.tabs.has('tab-2'), false);
});

test('an explicitly reopened closed tab is rejected instead of losing its isolation boundary', () => {
    const registry = createTabRegistry(createSession);
    const original = openTabSession(registry, 'tab-2');
    closeTabSession(registry, 'tab-2');

    assert.equal(openTabSession(registry, 'tab-2'), null);
    assert.equal(ensureTabSession(registry, 'tab-2'), null);
    assert.equal(registry.closedTabIds.has('tab-2'), true);
    assert.equal(registry.tabs.has('tab-2'), false);
    assert.notEqual(original, null);
});

test('opening an existing live tab is idempotent', () => {
    const registry = createTabRegistry(createSession);
    const existing = getTabSession(registry, 'tab-1');
    assert.equal(openTabSession(registry, 'tab-1'), existing);
    assert.equal(registry.tabs.size, 1);
});

test('closing one tab disposes only its own session', () => {
    const registry = createTabRegistry(createSession);
    const first = ensureTabSession(registry, 'tab-1');
    const second = ensureTabSession(registry, 'tab-2');
    const disposed = [];
    closeTabSession(registry, 'tab-2', (session) => disposed.push(session.tabId));
    assert.deepEqual(disposed, ['tab-2']);
    assert.equal(registry.tabs.get('tab-1'), first);
    assert.equal(registry.tabs.has('tab-2'), false);
    assert.notEqual(first, second);
});

test('closing revokes registry ownership before backend disposal emits events', () => {
    const registry = createTabRegistry(createSession);
    const second = openTabSession(registry, 'tab-2');
    let visibleDuringDispose = true;

    closeTabSession(registry, 'tab-2', (session) => {
        visibleDuringDispose = registry.tabs.get('tab-2') === session;
    });

    assert.equal(second.tabId, 'tab-2');
    assert.equal(visibleDuringDispose, false);
});

test('tab events always carry the immutable originating tab', () => {
    assert.deepEqual(formatTabEvent('ssh-output', 'tab-2', 'hello'), { tabId: 'tab-2', data: 'hello' });
    assert.deepEqual(formatTabEvent('ssh-disconnected', 'tab-1', 'timeout'), { tabId: 'tab-1', reason: 'timeout' });
    assert.deepEqual(formatTabEvent('ai-stream-update', 'tab-3', { content: 'x' }), { tabId: 'tab-3', content: 'x' });
});
