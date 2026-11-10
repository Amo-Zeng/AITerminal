'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getElectronPath, assertElectronBinaryCompatible } = require('./electronBinary');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 30000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
        });
        socket.addEventListener('close', () => {
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Electron CDP connection closed'));
            }
            this.pending.clear();
        });
    }

    static async connect(url) {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Electron CDP connection timed out')), TIMEOUT_MS);
            socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('Electron CDP connection failed'));
            }, { once: true });
        });
        return new CdpClient(socket);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        // Capture the caller before entering the timer so CI timeouts identify
        // the stalled test action without logging evaluated scripts or secrets.
        const timeoutError = new Error(`Electron CDP command timed out: ${method}`);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(timeoutError);
            }, TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        this.socket.close();
    }
}

async function waitForPage(port, child, output) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Electron exited before CDP was ready (${child.exitCode})\n${output()}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await response.json();
            // The first CDP target may still be about:blank. Executing an
            // async test there loses its context when loadFile completes.
            const page = targets.find((target) => target.type === 'page' && /\/index\.html(?:\?|$)/.test(target.url));
            if (page?.webSocketDebuggerUrl) return page;
        } catch {}
        await delay(100);
    }
    throw new Error(`Electron CDP endpoint timed out\n${output()}`);
}

async function terminateProcessTree(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        try { spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
        return;
    }
    const exited = new Promise((resolve) => child.once('close', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {
        try { child.kill('SIGTERM'); } catch {}
    }
    await Promise.race([exited, delay(750)]);
    if (child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {
            try { child.kill('SIGKILL'); } catch {}
        }
        await Promise.race([exited, delay(750)]);
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
}

const smokeExpression = `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            if (await predicate()) return;
            await wait(50);
        }
        throw new Error('terminal clipboard smoke condition timed out');
    };
    await waitFor(() => window.__aiterminalClipboardSmoke?.getTerminal('tab-1')?.textarea);
    const terminal = window.__aiterminalClipboardSmoke.getTerminal('tab-1');
    const originalClipboard = await window.electronAPI.clipboardReadText('tab-1');
    // Stop the startup shell so its prompt cannot race the deterministic test text.
    window.__aiterminalClipboardSmoke.stopLocalTerminal('tab-1');
    await wait(150);
    try {
        terminal.reset();
        await new Promise((resolve) => terminal.write('AIT_E2E_COPY', resolve));

        const dispatch = (key, code, modifiers = {}) => {
            terminal.focus();
            const event = new KeyboardEvent('keydown', {
                key,
                code,
                bubbles: true,
                cancelable: true,
                ctrlKey: modifiers.ctrlKey === true,
                metaKey: modifiers.metaKey === true,
                shiftKey: modifiers.shiftKey === true
            });
            terminal.textarea.dispatchEvent(event);
            return event.defaultPrevented;
        };

        terminal.select(0, 0, 'AIT_E2E_COPY'.length);
        const copyPrevented = dispatch('C', 'KeyC', { ctrlKey: true, shiftKey: true });
        let copied;
        await waitFor(async () => {
            copied = await window.electronAPI.clipboardReadText('tab-1');
            return copied?.success === true && copied.text === 'AIT_E2E_COPY';
        });

        terminal.select(0, 0, 'AIT_E2E_COPY'.length);
        const enterPrevented = dispatch('Enter', 'Enter');
        await waitFor(() => !terminal.hasSelection());
        const enterCopied = await window.electronAPI.clipboardReadText('tab-1');

        const inputs = [];
        const listener = terminal.onData((data) => inputs.push(data));
        await window.electronAPI.clipboardWriteText('AIT_E2E_PASTE', 'tab-1');
        const pastePrevented = dispatch('V', 'KeyV', { ctrlKey: true, shiftKey: true });
        await waitFor(() => inputs.includes('AIT_E2E_PASTE'));
        listener.dispose();

        return {
            copy: copyPrevented && copied?.success === true && copied.text === 'AIT_E2E_COPY',
            enter: enterPrevented && enterCopied?.success === true && enterCopied.text === 'AIT_E2E_COPY' && !terminal.hasSelection(),
            paste: pastePrevented && inputs.includes('AIT_E2E_PASTE')
        };
    } finally {
        if (originalClipboard?.success === true) {
            await window.electronAPI.clipboardWriteText(originalClipboard.text || '', 'tab-1');
        }
    }
})()`;

async function runElectronSmoke(runTest, options = {}) {
    const electronPath = getElectronPath();
    assertElectronBinaryCompatible(electronPath);
    const port = await reservePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiterminal-electron-smoke-'));
    if (options.prepareProfile) await options.prepareProfile(profile);
    const args = [
        ...(options.headless === false ? [] : ['--headless']),
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${port}`,
        options.entry || path.join(ROOT, 'main.js')
    ];
    const child = spawn(electronPath, args, {
        cwd: ROOT,
        detached: process.platform !== 'win32',
        env: {
            ...process.env,
            ELECTRON_ENABLE_LOGGING: '1',
            AITERMINAL_CLIPBOARD_SMOKE: '1',
            AITERMINAL_SMOKE_USER_DATA: profile
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const collect = (chunk) => { output = (output + chunk).slice(-32768); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let client;
    try {
        const page = await waitForPage(port, child, () => output);
        client = await CdpClient.connect(page.webSocketDebuggerUrl);
        const evaluate = async (expression) => {
            const evaluation = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (evaluation.exceptionDetails) {
                throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
            }
            return evaluation.result?.value;
        };
        const deadline = Date.now() + TIMEOUT_MS;
        let ready = false;
        while (Date.now() < deadline) {
            try {
                ready = await evaluate("document.readyState === 'complete' && !!window.__aiterminalClipboardSmoke?.getTerminal('tab-1')?.textarea");
                if (ready) break;
            } catch (error) {
                if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error;
            }
            await delay(50);
        }
        if (!ready) throw new Error('Electron renderer readiness timed out');
        await runTest({ client, evaluate });
    } catch (error) {
        throw new Error(`${error.stack || error.message}\n${output}`);
    } finally {
        client?.close();
        await terminateProcessTree(child);
        await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}

async function main() {
    await runElectronSmoke(async ({ evaluate }) => {
        const result = await evaluate(smokeExpression) || {};
        const failures = Object.entries(result).filter(([, value]) => value !== true).map(([key]) => key);
        if (!Object.keys(result).length || failures.length) throw new Error(`clipboard smoke failed: ${failures.join(', ')}`);
        console.log('Electron clipboard smoke ok');
    });
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`${error.message}\n${fs.existsSync(ROOT) ? '' : 'project root missing'}`);
        process.exit(1);
    });
}

module.exports = { smokeExpression, runElectronSmoke };
