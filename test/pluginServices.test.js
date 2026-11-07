'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createPluginServices } = require('../lib/pluginServices');
function fixture(overrides = {}) {
    const controller = new AbortController();
    const binding = { target: 'local', shell: 'posix', cwd: process.cwd(), valid: () => true, ...overrides.binding };
    const audits = [];
    const service = createPluginServices({ capture: () => binding, approve: async (_o, command, audit) => { audits.push({ command, audit }); return !audit.requiresConfirmation; }, ...overrides });
    const task = { binding, signal: controller.signal, valid: () => !controller.signal.aborted, disposables: new Set() };
    return { service, task, controller, audits };
}
test('argv auditing recognizes quoted destructive commands before dispatch', async () => {
    const { service, task, audits } = fixture();
    await assert.rejects(service({}, 'terminal.exec', { argv: ['/bin/rm', '-rf', '/not-executed'] }, task), /取消/);
    assert.equal(audits[0].audit.requiresConfirmation, true);
    assert.match(audits[0].command, /'\/bin\/rm'/);
});
test('real local commands preserve Unicode and literal argument text', { skip: process.platform === 'win32' }, async () => {
    const { service, task } = fixture();
    const text = '中文 $(echo must-not-run) ; "quoted"';
    const result = await service({}, 'terminal.exec', { argv: ['printf', '%s', text] }, task);
    assert.equal(result.output, text); assert.equal(result.exitCode, 0);
});
test('cancelling a running process rejects promptly and stops its owned process group', { skip: process.platform === 'win32' }, async () => {
    const { service, task, controller } = fixture();
    const promise = service({}, 'terminal.exec', { argv: ['sleep', '30'] }, task);
    const check = assert.rejects(promise, /取消/); setTimeout(() => controller.abort(), 40); await check;
});
test('late SSH channel after cancellation is closed without receiving input', async () => {
    let complete, closed = false;
    const connection = { exec: (_c, _o, callback) => { complete = callback; } };
    const { service, task, controller } = fixture({ binding: { target: 'remote', connection } });
    const promise = service({}, 'terminal.open', { argv: ['cat'] }, task);
    const check = assert.rejects(promise, /取消/);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.close = () => { closed = true; };
    complete(null, stream); await check; assert.equal(closed, true);
});
test('confirmation cannot dispatch after target replacement', async () => {
    let valid = true;
    const { service, task } = fixture({ binding: { valid: () => valid }, approve: async () => { valid = false; return true; } });
    await assert.rejects(service({}, 'terminal.exec', { command: 'echo should-not-run' }, task), /变化/);
});
