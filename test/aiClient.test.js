'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { completionUrl, requestChat, cancelAiRequests, ChatStream } = require('../lib/aiClient');

async function server(t, handler) {
    const instance = http.createServer(handler);
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    t.after(() => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); });
    return `http://127.0.0.1:${instance.address().port}`;
}
const config = baseUrl => ({ baseUrl, apiKey: 'test-only-placeholder', model: 'test', temperature: 0, maxTokens: 32 });
test('completion URL handles origin, v1 prefix, proxy prefix, full path and query separately', () => {
    const paths = [['https://example.com', '/v1/chat/completions'], ['https://example.com/v1/', '/v1/chat/completions'], ['https://example.com/proxy/v1', '/proxy/v1/chat/completions'], ['https://example.com/proxy/v1/chat/completions', '/proxy/v1/chat/completions']];
    for (const [input, pathname] of paths) assert.equal(completionUrl(input).pathname, pathname);
    const url = completionUrl('https://example.com/v1?api-version=2026');
    assert.equal(url.pathname, '/v1/chat/completions'); assert.equal(url.search, '?api-version=2026');
    assert.throws(() => completionUrl('http://example.com'), /HTTPS/);
});
test('stream preserves fragmented Unicode, CRLF, data without spaces, and final unterminated event', () => {
    const updates = [], stream = new ChatStream((text, done) => updates.push([text, done]));
    const raw = ': heartbeat\r\ndata:{"choices":[{"delta":{"content":"中文😀"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"尾部"}}]}';
    for (const ch of raw) stream.write(ch);
    assert.equal(stream.finish(), '中文😀尾部');
    assert.deepEqual(updates.at(-1), ['中文😀尾部', true]);
    const broken = new ChatStream(); broken.write('data: {bad}\n'); assert.throws(() => broken.finish(), /JSON/);
});
test('real HTTP request uses the correct path, zero temperature and streaming tail', async t => {
    let request;
    const base = await server(t, (req, res) => {
        let raw = ''; req.on('data', data => { raw += data; });
        req.on('end', () => {
            request = { path: req.url, payload: JSON.parse(raw) };
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
            res.end('data:{"choices":[{"delta":{"content":"world"}}]}');
        });
    });
    const owner = {}, result = await requestChat({ config: config(base + '/v1'), messages: [{ role: 'user', content: 'test' }], streaming: true, owner });
    assert.equal(result, 'hello world'); assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.payload.temperature, 0);
    assert.equal(owner.currentAiReq, null); assert.equal(owner.aiRequests.size, 0);
});
test('a closed tab cancels rate-limit backoff before another request can be sent', async t => {
    let requests = 0, gotFirst;
    const ready = new Promise(resolve => { gotFirst = resolve; });
    const base = await server(t, (_req, res) => { requests++; res.writeHead(429); res.end('{}'); gotFirst(); });
    const owner = {}, promise = requestChat({ config: config(base), messages: [], owner, retryDelayMs: 60 });
    const rejected = assert.rejects(promise, /取消/);
    await ready; await new Promise(resolve => setTimeout(resolve, 15)); cancelAiRequests(owner);
    await rejected; await new Promise(resolve => setTimeout(resolve, 85));
    assert.equal(requests, 1); assert.equal(owner.aiRequests.size, 0);
});
test('truncated responses, excessive bodies and response deadlines reject without hanging', async t => {
    let count = 0;
    const base = await server(t, (_req, res) => {
        count++;
        if (count === 1) { res.writeHead(200, { 'Content-Length': '1000' }); res.write('partial'); setImmediate(() => res.destroy()); }
        else if (count === 2) res.end('a'.repeat(500));
        else { res.writeHead(200); res.write('partial'); }
    });
    await assert.rejects(requestChat({ config: config(base), messages: [], timeoutMs: 1000 }), /断开|读取失败|网络错误/);
    await assert.rejects(requestChat({ config: config(base), messages: [], maxResponseBytes: 100 }), /大小限制/);
    await assert.rejects(requestChat({ config: config(base), messages: [], timeoutMs: 40 }), /超时/);
});
test('cancel all requests belonging to one tab without cancelling another tab', async t => {
    const base = await server(t, (_req, res) => { res.writeHead(200); res.write(' '); });
    const first = {}, second = {};
    const args = { config: config(base), messages: [], timeoutMs: 1000 };
    const firstRequests = [requestChat({ ...args, owner: first }), requestChat({ ...args, owner: first })];
    const secondRequest = requestChat({ ...args, owner: second });
    const failures = firstRequests.map(p => assert.rejects(p, /取消/));
    cancelAiRequests(first); await Promise.all(failures);
    assert.equal(second.aiRequests.size, 1);
    const secondFailure = assert.rejects(secondRequest, /取消/); cancelAiRequests(second); await secondFailure;
});
