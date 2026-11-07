'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { findChrome } = require('./rendererSecuritySmoke');

const TIMEOUT_MS = 30000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChildExit(child, timeoutMs = 5000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.removeListener('close', onClose);
            resolve(exited);
        };
        const onClose = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once('close', onClose);
    });
}

async function closeChrome(client, child) {
    if (client) {
        try { await client.send('Browser.close'); } catch {}
        try { client.close(); } catch {}
    }
    if (await waitForChildExit(child)) return;
    try { child.kill('SIGKILL'); } catch {}
    await waitForChildExit(child);
}

async function removeProfile(profile) {
    try {
        await fs.promises.rm(profile, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200
        });
    } catch (error) {
        // The smoke result is authoritative. Windows/Linux can briefly retain
        // Chromium database handles after Browser.close; CI cleans its temp
        // directory after the job, so a stale profile must not fail a passed test.
        console.warn(`config modal smoke cleanup warning: ${error.message}`);
    }
}

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

class CdpClient {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data));
            if (!message.id || !this.pending.has(message.id)) return;
            const { resolve, reject, timer } = this.pending.get(message.id);
            clearTimeout(timer);
            this.pending.delete(message.id);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
        });
    }

    static async connect(url) {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), TIMEOUT_MS);
            socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('CDP WebSocket connection failed'));
            }, { once: true });
        });
        return new CdpClient(socket);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP command timed out: ${method}`));
            }, TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        this.socket.close();
    }
}

async function waitForPage(port, child) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Chrome exited before CDP was ready (${child.exitCode})`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await response.json();
            const page = targets.find((target) => target.type === 'page');
            if (page?.webSocketDebuggerUrl) return page;
        } catch {}
        await delay(100);
    }
    throw new Error('Chrome CDP endpoint timed out');
}

async function waitForExpression(client, expression) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
        if (result.result?.value === true) return;
        await delay(100);
    }
    throw new Error(`Renderer condition timed out: ${expression}`);
}

const electronApiBootstrap = `(() => {
    // Corrupt saved settings must not prevent terminal/configuration startup.
    if (location.protocol === 'file:' && !window.__seededMalformedConfig) {
        window.__seededMalformedConfig = true;
        localStorage.setItem('sshConfig', 'null');
        localStorage.setItem('configProfiles', '[]');
        localStorage.setItem('webhookConfig', '{broken');
        localStorage.setItem('terminalConfig', JSON.stringify({fontSize: -5, scrollback: 'invalid', theme: 'constructor'}));
    }
    let storedWebhookUrl = '';
    let clipboardText = '';
    window.__setClipboardSmokeText = (value) => { clipboardText = String(value); };
    const asyncSuccess = async () => ({ success: true });
    const api = new Proxy({
        terminalLocalStart: async () => ({ success: true, shell: 'smoke' }),
        terminalLocalStop: asyncSuccess,
        terminalLocalWrite: asyncSuccess,
        terminalLocalResize: asyncSuccess,
        terminalLocalSend: async (tabId, data) => {
            window.__terminalInputs = window.__terminalInputs || [];
            window.__terminalInputs.push({ tabId, data });
            return { success: true };
        },
        openTabSession: async (tabId) => {
            window.__openedTabs = window.__openedTabs || [];
            window.__openedTabs.push(tabId);
            return { success: true, tabId };
        },
        tabActivate: asyncSuccess,
        setActiveTab: () => true,
        onSshOutput: () => {},
        onSshDisconnected: () => {},
        onAiTakeoverUpdate: () => {},
        aiConfigure: asyncSuccess,
        secureMigrateConfigs: async () => ({ success: true, persisted: true }),
        clipboardWriteText: async (text, tabId) => {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push({ text, tabId });
            clipboardText = text;
            if (window.__deferClipboardWrite) {
                await new Promise((resolve) => { window.__resolveClipboardWrite = resolve; });
            }
            return { success: true };
        },
        clipboardReadText: async (tabId) => {
            window.__clipboardReads = window.__clipboardReads || [];
            window.__clipboardReads.push({ tabId });
            if (window.__deferClipboardRead) {
                return new Promise((resolve) => {
                    window.__resolveClipboardRead = () => resolve({ success: true, text: clipboardText });
                });
            }
            return { success: true, text: clipboardText };
        },
        webhookGetConfig: async () => ({
            success: true,
            config: { enabled: false, url: '', hasStoredUrl: !!storedWebhookUrl, events: ['task_completed'], includeCommand: false, timeoutMs: 8000 }
        }),
        webhookConfigure: async (config) => {
            if (config.clearStoredUrl === true) storedWebhookUrl = '';
            else if (config.url) storedWebhookUrl = config.url;
            window.__storedWebhookUrl = storedWebhookUrl;
            return { success: true, config: { ...config, url: '', hasStoredUrl: !!storedWebhookUrl } };
        },
        webhookTest: async () => ({ success: true, statusCode: 204 })
    }, {
        get(target, property) {
            return property in target ? target[property] : () => undefined;
        }
    });
    Object.defineProperty(window, 'electronAPI', { value: api, configurable: true });
})()`;

