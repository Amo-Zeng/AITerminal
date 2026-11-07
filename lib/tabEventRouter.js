'use strict';

const TAB_SCOPED_CHANNELS = new Set([
    'ssh-output',
    'ssh-disconnected',
    'terminal-local-output',
    'terminal-local-exit',
    'ai-stream-update',
    'ai-takeover-update'
]);

function normalizeEventTabId(tabId) {
    const value = typeof tabId === 'string' ? tabId.trim() : '';
    if (!value || value.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(value)) return null;
    return value;
}

function routeTabEvent(channel, args = [], contextTabId = null) {
    const values = Array.isArray(args) ? args : [];
    if (!TAB_SCOPED_CHANNELS.has(channel)) {
        return { accepted: true, scoped: false, tabId: null, args: values };
    }

    const first = values[0];
    const objectPayload = first && typeof first === 'object' && !Array.isArray(first);
    const hasExplicitTabId = objectPayload && Object.prototype.hasOwnProperty.call(first, 'tabId');
    const tabId = normalizeEventTabId(hasExplicitTabId ? first.tabId : contextTabId);
    if (!tabId) {
        return {
            accepted: false,
            scoped: true,
            tabId: null,
            args: values,
            reason: hasExplicitTabId ? 'invalid-explicit-tab-id' : 'missing-tab-id'
        };
    }

    let payload;
    if (objectPayload) {
        payload = { ...first, tabId };
    } else if (channel === 'ssh-output' || channel === 'terminal-local-output') {
        payload = { tabId, data: first == null ? '' : String(first) };
    } else if (channel === 'ssh-disconnected') {
        payload = { tabId, reason: first == null ? '' : String(first) };
    } else {
        payload = { tabId, value: first };
    }

    return {
        accepted: true,
        scoped: true,
        tabId,
        args: [payload, ...values.slice(1)]
    };
}

module.exports = {
    TAB_SCOPED_CHANNELS,
    normalizeEventTabId,
    routeTabEvent
};
