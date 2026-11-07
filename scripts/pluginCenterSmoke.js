'use strict';
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runElectronSmoke } = require('./clipboardSmoke');

async function main() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', data => { body += data; });
        req.on('end', () => {
            requests.push({ path: req.url, body: JSON.parse(body) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'PLUGIN_SMOKE_RESPONSE' } }] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    try {
        await runElectronSmoke(async ({ evaluate, client }) => {
            const waitFor = async (expression, description) => {
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    if (await evaluate(expression)) return;
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                throw new Error(`plugin center timed out: ${description}`);
            };
            const click = async selector => {
                assert.equal(await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`), true, `Missing or disabled control ${selector}`);
            };
            await click('#openPluginCenter');
            await waitFor("document.querySelectorAll('.plugin-card').length >= 4", 'catalog rendered');
            await click('[data-plugin-action="select"][data-id="aiterminal.system-health"]');
            await click('[data-plugin-action="preview-bundled"]');
            await waitFor("!!document.querySelector('[data-plugin-action=install]:not(:disabled)')", 'install preview');
            assert.match(await evaluate("document.getElementById('pluginDetail').textContent"), /uname -a/);
            await click('[data-plugin-action="install"]');
            await waitFor("!!document.querySelector('[data-plugin-action=enable]:not(:disabled)')", 'installed');
            assert.equal((await evaluate("window.electronAPI.pluginsList('tab-1')")).plugins.find(p => p.id === 'aiterminal.system-health').enabled, false);
            await click('[data-plugin-action="enable"]');
            await waitFor("document.getElementById('pluginCount').textContent.startsWith('1 个') && !document.querySelector('[data-plugin-action=enable]').disabled", 'enabled in first tab');
            if (process.argv.includes('--screenshot')) {
                const result = await client.send('Page.captureScreenshot', { format: 'png' });
                fs.mkdirSync(path.resolve('release'), { recursive: true });
                fs.writeFileSync(path.resolve('release/plugin-center.png'), Buffer.from(result.data, 'base64'));
            }
            await click('#closePluginCenter');
            await evaluate('createNewTerminalTab()');
            await waitFor("terminalTabs.has('tab-2')", 'second tab');
            assert.equal((await evaluate("window.electronAPI.pluginsList('tab-2')")).plugins.find(p => p.id === 'aiterminal.system-health').enabled, false);
            const cfg = { enableAI: true, aiApiKey: 'test-only-placeholder', aiBaseUrl: baseUrl, aiModel: 'plugin-smoke', aiTemperature: 0 };
            for (const tab of ['tab-1', 'tab-2']) {
                assert.equal((await evaluate(`window.electronAPI.aiConfigure(${JSON.stringify(cfg)}, '${tab}')`)).success, true);
                assert.equal((await evaluate(`window.electronAPI.aiChatWithoutTerm('检查插件上下文', false, '${tab}')`)).success, true);
            }
            assert.equal(requests.length, 2);
            assert.equal(requests[0].path, '/v1/chat/completions');
            assert.equal(requests[0].body.temperature, 0);
            assert.match(requests[0].body.messages[0].content, /aiterminal.system-health/);
            assert.doesNotMatch(requests[1].body.messages[0].content, /aiterminal.system-health/);
            if (process.platform !== 'win32') {
                await evaluate("switchToTab('tab-1')");
                await waitFor("terminalTabs.get('tab-1').localTerminalActive", 'PTY ready');
                const run = await evaluate("window.electronAPI.pluginsRun('aiterminal.system-health', 'overview', 'tab-1')");
                assert.equal(run.success, true, run.error);
                await waitFor("(() => { const t = terminalTabs.get('tab-1').terminal; return Array.from({length: t.buffer.active.length}, (_,i) => t.buffer.active.getLine(i)?.translateToString() || '').join(' ').includes('Filesystem'); })()", 'actual plugin command output');
            }
            await evaluate("window.electronAPI.pluginsDefault('aiterminal.system-health', true, 'tab-1')");
            await evaluate('createNewTerminalTab()');
            assert.equal((await evaluate("window.electronAPI.pluginsList('tab-3')")).plugins.find(p => p.id === 'aiterminal.system-health').enabled, true);
            await evaluate("window.electronAPI.pluginsUninstall('aiterminal.system-health', 'tab-1')");
            for (const tab of ['tab-1', 'tab-3']) {
                const state = await evaluate(`window.electronAPI.pluginsList('${tab}')`);
                assert.equal(state.plugins.find(p => p.id === 'aiterminal.system-health').enabled, false);
            }
            assert.equal((await evaluate("window.electronAPI.pluginsRun('aiterminal.system-health', 'overview', 'tab-1')")).success, false);
            assert.equal((await evaluate("window.electronAPI.pluginsList('tab-closed')")).success, false);
            console.log('Plugin center smoke ok: real UI/IPC install, enable, per-tab AI context, command execution, defaults, uninstall');
        });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
