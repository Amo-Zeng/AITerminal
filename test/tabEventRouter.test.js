'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeTabEvent } = require('../lib/tabEventRouter');

test('explicit payload tab wins over async execution context', () => {
    const result = routeTabEvent('ai-takeover-update', [{ tabId: 'tab-2', type: 'result' }], 'tab-1');
    assert.equal(result.accepted, true);
    assert.equal(result.tabId, 'tab-2');
    assert.deepEqual(result.args[0], { tabId: 'tab-2', type: 'result' });
});

test('tab-scoped event without payload or context tab is rejected', () => {
    const result = routeTabEvent('ai-stream-update', [{ content: 'orphaned' }]);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'missing-tab-id');
});

test('string SSH output uses the async execution context tab', () => {
    const result = routeTabEvent('ssh-output', ['hello'], 'tab-3');
    assert.equal(result.accepted, true);
    assert.equal(result.tabId, 'tab-3');
    assert.deepEqual(result.args[0], { tabId: 'tab-3', data: 'hello' });
});

test('invalid explicit tab is rejected instead of falling back to context', () => {
    const result = routeTabEvent('ai-stream-update', [{ tabId: '../tab-2', content: 'x' }], 'tab-1');
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid-explicit-tab-id');
});

test('non-tab channels pass through unchanged', () => {
    const args = [{ value: 1 }];
    const result = routeTabEvent('menu-new-tab', args);
    assert.equal(result.accepted, true);
    assert.equal(result.scoped, false);
    assert.equal(result.args, args);
});
