'use strict';

const { app } = require('electron');

function finish(code, message) {
    if (message) (code === 0 ? console.log : console.error)(message);
    app.exit(code);
}

app.whenReady().then(() => {
    let pty;
    try {
        pty = require('../lib/nodePty');
    } catch (error) {
        finish(1, `node-pty load failed in Electron: ${error.message}`);
        return;
    }

    const windows = process.platform === 'win32';
    const file = windows ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
    const args = windows ? ['/d', '/s', '/c', 'echo AIT_PTY_OK'] : ['-lc', 'printf AIT_PTY_OK'];
    let output = '';
    let child;
    try {
        child = pty.spawn(file, args, {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: process.env
        });
        child.resize(100, 30);
    } catch (error) {
        finish(1, `node-pty spawn failed in Electron: ${error.message}`);
        return;
    }

    const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(1, 'node-pty Electron smoke test timed out');
    }, 10000);
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        const ok = exitCode === 0 && output.includes('AIT_PTY_OK');
        finish(ok ? 0 : 1, ok ? 'node-pty Electron smoke ok' : `unexpected PTY result: exit=${exitCode}`);
    });
}).catch((error) => finish(1, error.message));
