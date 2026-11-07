'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const start = source.indexOf('function scheduleAutoConnectSSH(');
    const end = source.indexOf('async function autoConnectSSH(', start);
    const tabs = new Map([['tab-1', {}], ['tab-2', {}]]), timers = [], connects = [];
    const context = vm.createContext({ terminalTabs: tabs, activeTabId: 'tab-1', setTimeout: fn => timers.push(fn),
        ownsTerminalTab: (id, owner) => !!owner && tabs.get(id) === owner && !owner.isClosing,
        autoConnectSSH: (config, id) => connects.push({ host: config.host, id })
    });
    const schedule = vm.runInContext(source.slice(start, end) + '\nscheduleAutoConnectSSH;', context);
    return { schedule, context, tabs, timers, connects };
}
test('delayed auto-login stays on its original tab and configuration after a tab switch', () => {
    const f = fixture(), config = { host: 'original.example' };
    f.schedule(config, 'tab-1'); f.context.activeTabId = 'tab-2'; config.host = 'changed.example';
    f.timers[0]();
    assert.deepEqual(f.connects, [{ host: 'original.example', id: 'tab-1' }]);
});
test('late auto-login cannot revive a closed/replaced tab or replace a manually started connection', () => {
    for (const change of [f => f.tabs.delete('tab-1'), f => f.tabs.set('tab-1', {}), f => { f.tabs.get('tab-1').sshConnecting = true; }, f => { f.tabs.get('tab-1').isConnected = true; }]) {
        const f = fixture(); f.schedule({ host: 'example' }, 'tab-1'); change(f); f.timers[0]();
        assert.equal(f.connects.length, 0);
    }
});
