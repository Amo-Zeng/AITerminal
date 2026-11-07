'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const https = require('https');
const crypto = require('crypto');
const { downloadManifest } = require('../lib/pluginDownload');
const catalog = require('../plugins/catalog.json');
function fakeDownload(t, respond) {
    const requests = [];
    t.mock.method(https, 'get', (url, options, callback) => {
        const request = new EventEmitter(); requests.push({ url, options });
        queueMicrotask(() => {
            const response = new PassThrough(); response.headers = {}; response.statusCode = 200;
            respond(response, callback, requests.length);
        });
        return request;
    });
    return requests;
}
test('remote plugin import verifies exact downloaded bytes before returning the manifest', async t => {
    const raw = JSON.stringify(catalog[0], null, 2);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const requests = fakeDownload(t, (res, callback) => { callback(res); res.end(raw); });
    const result = await downloadManifest('https://example.com/plugin.json', hash);
    assert.equal(result.manifest.id, catalog[0].id); assert.equal(result.downloadHash, hash);
    assert.equal(requests[0].options.headers.Authorization, undefined);
    await assert.rejects(downloadManifest('https://example.com/plugin.json', '0'.repeat(64)), /SHA-256/);
});
test('remote manifests are bounded even when the server omits a content length', async t => {
    fakeDownload(t, (res, callback) => { callback(res); res.end(' '.repeat(128 * 1024 + 1)); });
    await assert.rejects(downloadManifest('https://example.com/plugin.json'), /128 KiB/);
});
test('redirects cannot downgrade transport or run forever', async t => {
    const requests = fakeDownload(t, (res, callback) => {
        res.statusCode = 302; res.headers.location = requests.length === 1 ? 'http://example.com/p.json' : '/redirect.json';
        callback(res); res.end();
    });
    await assert.rejects(downloadManifest('https://example.com/p.json'), /HTTPS/);
    await assert.rejects(downloadManifest('https://example.com/p.json'), /重定向过多/);
    assert.equal(requests.length, 5);
});
