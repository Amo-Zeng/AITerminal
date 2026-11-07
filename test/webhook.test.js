'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    appEventToWebhook,
    buildWebhookPayload,
    normalizeWebhookConfig,
    redactSensitive,
    validateWebhookUrl
} = require('../lib/webhook');

test('AI completion events become task completion Webhooks', () => {
    assert.deepEqual(appEventToWebhook('ai-takeover-update', { type: 'complete', message: 'done' }), {
        event: 'task_completed',
        data: { status: 'completed', message: 'done' }
    });
    assert.equal(appEventToWebhook('ai-takeover-update', { type: 'analysis' }), null);
});

test('webhook URL validation only accepts HTTPS', () => {
    assert.equal(validateWebhookUrl('https://hooks.example.test/notify').valid, true);
    assert.equal(validateWebhookUrl('http://hooks.example.test/notify').valid, false);
    assert.equal(validateWebhookUrl('not a url').valid, false);
});

test('webhook configuration filters events and bounds timeout', () => {
    const config = normalizeWebhookConfig({ enabled: true, events: ['task_started', 'unknown'], timeoutMs: 999999 });
    assert.deepEqual(config.events, ['task_started']);
    assert.equal(config.timeoutMs, 30000);
});

test('webhook redaction removes nested credentials and token-shaped strings', () => {
    const redacted = redactSensitive({
        apiKey: 'sk-abcdefghijklmnop',
        nested: { password: 'hello', note: 'Bearer abc.def.ghi' },
        url: 'https://example.test/?token=secret-value'
    });
    assert.equal(redacted.apiKey, '[REDACTED]');
    assert.equal(redacted.nested.password, '[REDACTED]');
    assert.equal(redacted.nested.note, 'Bearer [REDACTED]');
    assert.match(redacted.url, /token=\[REDACTED\]/);
});

test('webhook payload omits commands unless explicitly enabled', () => {
    const hidden = buildWebhookPayload('task_started', { command: 'rm -rf x', tabId: 'tab-1' }, { includeCommand: false });
    const shown = buildWebhookPayload('task_started', { command: 'echo ok', tabId: 'tab-1' }, { includeCommand: true });
    assert.equal('command' in hidden, false);
    assert.equal(shown.command, 'echo ok');
});