function terminalKeyExpression(tabId, terminalExpression, key, code, modifiers = {}) {
    return `(async () => {
        const info = terminalTabs.get(${JSON.stringify(tabId)});
        const terminal = ${terminalExpression};
        const textarea = terminal?.textarea;
        if (!info || !terminal || !textarea) return { dispatched: false };
        terminal.focus();
        const event = new KeyboardEvent('keydown', {
            key: ${JSON.stringify(key)},
            code: ${JSON.stringify(code)},
            bubbles: true,
            cancelable: true,
            ctrlKey: ${modifiers.ctrlKey === true},
            metaKey: ${modifiers.metaKey === true},
            shiftKey: ${modifiers.shiftKey === true}
        });
        return { dispatched: textarea.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
    })()`;
}

const modalSmokeExpression = `(async () => {
    document.getElementById('sshButton').click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const body = document.querySelector('#sshModal > .modal-content > .modal-body');
    const commands = document.getElementById('commands-tab');
    const webhook = document.getElementById('webhook-tab');
    document.getElementById('webhook-tab-btn').click();

    const url = document.getElementById('webhookUrl');
    const enabled = document.getElementById('webhookEnabled');
    enabled.checked = true;
    document.getElementById('webhookProgramStopped').checked = true;
    document.getElementById('webhookOutputMatched').checked = true;
    document.getElementById('webhookOutputRules').value = '任务完成\\nTraceback';
    document.getElementById('webhookOutputCooldown').value = '120';
    document.getElementById('webhookOutputIgnoreCase').checked = false;
    document.getElementById('webhookIncludeOutput').checked = true;
    url.value = 'https://hooks.example.test/aiterminal-smoke';
    document.querySelector('[data-action="save-webhook-settings"]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const webhookPublicConfig = JSON.parse(localStorage.getItem('webhookConfig') || '{}');
    const webhookSaved = document.getElementById('webhookTestResult').textContent.includes('已保存');
    const urlProtected = webhookPublicConfig.url === '' && window.__storedWebhookUrl === 'https://hooks.example.test/aiterminal-smoke';

    document.getElementById('sshHost').value = 'server.example.test';
    document.getElementById('sshPort').value = '2222';
    document.getElementById('sshUsername').value = 'operator';
    document.getElementById('aiTemperature').value = '0';
    document.getElementById('trustServer').checked = true;
    document.getElementById('trustServer').dispatchEvent(new Event('change', { bubbles: true }));
    showCustomPrompt = (_title, _message, _defaultValue, callback) => callback('trusted-server');
    showCustomAlert = () => {};
    saveCurrentConfigProfile();
    const profile = JSON.parse(localStorage.getItem('configProfiles') || '{}')['trusted-server'];

    document.getElementById('trustServer').checked = false;
    showCustomConfirm = (_title, _message, callback) => callback(true);
    document.getElementById('configProfileSelect').value = 'trusted-server';
    loadConfigProfile();
    const trustRestored = document.getElementById('trustServer').checked === true;
    const zeroTemperatureRestored = document.getElementById('aiTemperature').value === '0';

    document.getElementById('sshHost').value = 'changed.example.test';
    document.getElementById('sshHost').dispatchEvent(new Event('input', { bubbles: true }));

    const rect = webhook.getBoundingClientRect();
    return {
        siblingTabs: commands.parentElement === body && webhook.parentElement === body,
        webhookVisible: webhook.classList.contains('active') && getComputedStyle(webhook).display !== 'none' && rect.width > 0 && rect.height > 0,
        webhookEditable: url instanceof HTMLInputElement && !url.disabled,
        webhookSaved,
        notificationRulesSaved: webhookPublicConfig.events.includes('program_stopped') && webhookPublicConfig.events.includes('output_matched') && webhookPublicConfig.outputRules.join('|') === '任务完成|Traceback' && webhookPublicConfig.outputCooldownSeconds === 120 && webhookPublicConfig.outputIgnoreCase === false && webhookPublicConfig.includeOutput === true,
        urlProtected,
        trustSaved: profile?.trustServer === true,
        trustRestored,
        zeroTemperatureRestored,
        trustRevokedAfterIdentityChange: document.getElementById('trustServer').checked === false
    };
})()`;

