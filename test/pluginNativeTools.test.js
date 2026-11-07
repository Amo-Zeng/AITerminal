'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { requestChat, ChatStream } = require('../lib/aiClient');
const tools = [{ type: 'function', function: { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } } }];
test('native model tool calls pass through the host and return correlated results in the next request', async t => {
    const bodies = [];
    const server = http.createServer((req, res) => {
        let raw = ''; req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            bodies.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message: bodies.length === 1 ? { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'fixture_tool', arguments: '{"label":"原标签"}' } }] } : { content: 'done' } }] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const seen = [];
    const result = await requestChat({ config: { apiKey: 'test-only-placeholder', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture' }, messages: [], tools, onToolCall: async (name, params, signal) => { seen.push({ name, params, aborted: signal.aborted }); return { value: 'owned-result' }; } });
    assert.equal(result, 'done'); assert.deepEqual(seen, [{ name: 'fixture_tool', params: { label: '原标签' }, aborted: false }]);
    assert.equal(bodies[1].messages[1].tool_call_id, 'call-1'); assert.equal(JSON.parse(bodies[1].messages[1].content).value, 'owned-result');
});
test('streaming tool names and JSON arguments survive fragmented deltas without text content', () => {
    const stream = new ChatStream();
    for (const delta of [{ index: 0, id: 'call-1', function: { name: 'fixture_tool', arguments: '{"text":' } }, { index: 0, function: { arguments: '"中文"}' } }]) {
        const wire = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [delta] } }] }) + '\n\n';
        for (const char of wire) stream.write(char);
    }
    const result = stream.finish(true);
    assert.equal(result.tool_calls[0].function.name, 'fixture_tool'); assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { text: '中文' });
});
