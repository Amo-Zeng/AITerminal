'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { OutputMatcher, createProgramObserver, monitoredCommand, ProgramMarkers } = require('../lib/terminalNotifications');
const { normalizeWebhookConfig, validateOutputRules, buildWebhookPayload } = require('../lib/webhook');
const { createPluginServices } = require('../lib/pluginServices');
const config = extra => normalizeWebhookConfig({ enabled: true, events: ['output_matched', 'program_stopped'], outputRules: ['任务完成', 'error'], ...extra });

test('matching handles split UTF-8, split ANSI, OSC titles, rewrites and distinct occurrences with cooldown', () => {
    let now = 1000; const events = [], settings = config({ outputCooldownSeconds: 1 });
    const matcher = new OutputMatcher(() => settings, data => events.push(data), () => now);
    const bytes = Buffer.from('\x1b[31m任务\x1b[0m完成\x1b]0;error hidden title\x07');
    for (const byte of bytes) matcher.feed(Buffer.from([byte]));
    assert.equal(events.length, 1); assert.equal(events[0].pattern, '任务完成'); assert.equal(events[0].output, undefined);
    now += 2000; matcher.feed(' more text'); assert.equal(events.length, 1, 'old text is not re-notified');
    matcher.feed('\nERROR\nerror\n'); assert.equal(events.length, 2);
    now += 2000; matcher.feed('error'); assert.equal(events.length, 3);
    matcher.feed('\r\x1b[2Kerr'); now += 2000; matcher.feed('\x1b[H'); matcher.feed('or');
    assert.equal(events.length, 3, 'cursor movement cannot combine unrelated old/new text');
    matcher.feed('\nerr\tor'); assert.equal(events.length, 3, 'tab-separated columns are not a contiguous keyword');
    matcher.close(); matcher.feed('\nerror'); assert.equal(events.length, 3);
});
test('output sources and tabs do not combine chunks or share cooldown, config updates discard old fragments', () => {
    let settings = config(), events = [];
    const first = new OutputMatcher(() => settings, data => events.push(['first', data]));
    const second = new OutputMatcher(() => settings, data => events.push(['second', data]));
    first.feed('err'); second.feed('or'); assert.equal(events.length, 0);
    first.feed('or'); second.feed('\nerror'); assert.equal(events.length, 2);
    settings = config(); first.feed('append'); assert.equal(events.length, 2, 'reading equivalent settings does not reset deduplication');
    first.feed('\n任'); settings = config({ outputIgnoreCase: false }); first.feed('务完成'); assert.equal(events.length, 2);
    first.feed('\nERROR'); assert.equal(events.length, 2); first.feed('\nerror'); assert.equal(events.length, 3);
    settings = config({ enabled: false }); first.feed('\n任务完成'); assert.equal(events.length, 3);
});
test('matching bounds memory on long output and redacts snippets only when opted in', () => {
    const settings = config({ includeOutput: true }), events = [];
    const matcher = new OutputMatcher(() => settings, data => events.push(data));
    matcher.feed('x'.repeat(100000) + '\npassword=hunter2 error token=hello');
    assert.ok(matcher.text.length < 4096); assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(buildWebhookPayload('output_matched', events[0], settings)), /hunter2|hello/);
    assert.equal(buildWebhookPayload('output_matched', events[0], {}).output, undefined);
    assert.match(validateOutputRules({ outputRules: ['x'.repeat(201)] }), /200/);
    assert.match(validateOutputRules({ enabled: true, events: ['output_matched'], outputRules: [] }), /关键词/);
});
test('program termination emits once with accurate success, failure, signal and unknown status', () => {
    for (const [details, status] of [[{ exitCode: 0 }, 'completed'], [{ exitCode: 7 }, 'failed'], [{ signal: 'SIGKILL' }, 'failed'], [{ reason: 'cancelled' }, 'cancelled'], [{ reason: 'connection_lost' }, 'unknown'], [{}, 'unknown']]) {
        const events = [], settings = config();
        const observer = createProgramObserver({ config: () => settings, emit: (event, payload) => events.push({ event, payload }), target: 'local', source: 'test', command: 'fixture' });
        observer.stop(details); observer.stop({ exitCode: 0 }); observer.output('error');
        assert.equal(events.length, 1); assert.equal(events[0].payload.status, status); assert.equal(events[0].event, 'program_stopped');
    }
    const events = [], remote = createProgramObserver({ config, emit: (_, data) => events.push(data), target: 'remote' });
    remote.stop({ reason: 'cancelled' }); assert.equal(events[0].status, 'unknown');
});
test('markers accept only their own real control sequences and tolerate large/split terminal chunks', () => {
    const id = crypto.randomUUID(), values = [], parser = new ProgramMarkers(id, { stop: value => values.push(value) });
    parser.feed(monitoredCommand('exit 0', id)); assert.equal(values.length, 0, 'echoed wrapper is not completion');
    parser.feed(`\x1b]777;aiterm;wrong;start\x07\x1b]777;aiterm;wrong;end;0\x07`);
    parser.feed(`\x1b]777;aiterm;${id};start\x07${'x'.repeat(40000)}`);
    for (const char of `\x1b]777;aiterm;${id};end;137\x07`) parser.feed(char);
    assert.deepEqual(values, [{ exitCode: 137 }]); parser.close(); assert.equal(values.length, 1);
});
test('real monitored child commands report normal exit, explicit exit, missing command and SIGKILL', { skip: process.platform === 'win32' }, async () => {
    for (const [command, expected] of [["printf '%s' 'literal $(echo no)'; exit 0", 0], ['exit 7', 7], ['aiterminal_nonexistent_fixture_command', 127], ['kill -KILL $$', 137]]) {
        const id = crypto.randomUUID(), exits = [], parser = new ProgramMarkers(id, { stop: data => exits.push(data) });
        const child = spawn('/bin/sh', ['-c', monitoredCommand(command, id)]);
        child.stdout.on('data', data => parser.feed(data)); child.stderr.resume();
        const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
        assert.equal(code, expected); assert.deepEqual(exits, [{ exitCode: expected }]);
    }
});
test('real plugin command lifecycle reaches notifications for success/failure and cancellation', { skip: process.platform === 'win32' }, async () => {
    const events = [], settings = config();
    const binding = { target: 'local', shell: 'posix', valid: () => true };
    const service = createPluginServices({ capture: () => binding, approve: async () => true,
        observe: (_owner, current, command) => createProgramObserver({ config: () => settings, emit: (event, data) => events.push({ event, ...data }), target: current.target, command }) });
    const task = () => { const controller = new AbortController(); return { controller, binding, signal: controller.signal, valid: () => !controller.signal.aborted, disposables: new Set() }; };
    await service({}, 'terminal.exec', { command: 'printf error; exit 7' }, task());
    assert.equal(events.filter(e => e.event === 'output_matched').length, 1);
    assert.equal(events.find(e => e.event === 'program_stopped').exitCode, 7);
    const current = task(), running = service({}, 'terminal.exec', { command: 'sleep 30' }, current);
    const check = assert.rejects(running, /取消/); setTimeout(() => current.controller.abort(), 50); await check;
    assert.equal(events.filter(e => e.event === 'program_stopped').length, 2); assert.equal(events.at(-1).status, 'cancelled');
});
test('SSH program close reports explicit exit status or unknown transport loss once, including interactive streams', async () => {
    for (const [interactive, code, signal, expected] of [[false, 0, null, 'completed'], [false, undefined, 'SIGTERM', 'failed'], [true, undefined, undefined, 'unknown']]) {
        const events = [], settings = config(), controller = new AbortController();
        const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.close = () => {}; stream.signal = () => {};
        const binding = { target: 'remote', shell: 'posix', valid: () => true, connection: { exec(_command, _options, callback) {
            callback(null, stream); setImmediate(() => { stream.emit('data', Buffer.from('error')); stream.emit('close', code, signal); stream.emit('close', code, signal); });
        } } };
        const service = createPluginServices({ capture: () => binding, approve: async () => true,
            observe: () => createProgramObserver({ config: () => settings, emit: (event, data) => events.push({ event, ...data }), target: 'remote' }) });
        const task = { binding, signal: controller.signal, valid: () => true, disposables: new Set() };
        await service({}, interactive ? 'terminal.open' : 'terminal.exec', { command: 'fixture-command' }, task);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(events.filter(e => e.event === 'program_stopped').length, 1); assert.equal(events.at(-1).status, expected);
        for (const dispose of task.disposables) dispose();
        assert.equal(events.filter(e => e.event === 'program_stopped').length, 1);
    }
});
