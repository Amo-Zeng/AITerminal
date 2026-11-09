'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { runElectronSmoke } = require('./clipboardSmoke');

async function main() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
            requests.push({ path: req.url, payload: JSON.parse(raw), headers: req.headers });
            const text = '✅ AI_PROTOCOL_SMOKE_OK';
            const body = req.url.endsWith('/responses') ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
                : req.url.endsWith('/messages') ? { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
                : { choices: [{ message: { content: text } }] };
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await runElectronSmoke(async ({ evaluate }) => {
            for (const format of ['chat-completions', 'responses', 'messages']) {
                const config = { aiApiKey: 'fixture-placeholder', aiBaseUrl: `http://127.0.0.1:${server.address().port}`, aiApiFormat: format, aiModel: 'fixture' };
                const result = await evaluate(`electronAPI.aiTestConnection(${JSON.stringify(config)},'tab-1')`);
                assert.equal(result.success, true, result.error); assert.match(result.response, /AI_PROTOCOL_SMOKE_OK/);
            }
            assert.deepEqual(requests.map(req => req.path), ['/v1/chat/completions', '/v1/responses', '/v1/messages']);
            assert.equal(requests[2].headers['anthropic-version'], '2023-06-01');
            console.log('AI protocol smoke ok: Electron renderer -> IPC -> three wire formats -> parsed reply');
        });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
