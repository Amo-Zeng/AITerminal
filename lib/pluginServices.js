'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { quotePosix } = require('./shellCommand');
const { auditCommand } = require('./securityAudit');
const { sanitizeTerminalSize } = require('./terminalSize');
const { commandSpec } = require('./localEnvironment');
function quotePowerShell(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function commandText(params, shell) {
    let command;
    if (Array.isArray(params.argv) && params.argv.length && params.argv.length <= 100 && params.argv.every(v => typeof v === 'string' && !/[\0\r\n]/.test(v))) {
        command = (shell === 'powershell' ? '& ' : '') + params.argv.map(shell === 'powershell' ? quotePowerShell : quotePosix).join(' ');
    } else if (typeof params.command === 'string') command = params.command;
    if (!command || command.length > 64000 || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) throw new Error('插件命令无效');
    return command;
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
function shellSpec(binding, command, interactive = false) {
    if (binding.environment) return commandSpec(binding.environment, command, binding.cwd, { interactive });
    if (binding.shell === 'powershell') {
        // Windows PowerShell otherwise decodes native output using the OEM code
        // page, while the host service reads UTF-8 (e.g. Chinese Git subjects).
        // Suppress module-loading progress and use ordinary command mode:
        // Windows PowerShell serializes redirected errors from EncodedCommand
        // as CLIXML even when OutputFormat is Text. spawn passes this script as
        // one Unicode argument without an intermediate command shell.
        const script = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}\n` +
            '$aitermPluginSucceeded = $?; if ($aitermPluginSucceeded) { exit 0 }; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1';
        return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', script] };
    }
    if (binding.wsl) return { file: binding.wsl.file, args: ['-d', binding.wsl.distro, '--cd', binding.cwd || '~', '--exec', 'sh', '-lc', command] };
    return { file: '/bin/sh', args: ['-lc', command] };
}
function createPluginServices({ capture, approve, model, notify, context, getPty, observe = () => null }) {
    async function audited(owner, params, task, force = false) {
        const binding = task.binding || capture(owner);
        if (!binding.target || !binding.valid() || task.signal.aborted) throw new Error('执行目标已关闭或变化');
        if (binding.resolveCwd) binding.cwd = await binding.resolveCwd();
        if (!binding.valid() || task.signal.aborted) throw new Error('读取目录期间执行目标已变化');
        const command = commandText(params, binding.shell);
        const audit = auditCommand(command, { requiresConfirmation: force || params.requiresConfirmation === true });
        // Audit argv semantics as well as the exact quoted dispatch text. Quoting
        // an executable/flag must not hide `rm -rf`, `systemctl restart`, etc.
        const semantic = Array.isArray(params.argv) ? params.argv.map((arg, index) => index === 0 ? arg.replace(/^.*[\\/]/, '') : arg).join(' ') : command.replace(/['"]/g, '');
        const extra = auditCommand(semantic);
        audit.matches = [...new Map([...audit.matches, ...extra.matches].map(m => [m.id, m])).values()];
        audit.matchedPatterns = audit.matches.map(m => m.label);
        audit.requiresConfirmation = audit.matches.length > 0;
        audit.risk = audit.matches.some(m => m.severity === 'critical') ? 'critical' : audit.requiresConfirmation ? 'high' : 'low';
        if (!await approve(owner, command, audit, { ...binding, signal: task.signal })) throw new Error('用户取消高危操作');
        if (!binding.valid() || task.signal.aborted || !task.valid()) throw new Error('确认期间插件或执行目标已变化');
        return { command, binding };
    }
    function begin(binding, command, interactive, options, receive, exited, failed) {
        let cancel = () => {}, write = () => { throw new Error('会话尚未就绪'); }, resize = () => {};
        let cancelled = false;
        let readyResolve, readyReject;
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        ready.catch(() => {});
        const size = sanitizeTerminalSize(options.cols, options.rows);
        if (binding.target === 'remote') {
            const wrapped = binding.cwd ? `cd ${quotePosix(binding.cwd)} && ${command}` : command;
            binding.connection.exec(wrapped, interactive ? { pty: { term: 'xterm-256color', cols: size.cols, rows: size.rows } } : {}, (error, stream) => {
                if (error) { readyReject(error); return failed(error); }
                if (cancelled || !binding.valid()) { stream.close(); const error = new Error('SSH 会话已变化或任务取消'); readyReject(error); return failed(error); }
                cancel = () => { try { stream.signal('INT'); stream.close(); } catch {} };
                write = data => stream.write(data); resize = (cols, rows) => stream.setWindow(rows, cols, 0, 0);
                stream.on('data', receive); stream.stderr.on('data', receive); stream.on('error', failed); stream.on('close', (code, signal) => exited(code, signal));
                readyResolve();
            });
        } else {
            const spec = shellSpec(binding, command, interactive);
            const cwd = binding.environment ? spec.cwd : binding.wsl ? undefined : binding.cwd;
            if (interactive) {
                const pty = getPty(); if (!pty) throw new Error('PTY 模块不可用');
                const proc = pty.spawn(spec.file, spec.args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env: spec.env || { ...process.env, TERM: 'xterm-256color' } });
                proc.onData(receive); proc.onExit(e => exited(e.exitCode, e.signal));
                cancel = () => { try { proc.kill(); } catch {} }; write = data => proc.write(data); resize = (cols, rows) => proc.resize(cols, rows);
                readyResolve();
            } else {
                const proc = spawn(spec.file, spec.args, { cwd, env: spec.env || process.env, windowsHide: true, detached: process.platform !== 'win32' });
                proc.stdout.on('data', receive); proc.stderr.on('data', receive); proc.on('error', failed); proc.on('close', exited);
                cancel = () => killProcess(proc); write = data => proc.stdin.write(data);
                proc.once('spawn', readyResolve); proc.once('error', readyReject);
            }
        }
        return { ready, close: () => { cancelled = true; cancel(); readyReject(new Error('会话已取消')); }, write: data => { if (cancelled) throw new Error('会话已关闭'); write(data); }, resize: (...args) => resize(...args), get cancelled() { return cancelled; } };
    }
    async function exec(owner, params, task, force) {
        const { command, binding } = await audited(owner, params, task, force);
        const observer = observe(owner, binding, command);
        return new Promise((resolve, reject) => {
            let output = '', settled = false, session;
            const decoder = new StringDecoder('utf8');
            const finish = (error, code, signal) => {
                if (settled) return; settled = true;
                task.signal.removeEventListener('abort', cancel); task.disposables?.delete(cancel);
                output += decoder.end();
                observer?.stop({ exitCode: code, signal, error: error?.message, reason: task.signal.aborted ? 'cancelled' : binding.target === 'remote' && (error || (code == null && !signal)) ? 'connection_lost' : '' });
                error ? reject(error) : resolve({ output, exitCode: code ?? null, signal: signal || null });
            };
            const cancel = () => { session?.close(); finish(new Error('命令已取消；远端退出状态需核实')); };
            try { session = begin(binding, command, false, params, chunk => {
                if (settled) return;
                const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
                observer?.output(text);
                if (Buffer.byteLength(output) + Buffer.byteLength(text) > 1024 * 1024) { session.close(); finish(new Error('命令输出超过 1 MiB，请缩小查询范围')); return; }
                output += text; task.output = ((task.output || '') + text).slice(-65536); task.onOutput?.(text);
            }, (code, signal) => finish(null, code, signal), error => finish(error)); }
            catch (error) { finish(error); return; }
            task.signal.addEventListener('abort', cancel, { once: true }); task.disposables?.add(cancel);
            if (task.signal.aborted) cancel();
        });
    }
    async function open(owner, params, task) {
        const { command, binding } = await audited(owner, params, task);
        task.sessions ||= new Map();
        if (task.sessions.size >= 4) throw new Error('任务交互会话过多');
        const id = crypto.randomUUID(), entry = { output: '', cursor: 0, ended: false, exitCode: null, waiters: new Set(), binding };
        entry.observer = observe(owner, binding, command);
        const wake = () => { for (const resolve of entry.waiters) resolve(); entry.waiters.clear(); };
        try {
            entry.session = begin(binding, command, true, params, chunk => { entry.observer?.output(chunk); const text = String(chunk); entry.output = (entry.output + text).slice(-65536); entry.cursor += text.length; task.output = ((task.output || '') + text).slice(-65536); task.onOutput?.(text); wake(); }, (code, signal) => { entry.observer?.stop({ exitCode: code, signal, reason: binding.target === 'remote' && code == null && !signal ? 'connection_lost' : '' }); entry.ended = true; entry.exitCode = code; wake(); }, error => { entry.observer?.stop({ error: error.message, reason: binding.target === 'remote' ? 'connection_lost' : '' }); entry.ended = true; entry.error = error.message; wake(); });
        } catch (error) { entry.observer?.stop({ error: error.message }); throw error; }
        task.sessions.set(id, entry);
        const cancel = () => { entry.observer?.stop({ reason: 'cancelled' }); entry.session.close(); entry.ended = true; wake(); };
        task.disposables.add(cancel); task.signal.addEventListener('abort', cancel, { once: true });
        if (task.signal.aborted) cancel();
        await entry.session.ready;
        return { sessionId: id };
    }
    return async function service(owner, method, params, task) {
        if (method === 'mcp.start' || method === 'mcp.audit') {
            const binding = capture(owner, { mode: 'host' });
            const command = method === 'mcp.start' ? commandText({ argv: [params.command, ...params.args] }, binding.shell) : `MCP 操作: ${params.title}`;
            if (!await approve(owner, command, auditCommand(command, { requiresConfirmation: method === 'mcp.audit' }), { ...binding, signal: task.signal }) || !task.valid()) throw new Error('MCP 操作取消或标签已关闭');
            return true;
        }
        if (method === 'terminal.exec') return exec(owner, params, task);
        if (method === 'terminal.open') return open(owner, params, task);
        if (method.startsWith('terminal.')) {
            const entry = task.sessions?.get(params.sessionId);
            if (!entry || !entry.binding.valid()) throw new Error('交互会话不属于此任务或连接已变化');
            if (method === 'terminal.read') {
                const cursor = Number.isSafeInteger(params.cursor) ? params.cursor : 0;
                if (!entry.ended && entry.cursor <= cursor) await new Promise(resolve => {
                    const finish = () => { clearTimeout(timer); entry.waiters.delete(finish); resolve(); };
                    const timer = setTimeout(finish, Math.min(10000, Math.max(0, Number(params.waitMs) || 1000))); entry.waiters.add(finish);
                });
                const available = Math.max(0, entry.cursor - cursor);
                return { text: available ? entry.output.slice(-available) : '', cursor: entry.cursor, truncated: available > entry.output.length, ended: entry.ended, exitCode: entry.exitCode, error: entry.error || '' };
            }
            if (method === 'terminal.write') {
                if (typeof params.text !== 'string' || params.text.length > 16000 || /\0/.test(params.text)) throw new Error('交互输入无效');
                if (params.text !== '\x03') await audited(owner, { command: params.text.replace(/[\r\n]+$/, '') }, task);
                entry.session.write(params.text); return true;
            }
            if (method === 'terminal.resize') { const size = sanitizeTerminalSize(params.cols, params.rows); entry.session.resize(size.cols, size.rows); return true; }
            if (method === 'terminal.close') { entry.observer?.stop({ reason: 'cancelled' }); entry.session.close(); entry.ended = true; return true; }
        }
        if (method === 'files.read' || method === 'files.write') {
            if (typeof params.path !== 'string' || !params.path || /[\0\r\n]/.test(params.path)) throw new Error('文件路径无效');
            const shell = task.binding.shell;
            // PowerShell 5's Get-Content defaults to the ANSI code page and its
            // output formatter appends a newline. File reads must preserve UTF-8
            // and the exact trailing newlines, just like the POSIX cat path.
            if (method === 'files.read') return exec(owner, shell === 'powershell' ? { command: `[Console]::Write([IO.File]::ReadAllText(${quotePowerShell(params.path)}, [Text.Encoding]::UTF8))` } : { argv: ['cat', '--', params.path] }, task);
            if (typeof params.text !== 'string' || Buffer.byteLength(params.text) > 32768) throw new Error('单次写入最多 32 KiB');
            const encoded = Buffer.from(params.text).toString('base64');
            const command = shell === 'powershell' ? `[IO.File]::WriteAllBytes(${quotePowerShell(params.path)},[Convert]::FromBase64String('${encoded}'))` : `printf %s '${encoded}' | base64 -d > ${quotePosix(params.path)}`;
            return exec(owner, { command }, task, true);
        }
        if (method === 'models.request') return model(owner, params, task);
        if (method === 'notifications.send') return notify(owner, params, task);
        if (method === 'context.read') {
            if (task.binding.resolveCwd) task.binding.cwd = await task.binding.resolveCwd();
            if (!task.binding.valid()) throw new Error('读取目录期间执行目标已变化');
            return context(owner, task);
        }
        throw new Error('未知宿主服务');
    };
}
module.exports = { createPluginServices, commandText, shellSpec, killProcess };
