'use strict';
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { quotePosix } = require('./shellCommand');

// A bounded incremental text view. ANSI sequences may be split at any byte.
// Rewrites/erases break the rolling text so old and new screen content cannot
// combine into a false match. Styling and OSC titles do not affect visible text.
class OutputMatcher {
    constructor(config, emit, now = Date.now) {
        this.config = config; this.emit = emit; this.now = now;
        this.decoder = new StringDecoder('utf8'); this.text = ''; this.mode = 'text'; this.sequence = '';
        this.offset = 0; this.ends = new Map(); this.last = new Map(); this.closed = false;
    }
    check() {
        const config = this.config();
        if (!config?.enabled || !config.events.includes('output_matched')) { this.text = ''; return; }
        const text = config.outputIgnoreCase ? this.text.toLowerCase() : this.text;
        for (const [index, rule] of config.outputRules.entries()) {
            const needle = config.outputIgnoreCase ? rule.toLowerCase() : rule;
            const position = text.lastIndexOf(needle);
            if (position < 0) continue;
            const end = this.offset - this.text.length + position + needle.length;
            if (end <= (this.ends.get(rule) ?? -1)) continue;
            this.ends.set(rule, end);
            const now = this.now();
            if (now - (this.last.get(rule) ?? -Infinity) < config.outputCooldownSeconds * 1000) continue;
            this.last.set(rule, now);
            this.emit({ ruleIndex: index + 1, pattern: rule, output: config.includeOutput ? this.text.slice(Math.max(0, position - 100), position + needle.length + 100) : undefined, message: `终端输出命中关键词 ${index + 1}`, dedupeKey: `${index}:${now}` });
        }
    }
    feed(chunk) {
        if (this.closed) return;
        const config = this.config();
        if (this.currentConfig !== config) {
            this.currentConfig = config;
            const signature = JSON.stringify([config?.enabled, config?.events.includes('output_matched'), config?.outputRules, config?.outputIgnoreCase, config?.outputCooldownSeconds, config?.includeOutput]);
            if (this.configSignature !== signature) {
                this.configSignature = signature; this.text = ''; this.ends.clear(); this.last.clear();
                this.mode = 'text'; this.decoder = new StringDecoder('utf8');
            }
        }
        if (!config?.enabled || !config.events.includes('output_matched') || !config.outputRules.length) { this.text = ''; this.mode = 'text'; return; }
        const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
        for (const char of text) {
            if (this.mode === 'osc' || this.mode === 'string') {
                if (char === '\x07' && this.mode === 'osc') this.mode = 'text';
                else if (char === '\x1b') { this.previousMode = this.mode; this.mode = 'string-end'; }
                continue;
            }
            if (this.mode === 'string-end') { this.mode = char === '\\' ? 'text' : this.previousMode; continue; }
            if (this.mode === 'escape') {
                this.mode = char === '[' ? 'csi' : char === ']' ? 'osc' : ['P', '^', '_'].includes(char) ? 'string' : 'text'; this.sequence = '';
                if (this.mode === 'text') { this.check(); this.text = ''; } continue;
            }
            if (this.mode === 'csi') {
                this.sequence += char;
                if (/[\x40-\x7e]/.test(char) || this.sequence.length > 128) {
                    if (char !== 'm') { this.check(); this.text = ''; }
                    this.mode = 'text'; this.sequence = '';
                }
                continue;
            }
            if (char === '\x1b') { this.mode = 'escape'; continue; }
            if (char === '\r' || char === '\n' || char === '\b' || char === '\t') { this.check(); this.text = ''; this.offset++; continue; }
            if (/[\x00-\x1f\x7f]/.test(char)) continue;
            this.text += char; this.offset += char.length;
            if (this.text.length >= 4096) { this.check(); this.text = this.text.slice(-400); }
        }
        this.check();
    }
    close() { this.closed = true; this.text = ''; this.ends.clear(); this.last.clear(); }
}

function createProgramObserver({ config, emit, target, source, command, now = Date.now, id = crypto.randomUUID() }) {
    const startedAt = now(); let stopped = false;
    const matcher = new OutputMatcher(config, data => emit('output_matched', { target, programSource: source, programId: id, ...data, dedupeKey: `${id}:${data.dedupeKey}` }), now);
    return {
        id, output: data => { if (!stopped) matcher.feed(data); },
        stop({ exitCode = null, signal = null, reason = '', error = '' } = {}) {
            if (stopped) return false;
            stopped = true; matcher.close();
            const code = Number.isInteger(exitCode) ? exitCode : null;
            const status = reason === 'connection_lost' || (reason === 'cancelled' && target === 'remote') ? 'unknown' : reason === 'cancelled' ? 'cancelled' : error ? 'failed' : signal || (code !== null && code !== 0) ? 'failed' : code === 0 ? 'completed' : 'unknown';
            const label = { completed: '程序正常结束', failed: '程序异常停止', cancelled: '程序监控已停止', unknown: '程序会话中断，退出状态未知' }[status];
            emit('program_stopped', { programId: id, target, programSource: source, status, exitCode: code, signal: signal || null, reason, durationMs: Math.max(0, now() - startedAt), command, message: label, dedupeKey: id });
            return true;
        }
    };
}

function monitoredCommand(command, id) {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error('无效程序监控 ID');
    // Catch interrupts in the supervising shell; the child resets caught traps
    // and still receives Ctrl+C. Even `exit`/SIGKILL in the child is reported.
    const prefix = `\\033]777;aiterm;${id};`;
    const script = `trap ':' INT QUIT\nprintf '${prefix}start\\007'\nsh -c "$1"\nait_notify_status=$?\nprintf '${prefix}end;%s\\007' "$ait_notify_status"\nexit "$ait_notify_status"`;
    return `sh -c ${quotePosix(script)} ait-notify ${quotePosix(command)}`;
}

class ProgramMarkers {
    constructor(id, observer) { this.id = id; this.observer = observer; this.buffer = ''; this.started = false; this.done = false; }
    feed(text) {
        if (this.done) return;
        text = String(text);
        for (let offset = 0; offset < text.length && !this.done; offset += 4096) this.consume(text.slice(offset, offset + 4096));
    }
    consume(text) {
        this.buffer += text;
        const start = `\x1b]777;aiterm;${this.id};start\x07`;
        if (!this.started) {
            const index = this.buffer.indexOf(start);
            if (index < 0) { this.buffer = this.buffer.slice(-start.length); return; }
            this.started = true; this.buffer = this.buffer.slice(index + start.length);
        }
        const end = new RegExp(`\\x1b\\]777;aiterm;${this.id};end;(\\d{1,3})\\x07`).exec(this.buffer);
        if (end && Number(end[1]) <= 255) { this.done = true; this.observer.stop({ exitCode: Number(end[1]) }); this.buffer = ''; }
        else this.buffer = this.buffer.slice(-100);
    }
    close(reason = 'connection_lost') { if (!this.done) { this.done = true; this.observer.stop({ reason }); } }
}
module.exports = { OutputMatcher, createProgramObserver, monitoredCommand, ProgramMarkers };
