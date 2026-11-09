'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
    const source = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
    const tabs = new Map([['first', {}], ['second', {}]]), calls = [], output = [];
    const context = vm.createContext({ activeTabId: 'first', terminalTabs: tabs, commandInput: { value: '' },
        showTerminal() {}, showHelpGuide() {}, canSendToSsh: () => false,
        ownsTerminalTab: (id, owner) => tabs.get(id) === owner && !!owner,
        writeToTerminalTab: (id, text) => output.push({ id, text }),
        handleAiChat: () => { throw new Error('Shell commands must not be sent to a model'); },
        window: { electronAPI: {
            terminalExecuteAudited: async (command, id) => { calls.push({ command, id }); return { success: true }; },
            getPathForFile: file => file.diskPath || ''
        } }
    });
    const start = source.indexOf('function getDroppedFilePaths(');
    const end = source.indexOf('async function handleAiChat(', start);
    vm.runInContext(source.slice(start, end), context);
    return { tabs, calls, output, context, run: input => { context.commandInput.value = input; return context.executeSpecialCommand(); } };
}

test('send and common-command payloads preserve shell syntax and reach the audited terminal without AI', async () => {
    const f = fixture();
    const command = 'printf "%s\\n" "two  words" | cat > "/tmp/file with spaces"';
    await f.run('send ' + command);
    assert.deepEqual(f.calls, [{ command, id: 'first' }]);
    await f.run('send'); assert.equal(f.calls.length, 1); assert.match(f.output.at(-1).text, /用法/);
});

test('pending send results remain on their owner tab and cannot write to a replacement tab', async () => {
    for (const close of [false, true]) {
        const f = fixture(); let finish;
        f.context.window.electronAPI.terminalExecuteAudited = () => new Promise(resolve => { finish = resolve; });
        const pending = f.run('send rm -rf /test-placeholder');
        f.context.activeTabId = 'second';
        if (close) f.tabs.set('first', {});
        finish({ success: false, cancelled: true, error: 'denied' }); await pending;
        assert.equal(f.output.length, close ? 0 : 1);
        if (!close) { assert.equal(f.output[0].id, 'first'); assert.match(f.output[0].text, /denied/); }
    }
});

test('dropped files resolve through the preload bridge, including files without the removed File.path', () => {
    const f = fixture();
    assert.deepEqual(Array.from(f.context.getDroppedFilePaths([{ diskPath: '/tmp/a b.txt' }], 'first')), ['/tmp/a b.txt']);
    assert.equal(f.context.getDroppedFilePaths([{}], 'first').length, 0);
    assert.match(f.output.at(-1).text, /文件管理器/);
});
