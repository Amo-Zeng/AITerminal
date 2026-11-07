'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { requestChat, cancelAiRequests } = require('../lib/aiClient');
const { resolveApi, normalizeApiFormat, buildPayload } = require('../lib/aiProtocol');

const tools = [{ type: 'function', function: { name: 'inspect', description: 'Inspect target', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const initial = [{ role: 'system', content: 'Use the current terminal.' }, { role: 'user', content: '检查中文目录' }];
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'fixture-encrypted-state' };
const thinking = { type: 'thinking', thinking: 'fixture reasoning', signature: 'fixture-signature' };
const calls = [1, 2].map(n => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'inspect', arguments: JSON.stringify({ path: `目录${n}` }), status: 'completed' }));
function response(format, toolRound) {
    if (format === 'responses') return { status: 'completed', output: toolRound ? [reasoning, ...calls] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成😀' }] }] };
    return { type: 'message', role: 'assistant', stop_reason: toolRound ? 'tool_use' : 'end_turn', content: toolRound ? [thinking, ...calls.map(call => ({ type: 'tool_use', id: call.call_id, name: call.name, input: JSON.parse(call.arguments) }))] : [{ type: 'text', text: '完成😀' }] };
}
const event = frame => `event: ${frame.type}\r\ndata:${JSON.stringify(frame)}\r\n\r\n`;
function stream(format, message) {
    if (format === 'responses') return (message.output.some(item => item.type === 'message') ? event({ type: 'response.output_text.delta', delta: '完成😀' }) : event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' })) + event({ type: 'response.completed', response: message });
    let wire = event({ type: 'message_start', message: { content: [], stop_reason: null } });
    message.content.forEach((block, index) => {
        const initial = block.type === 'tool_use' ? { ...block, input: {} } : block.type === 'thinking' ? { ...block, thinking: '', signature: '' } : { ...block, text: '' };
        wire += event({ type: 'content_block_start', index, content_block: initial });
        if (block.type === 'tool_use') {
            for (const partial_json of ['{"path":', JSON.stringify(block.input.path) + '}']) wire += event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
        } else if (block.type === 'thinking') {
            wire += event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
            wire += event({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
        } else wire += event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
        wire += event({ type: 'content_block_stop', index });
    });
    return wire + event({ type: 'message_delta', delta: { stop_reason: message.stop_reason } }) + event({ type: 'message_stop' });
}
async function fixture(t, handle) {
    const server = http.createServer((req, res) => {
        let raw = ''; req.on('data', data => { raw += data; }); req.on('end', () => handle(req, res, JSON.parse(raw)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}`;
}
const config = (baseUrl, apiFormat) => ({ baseUrl, apiFormat, apiKey: 'test-only-placeholder', model: 'fixture', maxTokens: 333, temperature: 0 });

test('protocol selection preserves custom paths and supports both explicit and inferred endpoints', () => {
    for (const format of ['responses', 'messages']) {
        for (const prefix of ['', '/v1', '/proxy/v1']) {
            const api = resolveApi(`https://example.test${prefix}?version=1#ignore`, format);
            assert.equal(api.url.pathname, `${prefix || '/v1'}/${format}`); assert.equal(api.url.search, '?version=1'); assert.equal(api.url.hash, '');
        }
        assert.equal(resolveApi(`https://example.test/gateway/v1/${format}/`).format, format);
        assert.equal(resolveApi('https://example.test/gateway/v1/chat/completions', format).url.pathname, `/gateway/v1/${format}`);
    }
    assert.equal(normalizeApiFormat(undefined), 'auto'); assert.throws(() => normalizeApiFormat('invented'), /不支持/);
});
test('Messages maps system-only application prompts to a valid user turn and clamps temperature', () => {
    const payload = buildPayload('messages', { config: { model: 'fixture', temperature: 2 }, messages: [{ role: 'system', content: 'Diagnose the terminal' }], streaming: false });
    assert.equal(payload.system, 'Diagnose the terminal'); assert.equal(payload.messages[0].role, 'user'); assert.equal(payload.messages[0].content[0].type, 'text'); assert.equal(payload.temperature, 1);
});
for (const format of ['responses', 'messages']) for (const streaming of [false, true]) {
    test(`${format} ${streaming ? 'SSE' : 'JSON'} uses provider auth, two tools and lossless continuation`, async t => {
        const bodies = [], headers = [], paths = [], updates = [], seen = [];
        const base = await fixture(t, (req, res, payload) => {
            paths.push(req.url); headers.push(req.headers); bodies.push(payload);
            const message = response(format, bodies.length === 1);
            res.setHeader('Content-Type', streaming ? 'text/event-stream' : 'application/json');
            const data = Buffer.from(streaming ? stream(format, message) : JSON.stringify(message));
            // Split UTF-8 bytes as well as JSON and SSE boundaries.
            for (let n = 0; n < data.length; n += 7) res.write(data.subarray(n, n + 7));
            res.end();
        });
        const owner = {};
        const result = await requestChat({ config: config(base + `/proxy/v1/${format}`), messages: initial, tools, streaming, owner,
            onUpdate: (text, done) => updates.push({ text, done }), onToolCall: async (name, params) => { seen.push({ name, params }); return { found: params.path }; } });
        assert.equal(result, '完成😀'); assert.equal(seen.length, 2); assert.deepEqual(seen[1], { name: 'inspect', params: { path: '目录2' } });
        assert.deepEqual(paths, [`/proxy/v1/${format}`, `/proxy/v1/${format}`]); assert.equal(bodies[0].temperature, 0);
        assert.equal(owner.aiRequests.size, 0); assert.equal(owner.currentAiReq, null);
        if (streaming) { assert.deepEqual(updates.at(-1), { text: '完成😀', done: true }); assert.equal(updates.filter(update => update.done).length, 1); }
        if (format === 'responses') {
            assert.equal(headers[0].authorization, 'Bearer test-only-placeholder'); assert.equal(headers[0]['x-api-key'], undefined);
            assert.equal(bodies[0].max_output_tokens, 333); assert.equal(bodies[0].store, false); assert.equal(bodies[0].messages, undefined);
            assert.equal(bodies[0].tools[0].name, 'inspect'); assert.equal(bodies[0].tools[0].strict, false);
            assert.deepEqual(bodies[1].input.slice(2, 5), [reasoning, ...calls]);
            assert.deepEqual(bodies[1].input.at(-1), { type: 'function_call_output', call_id: 'call_2', output: '{"found":"目录2"}' });
        } else {
            assert.equal(headers[0]['x-api-key'], 'test-only-placeholder'); assert.equal(headers[0]['anthropic-version'], '2023-06-01'); assert.equal(headers[0].authorization, undefined);
            assert.equal(bodies[0].max_tokens, 333); assert.equal(bodies[0].system, initial[0].content); assert.equal(bodies[0].messages[0].role, 'user');
            assert.deepEqual(bodies[0].tools[0].input_schema, tools[0].function.parameters);
            assert.deepEqual(bodies[1].messages[1].content[0], thinking);
            assert.deepEqual(bodies[1].messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"found":"目录1"}' }, { type: 'tool_result', tool_use_id: 'call_2', content: '{"found":"目录2"}' }] });
        }
    });
}
for (const format of ['responses', 'messages']) {
    test(`${format} refuses incomplete streams, API errors, unknown and disabled tools before execution`, async t => {
        let mode = 'truncated', invoked = 0, requests = 0;
        const base = await fixture(t, (_req, res) => {
            requests++;
            const message = response(format, true);
            if (mode === 'http') { res.writeHead(400); res.end('{"error":"test-only-placeholder"}'); return; }
            if (mode === 'unknown') {
                if (format === 'responses') message.output[1] = { ...calls[0], name: 'unknown' };
                else message.content[1].name = 'unknown';
            }
            if (mode === 'limit') { if (format === 'responses') message.status = 'incomplete'; else message.stop_reason = 'max_tokens'; }
            if (mode === 'badargs') {
                if (format === 'responses') message.output[2] = { ...calls[1], arguments: 'null' };
                else message.content[2].input = null;
                res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return;
            }
            let wire = stream(format, message);
            if (mode === 'truncated') wire = wire.slice(0, wire.lastIndexOf('event: '));
            if (mode === 'error') wire = event({ type: 'error', error: { message: 'test-only-placeholder' } });
            res.setHeader('Content-Type', 'text/event-stream'); res.end(wire);
        });
        const args = { config: config(base, format), messages: initial, tools, streaming: true, onToolCall: async () => { invoked++; } };
        for (mode of ['truncated', 'error', 'limit', 'unknown', 'http', 'badargs']) await assert.rejects(requestChat(args), error => { assert.doesNotMatch(error.message, /test-only-placeholder/); return true; });
        mode = 'disabled'; await assert.rejects(requestChat({ ...args, tools: undefined }), /未启用/);
        assert.equal(invoked, 0); assert.equal(requests, 7, 'new protocols must not silently retry a different payload on HTTP 400');
    });
    test(`${format} cancellation stops a stream and does not leak its result to another tab`, async t => {
        let received; const ready = new Promise(resolve => { received = resolve; });
        const base = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': heartbeat\n\n'); received(); });
        const owner = {}, updates = [];
        const promise = requestChat({ config: config(base, format), messages: initial, streaming: true, owner, onUpdate: text => updates.push(text) });
        const rejection = assert.rejects(promise, /取消/); await ready; cancelAiRequests(owner); await rejection;
        assert.equal(owner.aiRequests.size, 0); assert.deepEqual(updates, []);
    });
}
