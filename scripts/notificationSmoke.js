'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { runElectronSmoke } = require('./clipboardSmoke');

async function main() {
    // Local test receiver only. Its temporary certificate is trusted by this
    // Electron child; production certificate verification remains enabled.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-notification-smoke-'));
    const key = path.join(directory, 'test-key.pem'), cert = path.join(directory, 'test-cert.pem');
    const previousCA = process.env.NODE_EXTRA_CA_CERTS;
    const messages = [];
    let server;
    try {
        const gitOpenSSL = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe') : '';
        const openssl = gitOpenSSL && fs.existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl';
        execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
        server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
            let body = ''; req.on('data', data => { body += data; });
            req.on('end', () => { messages.push(JSON.parse(body)); res.writeHead(204); res.end(); });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        process.env.NODE_EXTRA_CA_CERTS = cert;
        await runElectronSmoke(async ({ evaluate }) => {
            const check = async expression => { const value = await evaluate(expression); assert.equal(value?.success, true, value?.error || value?.message); return value; };
            const wait = async predicate => {
                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
                throw new Error('notification smoke timed out');
            };
            const settings = { enabled: true, url: `https://127.0.0.1:${server.address().port}/notify`, events: ['program_stopped', 'output_matched'], outputRules: ['READY_DONE', 'CrossTabOnly'], outputIgnoreCase: true, outputCooldownSeconds: 1 };
            const saved = await check(`electronAPI.webhookConfigure(${JSON.stringify(settings)})`);
            assert.equal(saved.config.url, ''); assert.equal(saved.config.hasStoredUrl, true);
            assert.deepEqual(saved.config.outputRules, settings.outputRules);
            assert.equal((await evaluate("electronAPI.webhookConfigure({enabled:true,events:['output_matched'],outputRules:[]})")).success, false);
            await check('electronAPI.webhookTest()');
            assert.equal(messages.at(-1).event, 'test');
            console.log('Notification smoke: protected settings and HTTPS delivery ok');
            await evaluate("document.getElementById('sshButton').click(); document.getElementById('webhook-tab-btn').click()");
            await wait(() => evaluate("document.getElementById('webhookProgramStopped')?.checked && document.getElementById('webhookOutputRules')?.value.includes('READY_DONE')"));
            await evaluate("document.getElementById('webhookOutputCooldown').value='2'; document.getElementById('webhookIncludeOutput').checked=true; document.querySelector('[data-action=save-webhook-settings]').click()");
            await wait(() => evaluate("document.getElementById('webhookTestResult')?.textContent.includes('已保存')"));
            const reread = await check('electronAPI.webhookGetConfig()');
            assert.equal(reread.config.outputCooldownSeconds, 2); assert.equal(reread.config.includeOutput, true);
            await evaluate('closeSSHModal()');
            await check(`electronAPI.webhookConfigure(${JSON.stringify({ ...settings, url: '' })})`);
            // Hosted Windows runners do not have Ubuntu; keep settings/HTTPS
            // coverage there and exercise the visible WSL terminal on user hosts.
            if (process.platform !== 'win32') {
                await wait(() => evaluate("terminalTabs.get('tab-1')?.localTerminalActive"));
                const run = async (command, tab = 'tab-1') => {
                    const before = messages.length;
                    await check(`electronAPI.terminalRunNotified(${JSON.stringify(command)},'${tab}')`);
                    return wait(() => messages.slice(before).find(m => m.event === 'program_stopped' && m.programSource === 'monitored-command' && m.tabId === tab));
                };
                // Keyword is not present in the echoed command. ANSI and delayed
                // chunks must combine at the receiver, never by echo coincidence.
                const normal = await run("printf '\\033[32mREADY'; sleep 0.1; printf '_DONE\\033[0m\\n'");
                assert.equal(normal.exitCode, 0); assert.equal(normal.status, 'completed');
                await wait(() => messages.some(m => m.event === 'output_matched' && m.pattern === 'READY_DONE'));
                assert.equal(messages.filter(m => m.event === 'output_matched' && m.pattern === 'READY_DONE').length, 1);
                assert.equal(normal.command, undefined); assert.equal(messages.find(m => m.event === 'output_matched').output, undefined);
                assert.equal((await run('exit 7')).exitCode, 7);
                // SIGKILL is covered with a real child in the Node suite. The
                // application correctly requires a native confirmation for kill.
                await evaluate('createNewTerminalTab()');
                await wait(() => evaluate("terminalTabs.get('tab-2')?.localTerminalActive"));
                const tab2 = await run("printf '%s' CrossTabOnly", 'tab-2'); assert.equal(tab2.status, 'completed');
                await wait(() => messages.some(m => m.event === 'output_matched' && m.pattern === 'CrossTabOnly'));
                assert.ok(messages.filter(m => m.pattern === 'CrossTabOnly').every(m => m.tabId === 'tab-2'));
                await check("electronAPI.terminalRunNotified('sleep 30','tab-1')");
                await new Promise(resolve => setTimeout(resolve, 200));
                await check("electronAPI.terminalLocalSend('tab-1','\\x03')");
                const interrupted = await wait(() => messages.find(m => m.event === 'program_stopped' && m.programSource === 'monitored-command' && m.exitCode === 130));
                assert.equal(interrupted.tabId, 'tab-1');
                const ids = messages.filter(m => m.event === 'program_stopped').map(m => m.programId);
                assert.equal(new Set(ids).size, ids.length, 'each program emits only one stop event');
                // Full UI path: button dispatch, current tab and literal command.
                await evaluate("switchToTab('tab-2'); document.getElementById('commandInput').value='exit 0'; document.querySelector('[data-action=run-notified-command]').click()");
                await wait(() => messages.filter(m => m.event === 'program_stopped' && m.programSource === 'monitored-command' && m.tabId === 'tab-2').length === 2);
            }
            await check('electronAPI.webhookConfigure({enabled:false,events:[]})');
            console.log('Notification smoke ok: real HTTPS, protected URL/config, monitored PTY success/failure/Ctrl+C, ANSI matching, tab ownership, UI dispatch (POSIX)');
        });
    } finally {
        if (previousCA === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = previousCA;
        server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