const clipboardSmokeExpression = `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (predicate()) return;
            await wait(50);
        }
        throw new Error('clipboard smoke condition timed out: ' + JSON.stringify({
            activeTabId,
            tabs: [...terminalTabs.keys()],
            inputs: window.__terminalInputs,
            writes: window.__clipboardWrites,
            reads: window.__clipboardReads,
            selection: terminalTabs.get('tab-1')?.terminal?.hasSelection?.(),
            selectionText: terminalTabs.get('tab-1')?.terminal?.getSelection?.(),
            textarea: !!terminalTabs.get('tab-1')?.terminal?.textarea
        }));
    };
    const firstInfo = terminalTabs.get('tab-1');
    const firstTerminal = firstInfo?.terminal;
    if (!firstInfo || !firstTerminal) return { terminalReady: false };
    window.__terminalInputs = window.__terminalInputs || [];
    window.__clipboardWrites = window.__clipboardWrites || [];
    window.__clipboardReads = window.__clipboardReads || [];
    firstInfo.localTerminalActive = true;
    firstTerminal.reset();
    await new Promise((resolve) => firstTerminal.write('AIT_CLIPBOARD_COPY', resolve));
    firstTerminal.select(0, 0, 'AIT_CLIPBOARD_COPY'.length);
    const beforeCopyWrites = window.__clipboardWrites?.length || 0;
    const copyEvent = await ${terminalKeyExpression('tab-1', "terminalTabs.get('tab-1')?.terminal", 'C', 'KeyC', { ctrlKey: true, shiftKey: true })};
    await waitFor(() => (window.__clipboardWrites?.length || 0) > beforeCopyWrites);
    const copied = window.__clipboardWrites.at(-1);

    window.__deferClipboardRead = false;
    const pasteBefore = window.__terminalInputs.length;
    window.__setClipboardSmokeText('AIT_CLIPBOARD_PASTE');
    const pasteEvent = await ${terminalKeyExpression('tab-1', "terminalTabs.get('tab-1')?.terminal", 'V', 'KeyV', { ctrlKey: true, shiftKey: true })};
    await waitFor(() => window.__terminalInputs.length > pasteBefore);
    const pasted = window.__terminalInputs.at(-1);

    firstTerminal.select(0, 0, 'AIT_CLIPBOARD_COPY'.length);
    const beforeEnterWrites = window.__clipboardWrites.length;
    const enterDispatch = await ${terminalKeyExpression('tab-1', "terminalTabs.get('tab-1')?.terminal", 'Enter', 'Enter')};
    await waitFor(() => window.__clipboardWrites.length > beforeEnterWrites && !firstTerminal.hasSelection());
    const enterCopied = window.__clipboardWrites.at(-1);
    const enterSelectionCleared = !firstTerminal.hasSelection();

    await createNewTerminalTab();
    await waitFor(() => terminalTabs.has('tab-2') && terminalTabs.get('tab-2')?.terminal);
    const secondInfo = terminalTabs.get('tab-2');
    secondInfo.localTerminalActive = true;
    const secondTerminal = secondInfo.terminal;

    switchToTab('tab-1');
    firstTerminal.select(0, 0, 'AIT_CLIPBOARD_COPY'.length);
    window.__deferClipboardWrite = true;
    const beforeLateCopyWrites = window.__clipboardWrites.length;
    const lateCopyDispatch = ${terminalKeyExpression('tab-1', "terminalTabs.get('tab-1')?.terminal", 'C', 'KeyC', { ctrlKey: true, shiftKey: true })};
    await waitFor(() => window.__clipboardWrites.length > beforeLateCopyWrites && typeof window.__resolveClipboardWrite === 'function');
    switchToTab('tab-2');
    window.__resolveClipboardWrite();
    await lateCopyDispatch;
    await wait(50);
    window.__deferClipboardWrite = false;

    switchToTab('tab-1');
    window.__setClipboardSmokeText('AIT_CLIPBOARD_LATE_PASTE');
    window.__deferClipboardRead = true;
    const beforeLatePaste = window.__terminalInputs.length;
    const latePasteDispatch = ${terminalKeyExpression('tab-1', "terminalTabs.get('tab-1')?.terminal", 'V', 'KeyV', { ctrlKey: true, shiftKey: true })};
    await waitFor(() => window.__clipboardReads.some((entry) => entry.tabId === 'tab-1') && typeof window.__resolveClipboardRead === 'function');
    switchToTab('tab-2');
    window.__resolveClipboardRead();
    await latePasteDispatch;
    await wait(50);

    return {
        terminalReady: true,
        copyShortcut: copied?.text === 'AIT_CLIPBOARD_COPY' && copied?.tabId === 'tab-1' && copyEvent.defaultPrevented === true,
        pasteShortcut: pasted?.tabId === 'tab-1' && pasted?.data === 'AIT_CLIPBOARD_PASTE' && pasteEvent.defaultPrevented === true,
        enterCopiesAndClears: enterCopied?.text === 'AIT_CLIPBOARD_COPY' && enterCopied?.tabId === 'tab-1' && enterSelectionCleared && enterDispatch.defaultPrevented === true,
        enterDefaultPrevented: enterDispatch.defaultPrevented === true,
        lateCopyFailsClosed: firstTerminal.hasSelection(),
        latePasteFailsClosed: window.__terminalInputs.length === beforeLatePaste,
        allClipboardCallsCarryTab: [...(window.__clipboardWrites || []), ...(window.__clipboardReads || [])].every((entry) => typeof entry.tabId === 'string')
    };
})()`;

