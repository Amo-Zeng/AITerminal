'use strict';
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runElectronSmoke } = require('./clipboardSmoke');
async function main() {
    const withoutTerminal = process.platform === 'win32' || process.argv.includes('--without-terminal');
    const requests = [];
    const server = http.createServer((req, res) => {
        let data = ''; req.on('data', chunk => { data += chunk; });
        req.on('end', () => { requests.push(JSON.parse(data)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'MODEL_ADAPTER_OK' } }] })); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await runElectronSmoke(async ({ evaluate, client }) => {
            const check = async code => { const result = await evaluate(code); assert.equal(result?.success, true, result?.error); return result; };
            const wait = async expression => {
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) { const value = await evaluate(expression); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
                throw new Error('plugin runtime smoke timeout');
            };
            const install = async id => {
                const preview = await check(`electronAPI.pluginsPreview({kind:'bundled',id:${JSON.stringify(id)}},'tab-1')`);
                return check(`electronAPI.pluginsInstall(${JSON.stringify(preview.preview.token)},'tab-1')`);
            };
            await install('aiterminal.docker-tools');
            await check("electronAPI.pluginsEnable('aiterminal.docker-tools',true,'tab-1')");
            await check("electronAPI.pluginsConfig('aiterminal.docker-tools','tab',{label:'FIRST',context:'',tail:100},'tab-1')");
            await evaluate('createNewTerminalTab()');
            await check("electronAPI.pluginsEnable('aiterminal.docker-tools',true,'tab-2')");
            await check("electronAPI.pluginsConfig('aiterminal.docker-tools','tab',{label:'SECOND',context:'',tail:200},'tab-2')");
            if (withoutTerminal) {
                // Hosted Windows has no initialized Ubuntu. Verify the actual
                // disconnected contract explicitly instead of accidentally
                // treating two missing backends as the same valid terminal.
                await evaluate(`(async () => {
                    for (const tab of ['tab-1', 'tab-2']) {
                        terminalTabs.get(tab).sshConnecting = true;
                        stopLocalTerminalForTab(tab);
                        await electronAPI.terminalLocalStop(tab);
                    }
                })()`);
            }
            for (const [tab, label] of [['tab-1', 'FIRST'], ['tab-2', 'SECOND']]) {
                const start = await check(`electronAPI.pluginsTool('aiterminal.docker-tools','environment',{},'${tab}')`);
                const task = await wait(`electronAPI.pluginsList('${tab}').then(r=>r.plugins.find(p=>p.id==='aiterminal.docker-tools').runtimeState.tasks.find(t=>t.id==='${start.taskId}'&&t.state!=='running'))`);
                if (withoutTerminal) {
                    assert.equal(task.state, 'error'); assert.match(task.error, /失效|关闭|变化/);
                } else {
                    assert.equal(task.state, 'completed', task.error); assert.equal(task.result.label, label); assert.equal(task.result.tabId, tab);
                }
            }
            await evaluate("switchToTab('tab-1'); document.getElementById('openPluginCenter').click()");
            await wait("document.querySelector('[data-plugin-action=select][data-id=\"aiterminal.docker-tools\"]') !== null");
            await evaluate("document.querySelector('[data-plugin-action=select][data-id=\"aiterminal.docker-tools\"]').click()");
            await wait("document.querySelector('[data-form-key=\"config:aiterminal.docker-tools\"] [data-field=label]')?.value === 'FIRST'");
            await evaluate("document.getElementById('closePluginCenter').click()");
            await install('aiterminal.model-policy');
            await check("electronAPI.pluginsEnable('aiterminal.model-policy',true,'tab-1')");
            await check("electronAPI.pluginsConfig('aiterminal.model-policy','tab',{model:'plugin-model',temperature:0},'tab-1')");
            await check("electronAPI.pluginsModel('aiterminal.model-policy','configured','tab-1')");
            const config = { enableAI: true, aiApiKey: 'test-only-placeholder', aiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, aiModel: 'original-model', aiTemperature: 0.7 };
            for (const tab of ['tab-1', 'tab-2']) {
                await check(`electronAPI.aiConfigure(${JSON.stringify(config)},'${tab}')`);
                await check(`electronAPI.aiChatWithoutTerm('插件模型隔离验证',false,'${tab}')`);
            }
            assert.equal(requests[0].model, 'plugin-model'); assert.equal(requests[0].temperature, 0);
            assert.equal(requests[1].model, 'original-model'); assert.equal(requests[1].temperature, 0.7);
            assert.match(requests[0].messages[0].content, /FIRST/); assert.doesNotMatch(requests[0].messages[0].content, /SECOND/);
            await check("electronAPI.pluginsEnable('aiterminal.docker-tools',false,'tab-1')");
            assert.equal((await evaluate("electronAPI.pluginsTool('aiterminal.docker-tools','environment',{},'tab-1')")).success, false);
            assert.equal((await check("electronAPI.pluginsList('tab-2')")).plugins.find(p => p.id === 'aiterminal.docker-tools').enabled, true);
            const invoke = async (id, tool, params = {}, tab = 'tab-1') => {
                const start = await check(`electronAPI.pluginsTool(${JSON.stringify(id)},${JSON.stringify(tool)},${JSON.stringify(params)},'${tab}')`);
                const task = await wait(`electronAPI.pluginsList('${tab}').then(r=>r.plugins.find(p=>p.id===${JSON.stringify(id)}).runtimeState.tasks.find(t=>t.id==='${start.taskId}'&&t.state!=='running'))`);
                assert.equal(task.state, 'completed', task.error); return task.result;
            };
            const select = async id => {
                await evaluate(`document.querySelector('[data-plugin-action=select][data-id="${id}"]').click()`);
                await wait(`document.querySelector('[data-plugin-action=tool][data-id="${id}"]') !== null`);
            };
            for (const id of ['aiterminal.terminal-pet', 'aiterminal.ops-quest', 'aiterminal.git-time-machine']) {
                await install(id); await check(`electronAPI.pluginsEnable('${id}',true,'tab-1')`);
            }
            await check("electronAPI.pluginsEnable('aiterminal.terminal-pet',true,'tab-2')");
            await check("electronAPI.pluginsEnable('aiterminal.ops-quest',true,'tab-2')");
            await check("electronAPI.pluginsConfig('aiterminal.terminal-pet','tab',{name:'PET <b>first</b>',species:'猫'},'tab-1')");
            assert.equal((await invoke('aiterminal.terminal-pet', 'interact', { action: '摸摸' })).affection, 3);
            assert.equal((await invoke('aiterminal.terminal-pet', 'visit', {}, 'tab-2')).affection, 0);
            await evaluate("document.getElementById('openPluginCenter').click()");
            await select('aiterminal.ops-quest');
            await evaluate("document.querySelector('[data-plugin-action=tool][data-tool-id=next]').click()");
            await wait("document.getElementById('pluginDetail').textContent.includes('还有空间，为什么写不进')");
            await evaluate(`(() => { const input=document.querySelector('[data-form-key="tool:aiterminal.ops-quest:answer"] [data-field=choice]'); input.value='"B"'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-plugin-action=tool][data-tool-id=answer]').click(); })()`);
            await wait("document.getElementById('pluginDetail').textContent.includes('答对了')");
            assert.equal((await invoke('aiterminal.ops-quest', 'score')).points, 10);
            assert.equal((await invoke('aiterminal.ops-quest', 'score', {}, 'tab-2')).points, 0);
            const screenshot = async (name, panel) => {
                if (!process.env.AITERMINAL_PLUGIN_SCREENSHOTS) return;
                const directory = path.resolve(process.env.AITERMINAL_PLUGIN_SCREENSHOTS); fs.mkdirSync(directory, { recursive: true });
                await evaluate(`document.querySelector('[data-panel-id="${panel}"]').scrollIntoView({block:'start'})`);
                const capture = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(capture.data, 'base64'));
            };
            await screenshot('ops-quest', 'quest');
            // Windows UI targets WSL Ubuntu, which is not installed on hosted CI.
            // The Node suite exercises real Git via host PowerShell on Windows.
            if (!withoutTerminal) {
                const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-git-ui-'));
                try {
                    for (const args of [['init', '--initial-branch=main'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(repo, 'no-hooks')}`, 'commit', '--allow-empty', '-m', 'feat: 插件时间线']]) {
                        const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
                    }
                    const report = await invoke('aiterminal.git-time-machine', 'timeline', { directory: repo });
                    assert.equal(report.commits[0].subject, 'feat: 插件时间线');
                    const story = await invoke('aiterminal.git-time-machine', 'story', { directory: repo });
                    assert.equal(story.story, 'MODEL_ADAPTER_OK');
                    assert.equal(requests.at(-1).tools, undefined);
                    assert.deepEqual(Object.keys(JSON.parse(requests.at(-1).messages[1].content)), ['commits']);
                    await select('aiterminal.git-time-machine');
                    await wait("document.getElementById('pluginDetail').textContent.includes('MODEL_ADAPTER_OK')");
                    await screenshot('git-time-machine', 'timeline');
                } finally { fs.rmSync(repo, { recursive: true, force: true }); }
            }
            await invoke('aiterminal.terminal-pet', 'visit');
            await select('aiterminal.terminal-pet');
            await wait("document.getElementById('pluginDetail').textContent.includes('PET <b>first</b>')");
            assert.equal(await evaluate("document.querySelector('#pluginDetail b') === null"), true);
            await screenshot('terminal-pet', 'pet');
            console.log(`Plugin runtime smoke ok: Electron + Cordis, tab isolation, model adapter, pet events, quest UI, ${withoutTerminal ? 'closed-backend rejection and offline operation' : 'live terminal context and Git timeline/story'}, teardown`);
        });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
