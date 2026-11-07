'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const CHROME_TIMEOUT_MS = 60000;

function findChrome() {
    const playwrightRoot = path.join(os.homedir(), '.cache', 'ms-playwright');
    let playwrightHeadlessShells = [];
    try {
        playwrightHeadlessShells = fs.readdirSync(playwrightRoot)
            .filter((entry) => entry.startsWith('chromium_headless_shell-'))
            .sort()
            .reverse()
            .map((entry) => path.join(playwrightRoot, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    } catch {}
    const candidates = [
        process.env.CHROME_PATH,
        ...playwrightHeadlessShells,
        process.platform === 'win32' ? path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        process.platform === 'win32' ? path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
        '/usr/local/bin/google-chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function rendererResultStatus(output) {
    const resultTag = String(output || '').match(/<pre\b[^>]*\bid=["']result["'][^>]*>/i)?.[0];
    return resultTag?.match(/\bdata-status=["'](pass|fail)["']/i)?.[1]?.toLowerCase() || null;
}

function rendererResultDetail(output) {
    return String(output || '').match(/<pre\b[^>]*\bid=["']result["'][^>]*>([\s\S]*?)<\/pre>/i)?.[1] || null;
}

function runChrome(chrome, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(chrome, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let observedStatus = null;
        let timedOut = false;
        let spawnError = null;
        let stopRequested = false;
        let forceKillTimer = null;

        const stopChrome = () => {
            if (stopRequested) return;
            stopRequested = true;
            try { child.kill('SIGTERM'); } catch {}
            forceKillTimer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch {}
            }, 3000);
            forceKillTimer.unref?.();
        };
        const collect = (current, chunk) => (current + chunk).slice(-131072);
        const inspectOutput = () => {
            observedStatus = rendererResultStatus(stdout);
            if (observedStatus) stopChrome();
        };

        child.stdout.on('data', (chunk) => {
            stdout = collect(stdout, chunk);
            inspectOutput();
        });
        child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
        child.on('error', (error) => { spawnError = error; });

        const timeout = setTimeout(() => {
            timedOut = true;
            stopChrome();
        }, CHROME_TIMEOUT_MS);

        child.on('close', (exitCode, signal) => {
            clearTimeout(timeout);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            observedStatus ||= rendererResultStatus(stdout);
            if (observedStatus === 'pass') {
                resolve({ stdout, stderr });
                return;
            }
            const detail = rendererResultDetail(stdout) || stderr.trim() || stdout.trim() || 'unknown browser failure';
            if (spawnError) reject(new Error(`${spawnError.message}\n${detail}`));
            else if (observedStatus === 'fail') reject(new Error(`renderer security smoke failed: ${detail}`));
            else if (timedOut) reject(new Error(`Chrome timed out after ${CHROME_TIMEOUT_MS}ms\n${detail}`));
            else reject(new Error(`Chrome exited before reporting a result (exit=${exitCode}, signal=${signal || 'none'})\n${detail}`));
        });
    });
}

async function main() {
    const chrome = findChrome();
    if (!chrome) throw new Error('Chrome/Chromium not found; set CHROME_PATH to run this integration smoke test');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiterminal-renderer-security-'));
    const page = pathToFileURL(path.join(__dirname, 'rendererSecuritySmoke.html')).href;
    try {
        const isHeadlessShell = /headless[-_]shell/i.test(path.basename(chrome));
        const args = [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--no-first-run',
            '--no-default-browser-check',
            '--virtual-time-budget=5000',
            `--user-data-dir=${profile}`,
            '--dump-dom',
            page
        ];
        if (!isHeadlessShell) args.unshift('--headless=new');
        const childEnv = { ...process.env };
        delete childEnv.LD_LIBRARY_PATH;
        await runChrome(chrome, args, childEnv);
        console.log('renderer security smoke ok');
    } finally {
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

module.exports = { findChrome, rendererResultStatus };

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
