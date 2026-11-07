'use strict';

function createTabRegistry(createSession, initialTabId = 'tab-1') {
    if (typeof createSession !== 'function') throw new TypeError('createSession must be a function');
    const registry = {
        activeTabId: initialTabId,
        tabs: new Map(),
        closedTabIds: new Set(),
        createSession
    };
    registry.tabs.set(initialTabId, createSession(initialTabId));
    return registry;
}

function openTabSession(registry, tabId) {
    if (!registry?.tabs || !tabId) return null;
    if (registry.tabs.has(tabId)) return registry.tabs.get(tabId);
    if (registry.closedTabIds?.has(tabId)) return null;
    const session = registry.createSession(tabId);
    registry.tabs.set(tabId, session);
    return session;
}

function ensureTabSession(registry, tabId) {
    return openTabSession(registry, tabId);
}

function getTabSession(registry, tabId) {
    if (!registry?.tabs || !tabId) return null;
    return registry.tabs.get(tabId) || null;
}

function activateTabSession(registry, tabId) {
    const session = getTabSession(registry, tabId);
    if (!session) return null;
    registry.activeTabId = tabId;
    return session;
}

function closeTabSession(registry, tabId, dispose) {
    if (!registry?.tabs || !tabId) return false;
    const session = registry.tabs.get(tabId);
    if (!session) return false;
    // Revoke ownership before tearing down backends. Some streams emit their
    // final events synchronously from kill/end; those events must already see
    // the tab as closed and therefore cannot be routed to the renderer.
    registry.tabs.delete(tabId);
    registry.closedTabIds?.add(tabId);
    if (registry.activeTabId === tabId) {
        registry.activeTabId = registry.tabs.keys().next().value || 'tab-1';
    }
    if (typeof dispose === 'function') dispose(session);
    return true;
}

function formatTabEvent(channel, tabId, payload = {}) {
    if (channel === 'ssh-output') {
        return { tabId, data: payload == null ? '' : String(payload) };
    }
    if (channel === 'ssh-disconnected') {
        return { tabId, reason: payload == null ? '' : String(payload) };
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return { ...payload, tabId };
    }
    return { tabId, value: payload };
}

module.exports = {
    activateTabSession,
    closeTabSession,
    createTabRegistry,
    ensureTabSession,
    getTabSession,
    formatTabEvent,
    openTabSession
};