async function main() {
    const chrome = findChrome();
    if (!chrome) throw new Error('Chrome/Chromium not found; set CHROME_PATH to run this integration smoke test');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiterminal-config-modal-'));
    const port = await reservePort();
    const pageUrl = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
    const child = spawn(chrome, [
        '--no-sandbox',
        '--headless',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--no-first-run',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32768); });

    let client;
    try {
        const page = await waitForPage(port, child);
        client = await CdpClient.connect(page.webSocketDebuggerUrl);
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source: electronApiBootstrap });
        await client.send('Page.navigate', { url: pageUrl });
        await waitForExpression(client, "document.readyState === 'complete' && typeof createSSHModal === 'function'");
        await client.send('Runtime.evaluate', { expression: electronApiBootstrap });
        const evaluation = await client.send('Runtime.evaluate', {
            expression: modalSmokeExpression,
            awaitPromise: true,
            returnByValue: true
        });
        if (evaluation.exceptionDetails) {
            throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
        }
        const result = evaluation.result?.value || {};
        const failures = Object.entries(result).filter(([, value]) => value !== true).map(([key]) => key);
        if (failures.length) throw new Error(`config modal smoke failed: ${failures.join(', ')}`);

        const clipboardEvaluation = await client.send('Runtime.evaluate', {
            expression: clipboardSmokeExpression,
            awaitPromise: true,
            returnByValue: true
        });
        if (clipboardEvaluation.exceptionDetails) {
            throw new Error(clipboardEvaluation.exceptionDetails.exception?.description || clipboardEvaluation.exceptionDetails.text);
        }
        const clipboardResult = clipboardEvaluation.result?.value || {};
        const clipboardFailures = Object.entries(clipboardResult).filter(([, value]) => value !== true).map(([key]) => key);
        if (clipboardFailures.length) throw new Error(`clipboard smoke failed: ${clipboardFailures.join(', ')} (${JSON.stringify(clipboardResult)})`);
        console.log('config modal smoke ok');
    } catch (error) {
        throw new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
    } finally {
        await closeChrome(client, child);
        await removeProfile(profile);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
