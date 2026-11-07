'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const STARTUP_TIMEOUT_MS = 30000;

function existsFile(filePath) {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function findPackagedExecutable(releaseDirectory, platform = process.platform) {
    if (platform === 'win32') {
        const executable = path.join(releaseDirectory, 'win-unpacked', 'AITerminal.exe');
        if (existsFile(executable)) return executable;
    } else if (platform === 'linux') {
        for (const name of ['aiterminal', 'AITerminal']) {
            const executable = path.join(releaseDirectory, 'linux-unpacked', name);
            if (existsFile(executable)) return executable;
        }
    } else if (platform === 'darwin') {
        for (const directory of fs.readdirSync(releaseDirectory, { withFileTypes: true })) {
            if (!directory.isDirectory() || !directory.name.startsWith('mac')) continue;
            const executable = path.join(
                releaseDirectory,
                directory.name,
                'AITerminal.app',
                'Contents',
                'MacOS',
                'AITerminal'
            );
            if (existsFile(executable)) return executable;
        }
    }
    throw new Error(`packaged executable was not found for ${platform}`);
}

function hasRendererReadyOutput(output) {
    return /App initialization complete/.test(String(output || ''));
}

function hasPackagedRuntimeReadyOutput(output, platform = process.platform) {
    const text = String(output || '');
    return hasRendererReadyOutput(text) && (platform === 'win32' || /Local PTY session ready/.test(text));
}

async function terminateProcessTree(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        child.stdout?.destroy(); child.stderr?.destroy();
        return;
    }
    let closed = child.exitCode !== null && child.stdout?.destroyed && child.stderr?.destroyed;
    const exited = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        try { child.kill('SIGTERM'); } catch {}
    }
    if (!closed) await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    if (!closed) {
        // Electron helpers can retain inherited output pipes after the browser
        // exits. Kill the owned process group, then release those handles.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 750))]);
    }
    child.stdout?.destroy(); child.stderr?.destroy();
}

async function main() {
    const releaseDirectory = path.resolve('release');
    const executable = process.argv[2]
        ? path.resolve(process.argv[2])
        : findPackagedExecutable(releaseDirectory);
    if (!existsFile(executable)) throw new Error(`packaged executable is missing: ${executable}`);

    let command = executable;
    let args = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];
    if (process.platform === 'linux' && !process.env.DISPLAY) {
        command = 'xvfb-run';
        args = ['-a', executable, ...args];
    }

    const child = spawn(command, args, {
        cwd: path.dirname(executable),
        detached: process.platform !== 'win32',
        env: {
            ...process.env,
            AITERMINAL_PLUGIN_RUNTIME_SMOKE: '1',
            ELECTRON_ENABLE_LOGGING: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-32768); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32768); });
    child.on('error', (error) => { spawnError = error; });

    try {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            if (hasPackagedRuntimeReadyOutput(`${stdout}\n${stderr}`) && stdout.includes('AITERM_PLUGIN_HOST_READY')) {
                console.log(`packaged startup smoke ok: ${executable}`);
                return;
            }
            if (stderr.includes('AITERM_PLUGIN_HOST_FAILED')) throw new Error('packaged plugin host validation failed');
            if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(`packaged application exited before renderer readiness (exit=${child.exitCode})`);
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`packaged startup smoke timed out after ${STARTUP_TIMEOUT_MS}ms`);
    } catch (error) {
        const diagnostics = [error.message, stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        throw new Error(diagnostics);
    } finally {
        await terminateProcessTree(child);
    }
}

module.exports = { findPackagedExecutable, hasRendererReadyOutput, hasPackagedRuntimeReadyOutput, terminateProcessTree };

if (require.main === module) {
    main().catch((error) => {
        console.error(`packaged startup smoke failed: ${error.message}`);
        process.exit(1);
    });
}
