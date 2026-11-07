'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareNativeDependencies } = require('../scripts/prepareNativeDependencies');

test('macOS node-pty spawn helpers are made executable', { skip: process.platform === 'win32' }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiterminal-node-pty-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const helper = path.join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, 'helper');
    fs.chmodSync(helper, 0o644);

    const prepared = prepareNativeDependencies(root, 'darwin');

    assert.deepEqual(prepared, [helper]);
    assert.notEqual(fs.statSync(helper).mode & 0o111, 0);
});

test('native dependency preparation is a no-op outside macOS', () => {
    assert.deepEqual(prepareNativeDependencies('/missing', 'linux'), []);
});
