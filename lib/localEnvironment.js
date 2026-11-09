'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { quotePosix } = require('./shellCommand');

function createLocalEnvironment({ platform = process.platform, env = process.env, cwd = os.homedir(), exists = fs.existsSync } = {}) {
    const variables = { ...env, TERM: 'xterm-256color', COLORTERM: env.COLORTERM || 'truecolor', AITerminal: '1' };
    if (platform === 'win32') {
        const distro = (env.AIT_TERMINAL_WSL_DISTRO || 'Ubuntu').trim() || 'Ubuntu';
        return { kind: 'wsl', platform: 'linux', shell: 'posix', shellFile: null, label: `WSL ${distro}`, cwd: '~', env: variables,
            wsl: Object.freeze({ file: env.AIT_TERMINAL_SHELL || 'wsl.exe', distro }) };
    }
    const shellFile = [env.AIT_TERMINAL_SHELL, env.SHELL, '/bin/bash', '/bin/sh'].find(file => file && exists(file));
    if (!shellFile) throw new Error('找不到本地 Shell');
    return { kind: 'native', platform, shell: 'posix', shellFile, label: path.basename(shellFile), cwd, env: variables, wsl: null };
}

// A startup-only, private OSC record identifies the Linux shell behind wsl.exe.
// It does not install prompt hooks, touch rc files, or type commands into a TUI.
function terminalLaunch(environment) {
    if (!environment.wsl) return { file: environment.shellFile, args: [], cwd: environment.cwd, tracker: null };
    const tracker = new EnvironmentTracker(environment);
    const script = `printf '\\033]777;aiterm-env;${tracker.token};%s;%s;%s\\007' "$$" "$(printf %s "$PWD" | base64 | tr -d '\\n')" "$(printf %s "\${SHELL:-/bin/sh}" | base64 | tr -d '\\n')"\nexec "\${SHELL:-/bin/sh}" -il`;
    return { file: environment.wsl.file, args: ['-d', environment.wsl.distro, '--cd', environment.cwd, '--exec', '/bin/sh', '-c', script], cwd: undefined, tracker };
}
class EnvironmentTracker {
    constructor(environment) {
        this.environment = environment; this.token = crypto.randomBytes(16).toString('hex');
        this.prefix = `\x1b]777;aiterm-env;${this.token};`; this.buffer = ''; this.pid = null;
    }
    feed(text) {
        if (this.pid) return text;
        this.buffer += text;
        const index = this.buffer.indexOf(this.prefix);
        if (index < 0) {
            let keep = Math.min(this.buffer.length, this.prefix.length - 1);
            while (keep > 0 && !this.prefix.startsWith(this.buffer.slice(-keep))) keep--;
            const output = this.buffer.slice(0, this.buffer.length - keep); this.buffer = keep ? this.buffer.slice(-keep) : ''; return output;
        }
        const end = this.buffer.indexOf('\x07', index);
        if (end < 0) {
            if (this.buffer.length - index > 16384) throw new Error('本地终端环境标记过长');
            const output = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index); return output;
        }
        const fields = this.buffer.slice(index + this.prefix.length, end).split(';');
        const pid = Number(fields[0]), cwd = Buffer.from(fields[1] || '', 'base64').toString('utf8'), shellFile = Buffer.from(fields[2] || '', 'base64').toString('utf8');
        if (!Number.isSafeInteger(pid) || pid < 1 || !isPosixPath(cwd) || !isPosixPath(shellFile)) throw new Error('本地终端环境标记无效');
        this.pid = pid; Object.assign(this.environment, { cwd, shellFile });
        const output = this.buffer.slice(0, index) + this.buffer.slice(end + 1); this.buffer = ''; return output;
    }
}
function isPosixPath(value) { return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\0\r\n]/.test(value); }
function directoryExpression(cwd) {
    if (typeof cwd !== 'string' || !cwd || /[\0\r\n]/.test(cwd)) throw new Error('本地工作目录无效');
    if (cwd === '~') return '"$HOME"';
    if (cwd.startsWith('~/')) return '"$HOME"/' + quotePosix(cwd.slice(2));
    if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\')) throw new Error('当前终端使用 Linux/Unix 路径；Windows 文件请使用 /mnt/c/... 等终端路径');
    return quotePosix(cwd);
}
function commandSpec(environment, command, cwd = environment.cwd, { interactive = false } = {}) {
    if (!environment?.shellFile) throw new Error('本地终端环境尚未就绪，请稍后重试');
    const base = path.posix.basename(environment.shellFile);
    const flag = interactive && ['bash', 'zsh', 'fish'].includes(base) ? '-lic' : ['bash', 'zsh'].includes(base) ? '-lc' : '-c';
    // Startup files may change directories. Re-enter the bound directory after
    // loading them, and fail instead of running in an unintended directory.
    const script = `cd -- ${directoryExpression(cwd)} ${base === 'fish' ? '; or exit $status' : '|| exit $?'}\n${command}`;
    if (environment.wsl) return { file: environment.wsl.file, args: ['-d', environment.wsl.distro, '--cd', '~', '--exec', environment.shellFile, flag, script], cwd: undefined, env: environment.env };
    return { file: environment.shellFile, args: [flag, script], cwd: environment.cwd, env: environment.env };
}
function wrappedCommand(environment, command, token) {
    if (path.posix.basename(environment.shellFile) === 'fish') return `begin\n${command}\nend\nset -l aiterm_exit_status $status\nprintf '\\n${token}PWD:%s\\n${token}EXIT:%s\\n' "$PWD" "$aiterm_exit_status"\nexit $aiterm_exit_status`;
    return `{\n${command}\n}\naiterm_exit_status=$?\nprintf '\\n${token}PWD:%s\\n${token}EXIT:%s\\n' "$PWD" "$aiterm_exit_status"\nexit "$aiterm_exit_status"`;
}
function killProcess(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch {} });
    } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
        const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 750); timer.unref();
    }
}
function runCommand(spec, { signal, valid = () => true, onOutput, timeoutMs = 120000, maxBytes = 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted || !valid()) return reject(new Error('本地执行目标已关闭、变化或任务已取消'));
        let child, output = '', bytes = 0, settled = false;
        const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
        const finish = (error, exitCode, exitSignal) => {
            if (settled) return; settled = true; clearTimeout(timer); clearInterval(guard); signal?.removeEventListener('abort', cancel);
            if (error) { killProcess(child); reject(error); }
            else { output += decoders.map(decoder => decoder.end()).join(''); resolve({ output, exitCode, signal: exitSignal }); }
        };
        const cancel = () => finish(new Error('本地命令已取消'));
        const timer = setTimeout(() => finish(new Error('本地命令超时；长时间交互程序请使用 interactive_start')), timeoutMs);
        const guard = setInterval(() => { if (!valid()) finish(new Error('本地执行目标已关闭或变化')); }, 100);
        try {
            child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env || process.env, windowsHide: true, detached: process.platform !== 'win32' });
            [child.stdout, child.stderr].forEach((stream, index) => stream.on('data', chunk => {
                if (settled) return;
                bytes += chunk.length;
                if (bytes > maxBytes) return finish(new Error('本地命令输出超过大小限制，请缩小查询范围'));
                const text = decoders[index].write(chunk); output += text; onOutput?.(text);
            }));
            child.on('error', error => finish(new Error(`本地命令启动失败：${error.code || '未知错误'}`)));
            child.on('close', (code, reason) => finish(null, code, reason));
            child.stdin.end();
            signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
        } catch (error) { finish(error); }
    });
}
async function terminalDirectory(session, requested, valid = () => session.active) {
    const environment = session.environment;
    if (!environment) throw new Error('缺少本地终端环境，请重新打开本地标签');
    // The WSL marker is emitted before shell startup. Wait without typing into
    // the terminal, which may already be running an interactive application.
    const deadline = Date.now() + 8000;
    while (!environment.shellFile && valid() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!valid()) throw new Error('本地终端已关闭或变化');
    if (!environment.shellFile) throw new Error('WSL 终端尚未就绪，请检查 Ubuntu 是否已安装并成功启动');
    let cwd = session.cwd || environment.cwd;
    const pid = environment.wsl ? session.environmentTracker?.pid : session.pty?.pid;
    if (session.active && pid) {
        if (environment.platform === 'linux' && !environment.wsl) cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        else if (environment.wsl) {
            const result = await runCommand({ file: environment.wsl.file, args: ['-d', environment.wsl.distro, '--exec', '/bin/readlink', '-e', `/proc/${pid}/cwd`], env: environment.env }, { valid, timeoutMs: 8000, maxBytes: 16384 });
            if (result.exitCode !== 0) throw new Error('无法读取 WSL 终端当前目录'); cwd = result.output.trim();
        } else if (environment.platform === 'darwin') {
            const result = await runCommand({ file: '/usr/sbin/lsof', args: ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'] }, { valid, timeoutMs: 8000, maxBytes: 16384 });
            cwd = result.output.split('\n').find(line => line.startsWith('n'))?.slice(1);
        }
    }
    const token = `__AITERM_CWD_${crypto.randomBytes(12).toString('hex')}__`;
    const command = `${requested ? `cd -- ${directoryExpression(requested)} || exit $?\n` : ''}printf '${token}%s\\n' "$PWD"`;
    // Directory probes use POSIX sh even when the user's shell is fish.
    const result = await runCommand(commandSpec({ ...environment, shellFile: '/bin/sh' }, command, cwd), { valid, timeoutMs: 8000, maxBytes: 32768 });
    const resolved = result.output.split(/\r?\n/).find(line => line.startsWith(token))?.slice(token.length);
    if (result.exitCode !== 0 || !isPosixPath(resolved)) throw new Error('无法访问终端工作目录，请使用当前终端系统中的目录');
    if (!valid()) throw new Error('读取目录期间终端已关闭或变化');
    if (!requested) session.cwd = resolved;
    return resolved;
}
async function executeInEnvironment(environment, command, cwd, options = {}) {
    const token = `__AITERM_LOCAL_META_${crypto.randomBytes(16).toString('hex')}__`;
    const result = await runCommand(commandSpec(environment, wrappedCommand(environment, command, token), cwd), options);
    let newCwd = cwd;
    const output = result.output.split(/\r?\n/).filter(line => {
        if (line.startsWith(token + 'PWD:')) { const value = line.slice(token.length + 4); if (isPosixPath(value)) newCwd = value; return false; }
        return !line.startsWith(token + 'EXIT:');
    }).join('\n').trimEnd();
    return { ...result, output, cwd: newCwd, shell: environment.shellFile };
}
module.exports = { createLocalEnvironment, terminalLaunch, commandSpec, terminalDirectory, executeInEnvironment, runCommand, killProcess, EnvironmentTracker };
