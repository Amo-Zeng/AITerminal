'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeApiBaseUrl, normalizeConfiguredApiBaseUrl, validateApiBaseUrl } = require('../lib/apiSecurity');

test('API URL policy requires HTTPS except explicit loopback hosts', () => {
    assert.equal(validateApiBaseUrl('https://api.example.test').valid, true);
    assert.equal(validateApiBaseUrl('http://api.example.test').valid, false);
    assert.equal(validateApiBaseUrl('http://localhost:11434').valid, true);
    assert.equal(validateApiBaseUrl('http://127.0.0.1:8000/v1').valid, true);
    assert.equal(validateApiBaseUrl('http://[::1]:8000/v1').valid, true);
});

test('API URL policy rejects embedded credentials and defaults missing scheme to HTTPS', () => {
    assert.equal(validateApiBaseUrl('https://user:pass@example.test').valid, false);
    assert.equal(normalizeApiBaseUrl('api.example.test'), 'https://api.example.test');
});

test('configured invalid or blank API URLs never silently fall back to OpenAI', () => {
    assert.equal(normalizeConfiguredApiBaseUrl(undefined), 'https://api.openai.com');
    assert.equal(normalizeConfiguredApiBaseUrl(''), '');
    assert.equal(normalizeConfiguredApiBaseUrl('http://remote.example.test'), '');
});
